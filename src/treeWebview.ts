import * as vscode from 'vscode';

export class NixUpstreamTreeWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'nixUpstreamCheckTree';
    private _view?: vscode.WebviewView;
    private callTrees: any[] = [];
    private checkedStates: Map<string, boolean> = new Map();
    private selectedNodes: Set<string> = new Set();
    private expandedNodes: Set<string> = new Set();
    private lastComment: string = '';

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media')
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'ready':
                    this.sendInitialData();
                    break;
                case 'nodeClick':
                    await this.handleNodeClick(data.nodeId, data.modifiers);
                    break;
                case 'checkboxToggle':
                    await this.handleCheckboxToggle(data.nodeIds);
                    break;
                case 'expandCollapse':
                    await this.handleExpandCollapse(data.nodeId);
                    break;
                case 'navigate':
                    await this.navigateToLocation(data.file, data.line, data.character);
                    break;
                case 'reorder':
                    await this.handleReorder(data.nodeId, data.direction);
                    break;
                case 'selectAll':
                    await this.handleSelectAll();
                    break;
                case 'selectRange':
                    await this.handleSelectRange(data.nodeIds);
                    break;
                case 'contextMenu':
                    await this.handleContextMenu(data.nodeId, data.node);
                    break;
                case 'syncExpanded':
                    if (data.expandedNodes) {
                        this.expandedNodes = new Set(data.expandedNodes);
                    }
                    break;
            }
        });

        // Handle visibility changes
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.refresh();
            }
        });

        // Initial render - will be sent once webview sends 'ready' message
    }

    private async handleNodeClick(nodeId: string, modifiers: { ctrl: boolean, shift: boolean }) {
        // Update selection based on modifiers
        if (modifiers.ctrl) {
            // Toggle selection
            if (this.selectedNodes.has(nodeId)) {
                this.selectedNodes.delete(nodeId);
            } else {
                this.selectedNodes.add(nodeId);
            }
        } else if (modifiers.shift) {
            // Range selection - implement later
            this.selectedNodes.add(nodeId);
        } else {
            // Single selection
            this.selectedNodes.clear();
            this.selectedNodes.add(nodeId);
        }

        this.updateSelection();
    }

    private async handleCheckboxToggle(nodeIds: string[]) {
        // Toggle checkbox for all selected nodes
        if (nodeIds.length === 0) return;

        // Determine new state based on first node
        const firstNodeKey = nodeIds[0];
        const currentState = this.checkedStates.get(firstNodeKey) ?? true;
        const newState = !currentState;

        // Apply to all selected nodes
        nodeIds.forEach(nodeId => {
            this.checkedStates.set(nodeId, newState);
        });

        this.refresh();
    }

    private async handleExpandCollapse(nodeId: string) {
        // Toggle expand/collapse state
        this._view?.webview.postMessage({
            type: 'toggleExpand',
            nodeId: nodeId
        });
    }

    private async navigateToLocation(file: string, line: number, character: number) {
        const uri = vscode.Uri.file(file);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        const position = new vscode.Position(line, character);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
    }

    private async handleReorder(nodeId: string, direction: 'up' | 'down') {
        // Implement reordering logic
        // Find node, find parent, swap with sibling
        this.refresh();
    }

    private async handleSelectAll() {
        // Select all visible nodes
        this.getAllVisibleNodeIds().forEach(id => this.selectedNodes.add(id));
        this.updateSelection();
    }

    private async handleSelectRange(nodeIds: string[]) {
        // Clear and set new range selection
        this.selectedNodes.clear();
        nodeIds.forEach(id => this.selectedNodes.add(id));
        this.updateSelection();
    }

    private async handleContextMenu(nodeId: string, node: any) {
        const items: vscode.QuickPickItem[] = [];

        if (node.isComment) {
            items.push(
                { label: '$(edit) Edit Comment', description: 'Edit this comment' },
                { label: '$(trash) Delete Comment', description: 'Remove this comment' }
            );
        } else {
            items.push(
                { label: '$(comment) Add Comment Above', description: 'Add a comment above this node' },
                { label: '$(search) Search Upstream from Here', description: 'Continue search from this reference' },
                { label: '$(trash) Remove from Tree', description: 'Remove this node from the tree' }
            );

            if (!node.isReference) {
                items.push(
                    { label: '$(search-fuzzy) Exhaustive Search', description: 'Search with file scan fallback' }
                );
            }
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select action'
        });

        if (selected) {
            if (selected.label.includes('Add Comment')) {
                // Increment numeric part of last comment for default
                const defaultComment = this.getNextComment();
                vscode.window.showInformationMessage(`DEBUG: lastComment="${this.lastComment}", defaultComment="${defaultComment}"`);
                const comment = await vscode.window.showInputBox({
                    prompt: 'Enter comment text',
                    placeHolder: 'Comment...',
                    value: defaultComment
                });
                if (comment) {
                    this.lastComment = comment;
                    // If multiple nodes selected and this node is one of them, add comment to all
                    const nodesToComment = this.selectedNodes.size > 1 && this.selectedNodes.has(nodeId)
                        ? Array.from(this.selectedNodes)
                        : [nodeId];

                    vscode.window.showInformationMessage(`DEBUG: selectedNodes.size=${this.selectedNodes.size}, has nodeId=${this.selectedNodes.has(nodeId)}, nodesToComment.length=${nodesToComment.length}`);

                    let successCount = 0;
                    for (const nId of nodesToComment) {
                        if (await this.insertCommentAboveNode(nId, comment)) {
                            successCount++;
                        }
                    }

                    vscode.window.showInformationMessage(`Added comment to ${successCount} of ${nodesToComment.length} nodes`);
                }
            } else if (selected.label.includes('Edit Comment')) {
                const newText = await vscode.window.showInputBox({
                    prompt: 'Edit comment',
                    value: node.commentText || ''
                });
                if (newText !== undefined && newText.trim()) {
                    this.lastComment = newText.trim();
                    await this.editCommentNode(nodeId, newText);
                }
            } else if (selected.label.includes('Delete Comment')) {
                await this.deleteCommentNode(nodeId);
            } else if (selected.label.includes('Remove from Tree')) {
                await this.removeNode(nodeId);
            } else if (selected.label.includes('Search Upstream')) {
                if (node.file && typeof node.line === 'number') {
                    await vscode.commands.executeCommand('nixUpstreamCheck.searchUpstreamFromReference', {
                        treeData: node
                    });
                }
            } else if (selected.label.includes('Exhaustive Search')) {
                if (node.file && typeof node.line === 'number') {
                    await vscode.commands.executeCommand('nixUpstreamCheck.exhaustiveSearch', {
                        treeData: node
                    });
                }
            }
        }
    }

    private updateSelection() {
        this._view?.webview.postMessage({
            type: 'updateSelection',
            selectedIds: Array.from(this.selectedNodes)
        });
    }

    private getAllVisibleNodeIds(): string[] {
        const ids: string[] = [];
        const collectIds = (tree: any) => {
            if (!tree) return;
            const nodeKey = this.getNodeKey(tree);
            ids.push(nodeKey);
            if (tree.children) {
                tree.children.forEach((child: any) => collectIds(child));
            }
            if (tree.referenceLocations) {
                tree.referenceLocations.forEach((ref: any) => {
                    ids.push(this.getNodeKey(ref));
                });
            }
        };
        this.callTrees.forEach(tree => collectIds(tree));
        return ids;
    }

    public setCallTree(tree: any) {
        this.callTrees = [tree];
        // Ensure default expanded state for root
        const rootKey = this.getNodeKey(tree);
        if (!this.expandedNodes) {
            this.expandedNodes = new Set();
        }
        this.refresh();
    }

    public addCallTree(tree: any): boolean {
        const newKey = this.getNodeKey(tree);
        const isDuplicate = this.callTrees.some(existingTree => {
            return this.getNodeKey(existingTree) === newKey;
        });

        if (isDuplicate) {
            return false;
        }

        this.callTrees.push(tree);

        // Auto-expand all nodes in the newly added tree
        const expandTree = (node: any) => {
            const nodeKey = this.getNodeKey(node);
            const hasChildren = (node.children && node.children.length > 0) ||
                              (node.referenceLocations && node.referenceLocations.length > 0);
            if (hasChildren) {
                this.expandedNodes.add(nodeKey);
            }
            if (node.children) {
                node.children.forEach((child: any) => expandTree(child));
            }
            if (node.referenceLocations) {
                node.referenceLocations.forEach((ref: any) => expandTree(ref));
            }
        };
        expandTree(tree);

        this.refresh();
        return true;
    }

    public clearTree() {
        this.callTrees = [];
        this.checkedStates.clear();
        this.selectedNodes.clear();
        this.refresh();
    }

    public expandAll() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'expandAll'
            });
        }
    }

    public getCallTrees(): any[] {
        return this.callTrees;
    }

    public getExpandedNodes(): Set<string> {
        return this.expandedNodes;
    }

    public restoreExpandedNodes(expandedNodeIds: string[]): void {
        // Merge with existing expanded nodes instead of replacing
        expandedNodeIds.forEach(id => this.expandedNodes.add(id));
        this.refresh();
    }

    public replaceLastTree(tree: any) {
        if (this.callTrees.length > 0) {
            this.callTrees[this.callTrees.length - 1] = tree;
            this.refresh();
        }
    }

    public getRootNodes(): any[] {
        return this.callTrees;
    }

    public getChildren(node: any): Promise<any[]> {
        if (!node || !node.treeData) {
            return Promise.resolve(this.callTrees);
        }

        const children: any[] = [];
        const treeData = node.treeData;

        if (treeData.referenceLocations) {
            children.push(...treeData.referenceLocations);
        }
        if (treeData.children) {
            children.push(...treeData.children);
        }

        return Promise.resolve(children);
    }

    public pruneUncheckedItems(): number {
        let prunedCount = 0;

        const pruneNode = (node: any): any | null => {
            const nodeKey = this.getNodeKey(node);
            const isChecked = this.checkedStates.get(nodeKey) !== false;

            if (!isChecked) {
                prunedCount++;
                return null;
            }

            if (node.children) {
                node.children = node.children.map((child: any) => pruneNode(child)).filter((c: any) => c !== null);
            }
            if (node.referenceLocations) {
                node.referenceLocations = node.referenceLocations.map((ref: any) => pruneNode(ref)).filter((r: any) => r !== null);
            }

            return node;
        };

        this.callTrees = this.callTrees.map(tree => pruneNode(tree)).filter(t => t !== null);
        this.refresh();
        return prunedCount;
    }

    private getNextComment(): string {
        if (!this.lastComment) {
            return '';
        }

        // Find numeric parts and increment the last one
        const numMatch = this.lastComment.match(/\d+/g);
        if (numMatch && numMatch.length > 0) {
            const lastNum = numMatch[numMatch.length - 1];
            const incremented = (parseInt(lastNum) + 1).toString().padStart(lastNum.length, '0');
            // Replace the last occurrence of the number
            const lastIndex = this.lastComment.lastIndexOf(lastNum);
            return this.lastComment.substring(0, lastIndex) + incremented + this.lastComment.substring(lastIndex + lastNum.length);
        }

        return this.lastComment;
    }

    private async insertCommentAboveNode(nodeId: string, commentText: string): Promise<boolean> {
        const commentNode = {
            isComment: true,
            commentText: commentText,
            name: commentText
        };

        // Find and insert comment above the specified node
        const insertComment = (nodes: any[], parent: any = null): boolean => {
            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                const key = this.getNodeKey(node);

                if (key === nodeId) {
                    // Insert comment before this node
                    nodes.splice(i, 0, commentNode);
                    return true;
                }

                // Check children
                if (node.children && insertComment(node.children, node)) {
                    return true;
                }
                if (node.referenceLocations && insertComment(node.referenceLocations, node)) {
                    return true;
                }
            }
            return false;
        };

        const success = insertComment(this.callTrees);
        if (success) {
            this.refresh();
            // Don't show message here - caller will handle it
        }
        return success;
    }

    private async editCommentNode(nodeId: string, newText: string): Promise<void> {
        // Find and edit comment
        vscode.window.showInformationMessage('Comment editing will be implemented');
        // TODO: Implement proper comment editing
    }

    private async deleteCommentNode(nodeId: string): Promise<void> {
        // Find and delete comment
        vscode.window.showInformationMessage('Comment deletion will be implemented');
        // TODO: Implement proper comment deletion
    }

    private async removeNode(nodeId: string): Promise<void> {
        vscode.window.showInformationMessage(`DEBUG: Removing node with ID: ${nodeId}`);
        const beforeCount = this.callTrees.length;

        // Find and remove node from tree
        const removeFromTree = (nodes: any[]): any[] => {
            return nodes.filter(node => {
                const key = this.getNodeKey(node);
                if (key === nodeId) {
                    vscode.window.showInformationMessage(`DEBUG: Found and removing node: ${node.name || 'unnamed'}`);
                    return false; // Remove this node
                }
                // Recursively check children
                if (node.children) {
                    node.children = removeFromTree(node.children);
                }
                if (node.referenceLocations) {
                    node.referenceLocations = removeFromTree(node.referenceLocations);
                }
                return true; // Keep this node
            });
        };

        this.callTrees = removeFromTree(this.callTrees);
        const afterCount = this.callTrees.length;
        vscode.window.showInformationMessage(`DEBUG: Tree count before=${beforeCount}, after=${afterCount}`);

        this.checkedStates.delete(nodeId);
        this.selectedNodes.delete(nodeId);
        this.refresh();
        vscode.window.showInformationMessage('Node removed from tree');
    }

    public insertCommentAbove(node: any, commentText: string): boolean {
        const commentTreeData = {
            isComment: true,
            commentText: commentText,
            name: commentText
        };

        // For webview, we need to implement insertion logic
        // This is a simplified version - you may need to adapt based on your tree structure
        return false; // Placeholder
    }

    public editComment(node: any, newText: string): void {
        if (node.treeData && node.treeData.isComment) {
            node.treeData.commentText = newText;
            node.treeData.name = newText;
            this.refresh();
        }
    }

    public deleteComment(node: any): boolean {
        // Placeholder - implement deletion logic
        return false;
    }

    public serializeTreeWithCheckboxes(tree: any): any {
        const serialize = (node: any): any => {
            const nodeKey = this.getNodeKey(node);
            const result = { ...node };
            result.checked = this.checkedStates.get(nodeKey) !== false;

            if (node.children) {
                result.children = node.children.map((child: any) => serialize(child));
            }
            if (node.referenceLocations) {
                result.referenceLocations = node.referenceLocations.map((ref: any) => serialize(ref));
            }

            return result;
        };

        return serialize(tree);
    }

    public restoreCheckboxStates(tree: any): void {
        const restore = (node: any) => {
            const nodeKey = this.getNodeKey(node);
            if (node.checked !== undefined) {
                this.checkedStates.set(nodeKey, node.checked);
            }

            if (node.children) {
                node.children.forEach((child: any) => restore(child));
            }
            if (node.referenceLocations) {
                node.referenceLocations.forEach((ref: any) => restore(ref));
            }
        };

        restore(tree);
    }

    public treeToMarkdown(tree: any, indent: number, treeIndex: number): string {
        let markdown = '';
        const prefix = '  '.repeat(indent);
        const checkbox = this.checkedStates.get(this.getNodeKey(tree)) !== false ? '[x]' : '[ ]';

        if (tree.isComment) {
            markdown += `${prefix}- 👇 ${tree.commentText}\n`;
        } else if (tree.isReference) {
            markdown += `${prefix}- ${checkbox} 📍 ${tree.name}\n`;
        } else {
            markdown += `${prefix}- ${checkbox} ${tree.name}\n`;
        }

        if (tree.referenceLocations) {
            tree.referenceLocations.forEach((ref: any) => {
                markdown += this.treeToMarkdown(ref, indent + 1, treeIndex);
            });
        }
        if (tree.children) {
            tree.children.forEach((child: any) => {
                markdown += this.treeToMarkdown(child, indent + 1, treeIndex);
            });
        }

        return markdown;
    }

    public findExistingTree(file: string, line: number): any | null {
        return this.callTrees.find(tree =>
            tree.file === file && tree.line === line
        ) || null;
    }

    public findNodeByFileAndLine(file: string, line: number): any | null {
        const search = (node: any): any | null => {
            if (node.file === file && node.line === line) {
                return node;
            }
            if (node.children) {
                for (const child of node.children) {
                    const found = search(child);
                    if (found) return found;
                }
            }
            if (node.referenceLocations) {
                for (const ref of node.referenceLocations) {
                    const found = search(ref);
                    if (found) return found;
                }
            }
            return null;
        };

        for (const tree of this.callTrees) {
            const found = search(tree);
            if (found) return found;
        }
        return null;
    }

    public removeCallTree(treeData: any): boolean {
        const index = this.callTrees.findIndex(tree => tree === treeData);
        if (index >= 0) {
            this.callTrees.splice(index, 1);
            this.refresh();
            return true;
        }
        return false;
    }

    private getNodeKey(node: any): string {
        if (node.isComment) {
            return `comment_${node.commentText}_${node.file || ''}_${node.line || 0}`;
        }
        if (node.isReference) {
            return `ref_${node.file}_${node.line}_${node.character}_${node.referenceType || ''}`;
        }
        return `${node.namespace || ''}.${node.name}_${node.file || ''}_${node.line || 0}`;
    }

    public refresh() {
        if (this._view) {
            // Always try to send data if view exists
            // The webview will handle it when ready
            this._view.webview.postMessage({
                type: 'refresh',
                trees: this.callTrees,
                checkedStates: Object.fromEntries(this.checkedStates),
                expandedNodes: Array.from(this.expandedNodes)
            }).then(
                () => {}, // Success - do nothing
                (err) => {} // Error - ignore, webview might not be ready yet
            );
        }
    }

    // Call this when webview becomes visible
    private sendInitialData() {
        if (this._view) {
            this.refresh();
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'tree.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'tree.css'));

        // Use a nonce to only allow specific scripts to be run
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>Upstream Tree</title>
</head>
<body>
    <div id="tree-container"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
