(function() {
    const vscode = acquireVsCodeApi();

    let trees = [];
    let checkedStates = {};
    let expandedNodes = new Set();
    let selectedNodes = new Set();
    let lastClickedNode = null;

    console.log('Tree.js loaded, sending ready message');

    // Send ready message to extension
    vscode.postMessage({ type: 'ready' });

    // Handle messages from extension
    window.addEventListener('message', event => {
        console.log('Received message in webview:', event.data.type);
        const message = event.data;
        switch (message.type) {
            case 'refresh':
                console.log('Refreshing tree with data:', message.trees);
                console.log('Expanded nodes from extension:', message.expandedNodes);
                const wasEmpty = trees.length === 0;
                trees = message.trees || [];
                checkedStates = message.checkedStates || {};

                // Restore expanded nodes from message if provided
                if (message.expandedNodes && message.expandedNodes.length > 0) {
                    expandedNodes = new Set(message.expandedNodes);
                    console.log('Restored expanded nodes count:', expandedNodes.size);
                } else if (wasEmpty && trees.length > 0) {
                    // Auto-expand first level on initial load only if no expanded state provided
                    trees.forEach(tree => {
                        const rootKey = getNodeKey(tree);
                        expandedNodes.add(rootKey);
                    });
                    console.log('Auto-expanded first level, count:', expandedNodes.size);
                }

                console.log('Trees loaded:', trees.length);
                console.log('Final expanded nodes:', Array.from(expandedNodes));
                renderTree();
                break;
            case 'updateSelection':
                selectedNodes = new Set(message.selectedIds || []);
                updateSelectionUI();
                break;
            case 'toggleExpand':
                toggleNodeExpansion(message.nodeId);
                break;
            case 'expandAll':
                expandAllNodes();
                break;
        }
    });

    // Keyboard handler
    document.addEventListener('keydown', (e) => {
        // Check if focus is within tree container
        const treeContainer = document.getElementById('tree-container');
        const isFocused = treeContainer && treeContainer.contains(document.activeElement);

        if (e.ctrlKey && e.key === 'a') {
            e.preventDefault();
            vscode.postMessage({ type: 'selectAll' });
        } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.altKey && isFocused) {
            // Arrow keys work on selected items when tree has focus
            if (selectedNodes.size >= 1) {
                e.preventDefault();
                // Move all selected nodes
                const nodeIds = Array.from(selectedNodes);
                nodeIds.forEach(nodeId => {
                    vscode.postMessage({
                        type: 'reorder',
                        nodeId: nodeId,
                        direction: e.key === 'ArrowUp' ? 'up' : 'down'
                    });
                });
            }
        }
    });

    // Make tree container focusable and handle focus on click
    const container = document.getElementById('tree-container');
    if (container) {
        container.setAttribute('tabindex', '0');
        // Focus container when clicking anywhere in the tree
        container.addEventListener('click', (e) => {
            container.focus();
        });
    }

    function renderTree() {
        console.log('renderTree called, trees:', trees.length);
        const container = document.getElementById('tree-container');

        if (!trees || trees.length === 0) {
            console.log('No trees to render, showing empty state');
            container.innerHTML = `
                <div class="empty-state">
                    <h3>📋 How to use:</h3>
                    <ul>
                        <li>1. Build your project first (dotnet build)</li>
                        <li>2. Wait for C# extension to finish loading</li>
                        <li>3. Place cursor on a C# method</li>
                        <li>4. Right-click → "Check Upstream"</li>
                    </ul>
                    <p>⚠️ Important: Ensure code is saved and built<br>for accurate reference detection!</p>
                </div>
            `;
            return;
        }

        container.innerHTML = '';
        trees.forEach(tree => {
            const nodeEl = renderNode(tree, 0, null);
            container.appendChild(nodeEl);
        });
    }

    function renderNode(node, depth, parent) {
        // Skip nodes without meaningful data
        if (!node || (!node.name && !node.isComment && !node.isReference)) {
            const empty = document.createElement('div');
            empty.style.display = 'none';
            return empty;
        }

        const nodeKey = getNodeKey(node);
        const isExpanded = expandedNodes.has(nodeKey);
        const isChecked = checkedStates[nodeKey] !== false; // default to true
        const isSelected = selectedNodes.has(nodeKey);

        const wrapper = document.createElement('div');
        wrapper.className = 'node-wrapper';

        const nodeDiv = document.createElement('div');
        nodeDiv.className = `tree-node ${isSelected ? 'selected' : ''}`;
        nodeDiv.dataset.nodeId = nodeKey;
        nodeDiv.dataset.depth = depth;

        // Check if node has children first (needed for indent guide logic)
        const hasChildren = (node.children && node.children.length > 0) ||
                          (node.referenceLocations && node.referenceLocations.length > 0);

        // Indent guides
        const indentContainer = document.createElement('div');
        indentContainer.className = 'indent-container';
        for (let i = 0; i < depth; i++) {
            const guide = document.createElement('div');
            guide.className = `indent-guide level-${i % 11}`;
            indentContainer.appendChild(guide);
        }
        // Add black line for leaf nodes (references without children)
        if (!hasChildren && depth > 0) {
            const leafGuide = document.createElement('div');
            leafGuide.className = 'indent-guide leaf-line';
            indentContainer.appendChild(leafGuide);
        }
        nodeDiv.appendChild(indentContainer);

        // Expand/collapse icon
        const expandIcon = document.createElement('span');
        expandIcon.className = `expand-icon ${hasChildren ? (isExpanded ? 'expanded' : 'collapsed') : 'leaf'}`;
        if (hasChildren) {
            expandIcon.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleNodeExpansion(nodeKey);
            });
        }
        nodeDiv.appendChild(expandIcon);

        // Checkbox (not for comments)
        if (!node.isComment) {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'checkbox';
            checkbox.checked = isChecked;
            checkbox.addEventListener('click', (e) => {
                e.stopPropagation();
                // If multiple nodes are selected AND this node is one of them, toggle all selected
                // Otherwise, just toggle this checkbox
                const nodesToToggle = selectedNodes.size > 1 && selectedNodes.has(nodeKey)
                    ? Array.from(selectedNodes)
                    : [nodeKey];
                vscode.postMessage({
                    type: 'checkboxToggle',
                    nodeIds: nodesToToggle
                });
            });
            nodeDiv.appendChild(checkbox);
        }

        // Label
        const label = document.createElement('span');
        label.className = 'node-label';
        label.textContent = formatNodeLabel(node, depth);

        // Tooltip
        if (node.file) {
            const fileName = node.file.split(/[/\\]/).pop();
            const lineInfo = typeof node.line === 'number' ? `:${node.line + 1}` : '';
            nodeDiv.title = `${fileName}${lineInfo}\n${node.file}`;
        }

        // Click handler for selection
        nodeDiv.addEventListener('click', (e) => {
            const modifiers = {
                ctrl: e.ctrlKey || e.metaKey,
                shift: e.shiftKey
            };

            // Handle shift-click range selection locally
            if (e.shiftKey && lastClickedNode) {
                // Get all node elements
                const allNodes = Array.from(document.querySelectorAll('.tree-node'));
                const lastIndex = allNodes.findIndex(n => n.dataset.nodeId === lastClickedNode);
                const currentIndex = allNodes.findIndex(n => n.dataset.nodeId === nodeKey);

                if (lastIndex >= 0 && currentIndex >= 0) {
                    const start = Math.min(lastIndex, currentIndex);
                    const end = Math.max(lastIndex, currentIndex);
                    const rangeIds = [];
                    for (let i = start; i <= end; i++) {
                        rangeIds.push(allNodes[i].dataset.nodeId);
                    }
                    vscode.postMessage({
                        type: 'selectRange',
                        nodeIds: rangeIds
                    });
                }
            } else {
                vscode.postMessage({
                    type: 'nodeClick',
                    nodeId: nodeKey,
                    modifiers: modifiers
                });
            }

            lastClickedNode = nodeKey;

            // If has location, navigate (only on single click without modifiers)
            if (!e.ctrlKey && !e.metaKey && !e.shiftKey && node.file && typeof node.line === 'number') {
                vscode.postMessage({
                    type: 'navigate',
                    file: node.file,
                    line: node.line,
                    character: node.character || 0
                });
            }
        });

        // Context menu handler
        nodeDiv.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            vscode.postMessage({
                type: 'contextMenu',
                nodeId: nodeKey,
                node: node,
                x: e.clientX,
                y: e.clientY
            });
        });

        nodeDiv.appendChild(label);
        wrapper.appendChild(nodeDiv);

        // Children
        if (hasChildren && isExpanded) {
            const childrenDiv = document.createElement('div');
            childrenDiv.className = 'children';

            // Add reference locations first
            if (node.referenceLocations) {
                node.referenceLocations.forEach(ref => {
                    const refNode = {
                        ...ref,
                        isReference: true,
                        name: ref.name || `📍 ${(ref.file || '').split(/[/\\]/).pop()}:${(ref.line || 0) + 1}`
                    };
                    const childEl = renderNode(refNode, depth + 1, node);
                    childrenDiv.appendChild(childEl);
                });
            }

            // Then add child nodes
            if (node.children) {
                node.children.forEach(child => {
                    const childEl = renderNode(child, depth + 1, node);
                    childrenDiv.appendChild(childEl);
                });
            }

            wrapper.appendChild(childrenDiv);
        }

        return wrapper;
    }

    function formatNodeLabel(node, depth) {
        if (node.isComment) {
            return `👇 ${node.commentText || node.name || ''}`;
        }

        if (node.isReference) {
            return node.name || `📍 ${(node.file || '').split(/[/\\]/).pop()}:${(node.line || 0) + 1}`;
        }

        // Method or class node
        let label = '';

        if (node.isClass) {
            label = `c ${node.name || ''}`;
        } else {
            // Method - check for type indicators
            const typeIndicator = getTypeIndicator(node);
            label = `${typeIndicator} ${node.name || ''}`;
            if (node.httpAttribute) {
                label += ` [${node.httpAttribute}]`;
            }
        }

        return label;
    }

    function getTypeIndicator(node) {
        // Check file name for patterns
        const fileName = (node.file || '').toLowerCase();

        // Check for test first (as test files might also contain 'controller', 'service', etc.)
        if (fileName.includes('test')) return '𝐓';
        if (fileName.includes('controller')) return '𝐂';
        if (fileName.includes('service')) return '𝐒';
        if (fileName.includes('repository')) return '𝐑';
        if (fileName.includes('interface')) return '𝐈';

        return '';
    }

    function toggleNodeExpansion(nodeKey) {
        if (expandedNodes.has(nodeKey)) {
            expandedNodes.delete(nodeKey);
        } else {
            expandedNodes.add(nodeKey);
        }
        // Sync expanded state back to extension
        vscode.postMessage({
            type: 'syncExpanded',
            expandedNodes: Array.from(expandedNodes)
        });
        renderTree();
    }

    function expandAllNodes() {
        // Recursively find all nodes and add to expandedNodes
        const addAllNodes = (node) => {
            const nodeKey = getNodeKey(node);
            const hasChildren = (node.children && node.children.length > 0) ||
                              (node.referenceLocations && node.referenceLocations.length > 0);
            if (hasChildren) {
                expandedNodes.add(nodeKey);
            }

            if (node.referenceLocations) {
                node.referenceLocations.forEach(ref => addAllNodes(ref));
            }
            if (node.children) {
                node.children.forEach(child => addAllNodes(child));
            }
        };

        trees.forEach(tree => addAllNodes(tree));
        renderTree();
    }

    function updateSelectionUI() {
        document.querySelectorAll('.tree-node').forEach(el => {
            const nodeId = el.dataset.nodeId;
            if (selectedNodes.has(nodeId)) {
                el.classList.add('selected');
            } else {
                el.classList.remove('selected');
            }
        });
    }

    function getNodeKey(node) {
        if (node.isComment) {
            return `comment_${node.commentText}_${node.file || ''}_${node.line || 0}`;
        }
        if (node.isReference) {
            return `ref_${node.file}_${node.line}_${node.character}_${node.referenceType || ''}`;
        }
        return `${node.namespace || ''}.${node.name}_${node.file || ''}_${node.line || 0}`;
    }
})();
