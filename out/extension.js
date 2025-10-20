"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
// Entry point for the Nix Upstream Check extension
const vscode = __importStar(require("vscode"));
function activate(context) {
    // Create output channel for diagnostics
    const outputChannel = vscode.window.createOutputChannel('Nix Upstream Check Diagnostics');
    context.subscriptions.push(outputChannel);
    // Register the command for the context menu
    // Move methodRegex to outer scope
    // Updated regex to handle:
    // - Class methods with modifiers: public async Task Method()
    // - Interface methods with no modifiers: Task Method()
    // - Complex generic types: Task<List<Type.NestedType>>
    // Pattern 1: Has at least one keyword (class methods)
    const methodRegexWithKeywords = /(?:public|private|protected|internal|static|virtual|override|async|sealed|extern|unsafe|new|partial)\s+(?:public|private|protected|internal|static|virtual|override|async|sealed|extern|unsafe|new|partial|\s)*([\w<>\[\],\s.]+)\s+(\w+)\s*\(/;
    // Pattern 2: No keywords but has return type pattern (interface methods)
    // Return type must contain common patterns or be a known type (Task, void, int, string, bool, IEnumerable, etc.)
    // Updated to handle Task, Task<T>, ValueTask, ValueTask<T>, and other common types with or without generics
    const methodRegexNoKeywords = /^\s*(Task|ValueTask|void|int|long|string|bool|double|float|decimal|byte|char|short|object|IEnumerable|ICollection|IList|IAsyncEnumerable|List|Dictionary|[\w.]+)(<[^>]+>)?\s+(\w+)\s*\(/;
    // Helper function to check if a line is a method definition
    const isMethodDefinition = (line) => {
        const trimmed = line.trim();
        // Must NOT be a catch/using/if/for/while/switch/throw statement
        if (trimmed.startsWith('catch ') ||
            trimmed.startsWith('using ') ||
            trimmed.startsWith('if ') ||
            trimmed.startsWith('for ') ||
            trimmed.startsWith('foreach ') ||
            trimmed.startsWith('while ') ||
            trimmed.startsWith('switch ') ||
            trimmed.startsWith('throw ') ||
            trimmed.startsWith('return ')) {
            return false;
        }
        // Must match at least one of the patterns
        return methodRegexWithKeywords.test(line) || methodRegexNoKeywords.test(line);
    };
    // Combined method regex for extracting method name
    const getMethodMatch = (line) => {
        let match = line.match(methodRegexWithKeywords);
        if (match)
            return match;
        match = line.match(methodRegexNoKeywords);
        if (match) {
            // Adjust match array to have consistent indices
            // methodRegexNoKeywords has: [full, returnTypeBase, optionalGeneric, methodName]
            // We want: [full, returnType, methodName]
            const returnType = match[1] + (match[2] || ''); // Combine base type with optional generic
            return [match[0], returnType, match[3]];
        }
        return null;
    };
    let disposable = vscode.commands.registerCommand('nixUpstreamCheck.start', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active editor');
            return;
        }
        // Build warning removed - info is in the sidebar
        const document = editor.document;
        const position = editor.selection.active;
        // Collect lines starting from the current line, until we find the opening parenthesis and closing parenthesis
        let signatureLines = [];
        let foundStart = false;
        const methodStartPattern = /(?:public|private|protected|internal|static|virtual|override|async|sealed|extern|unsafe|new|partial)|(?:Task|ValueTask|void|int|long|string|bool|IEnumerable|ICollection|IList)/;
        for (let i = position.line; i < document.lineCount && signatureLines.length < 10; i++) {
            const text = document.lineAt(i).text.trim();
            if (!foundStart && text.length === 0)
                continue;
            if (!foundStart && methodStartPattern.test(text)) {
                foundStart = true;
            }
            if (foundStart) {
                signatureLines.push(text);
                if (text.includes(')')) {
                    break;
                }
            }
        }
        // If not found, try searching upwards in case cursor is in the middle of the signature
        if (!foundStart) {
            for (let i = position.line; i >= 0 && signatureLines.length < 10; i--) {
                const text = document.lineAt(i).text.trim();
                if (methodStartPattern.test(text)) {
                    foundStart = true;
                    signatureLines.unshift(text);
                    // Continue collecting lines forward from here
                    for (let j = i + 1; j < document.lineCount && signatureLines.length < 10; j++) {
                        const forwardText = document.lineAt(j).text.trim();
                        signatureLines.push(forwardText);
                        if (forwardText.includes(')')) {
                            break;
                        }
                    }
                    break;
                }
                if (text.length > 0) {
                    signatureLines.unshift(text);
                }
            }
        }
        const signatureText = signatureLines.join(' ');
        // Validate it's a method definition
        if (!isMethodDefinition(signatureText)) {
            vscode.window.showWarningMessage('Could not detect a C# method definition at the cursor. Make sure cursor is on a method signature.');
            return;
        }
        const match = getMethodMatch(signatureText);
        let methodName = '';
        if (match) {
            methodName = match[2];
        }
        else {
            vscode.window.showWarningMessage('Could not detect a C# method definition at the cursor.');
            return;
        }
        // Search upwards for namespace declaration
        let namespaceName = '';
        for (let i = position.line; i >= 0; i--) {
            const nsMatch = document.lineAt(i).text.match(/namespace\s+([\w\.]+)/);
            if (nsMatch) {
                namespaceName = nsMatch[1];
                break;
            }
        }
        // Initialize the tree with the root method (add to existing trees, don't replace)
        const initialTree = {
            name: methodName,
            namespace: namespaceName,
            file: document.uri.fsPath,
            line: position.line,
            children: []
        };
        treeDataProvider.addCallTree(initialTree);
        // Check if C# language server is ready
        const csharpExtension = vscode.extensions.getExtension('ms-dotnettools.csharp');
        if (csharpExtension && !csharpExtension.isActive) {
            vscode.window.showWarningMessage('C# extension is not active yet. Activating...');
            await csharpExtension.activate();
        }
        // Clear and initialize output channel
        outputChannel.clear();
        outputChannel.appendLine('=== Nix Upstream Check - Starting Search ===');
        outputChannel.appendLine(`Method: ${methodName}`);
        outputChannel.appendLine(`Namespace: ${namespaceName}`);
        outputChannel.appendLine(`File: ${document.uri.fsPath}`);
        outputChannel.appendLine(`Position: line ${position.line}, char ${position.character}`);
        outputChannel.appendLine('');
        outputChannel.show(true); // Show output immediately
        // Start recursive upstream search with progress
        let apiUsedGlobal = '';
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Searching upstream references for ${methodName}`,
            cancellable: true
        }, async (progress, token) => {
            progress.report({ message: `🔍 Using C# Language Server APIs...` });
            const result = await findUpstreamReferences(methodName, namespaceName, document.uri, position, progress, token, outputChannel);
            // Replace the initial tree (last one added) with the completed result
            treeDataProvider.replaceLastTree(result.tree);
            apiUsedGlobal = result.apiUsed;
            // Auto-expand the newly added tree root
            const rootNodes = treeDataProvider.getRootNodes();
            if (rootNodes && rootNodes.length > 0) {
                const latestRoot = rootNodes[rootNodes.length - 1];
                await treeView.reveal(latestRoot, { select: false, focus: false, expand: true });
            }
            return result.tree;
        });
        if (apiUsedGlobal) {
            vscode.window.showInformationMessage(`✅ Upstream search complete for ${methodName} (using ${apiUsedGlobal})`);
        }
        else {
            vscode.window.showInformationMessage(`✅ Upstream search complete for ${methodName}`);
        }
    });
    context.subscriptions.push(disposable);
    // Manual fallback reference search when language server hasn't indexed yet
    async function manualReferenceSearch(methodName, documentUri, position) {
        const files = await vscode.workspace.findFiles('**/*.cs', '**/obj/**');
        const references = [];
        const callRegex = new RegExp(`\\b${methodName}\\s*\\(`);
        for (const file of files) {
            const doc = await vscode.workspace.openTextDocument(file);
            for (let i = 0; i < doc.lineCount; i++) {
                const text = doc.lineAt(i).text;
                if (callRegex.test(text)) {
                    // Skip the definition itself
                    if (file.fsPath === documentUri.fsPath && i === position.line) {
                        continue;
                    }
                    const lineText = doc.lineAt(i).text;
                    const matchIndex = lineText.search(callRegex);
                    if (matchIndex >= 0) {
                        const pos = new vscode.Position(i, matchIndex);
                        references.push(new vscode.Location(file, pos));
                    }
                }
            }
        }
        return references;
    }
    async function findUpstreamReferences(methodName, namespaceName, documentUri, position, progress, token, outputChannel, visited = new Set(), depth = 0, forceFileScan = false) {
        const emptyTree = { name: methodName, namespace: namespaceName, file: documentUri.fsPath, line: position.line, children: [] };
        // Check for cancellation
        if (token?.isCancellationRequested) {
            return { tree: emptyTree, apiUsed: '' };
        }
        // Avoid cycles
        const methodKey = `${namespaceName}.${methodName}`;
        if (visited.has(methodKey)) {
            return { tree: emptyTree, apiUsed: '' };
        }
        visited.add(methodKey);
        // Report progress
        if (progress && depth === 0) {
            progress.report({ message: `🔍 Querying language server APIs for ${methodName}...` });
        }
        else if (progress) {
            progress.report({ message: `Analyzing ${methodName} (depth ${depth})...` });
        }
        // Try multiple APIs in priority order
        let references;
        let apiUsed = '';
        // Log to output channel
        if (outputChannel) {
            outputChannel.appendLine(`\n--- Attempting API calls at depth ${depth} for ${methodName} ---`);
            outputChannel.appendLine(`  File: ${documentUri.fsPath}`);
            outputChannel.appendLine(`  Position: line ${position.line}, char ${position.character} (method name should be at this position)`);
        }
        // Strategy 1: Try Call Hierarchy API (best for finding callers)
        try {
            if (progress && depth === 0) {
                progress.report({ message: `Trying Call Hierarchy API...` });
            }
            if (outputChannel) {
                outputChannel.appendLine('Strategy 1: Call Hierarchy API');
            }
            const callHierarchy = await vscode.commands.executeCommand('vscode.prepareCallHierarchy', documentUri, position);
            if (outputChannel) {
                outputChannel.appendLine(`  prepareCallHierarchy: ${callHierarchy ? `returned ${callHierarchy.length} items` : 'null/undefined'}`);
            }
            if (callHierarchy && callHierarchy.length > 0) {
                if (outputChannel) {
                    outputChannel.appendLine(`  Item 0: ${JSON.stringify({ name: callHierarchy[0].name, kind: callHierarchy[0].kind, uri: callHierarchy[0].uri?.fsPath })}`);
                }
                const incomingCalls = await vscode.commands.executeCommand('vscode.provideIncomingCalls', callHierarchy[0]);
                if (outputChannel) {
                    outputChannel.appendLine(`  provideIncomingCalls: ${incomingCalls ? `returned ${incomingCalls.length} calls` : 'null/undefined'}`);
                }
                if (incomingCalls && incomingCalls.length > 0) {
                    references = incomingCalls.map((call) => {
                        // Each incoming call has 'from' (the caller) and 'fromRanges' (call sites)
                        const fromRange = call.fromRanges && call.fromRanges.length > 0
                            ? call.fromRanges[0]
                            : call.from.range;
                        return new vscode.Location(call.from.uri, fromRange);
                    });
                    apiUsed = 'Call Hierarchy';
                    if (progress && depth === 0) {
                        progress.report({ message: `✅ Call Hierarchy API found ${references.length} callers` });
                    }
                    if (outputChannel) {
                        outputChannel.appendLine(`  ✅ SUCCESS: Found ${references.length} callers`);
                    }
                }
            }
        }
        catch (error) {
            // Call Hierarchy not supported or failed
            if (outputChannel) {
                outputChannel.appendLine(`  ❌ ERROR: ${error}`);
            }
            if (progress && depth === 0) {
                progress.report({ message: `Call Hierarchy API error: ${error}` });
            }
        }
        // Strategy 2: Try CodeLens provider (this is what shows reference counts)
        if (!references || references.length === 0) {
            try {
                if (progress && depth === 0) {
                    progress.report({ message: `Trying CodeLens API...` });
                }
                if (outputChannel) {
                    outputChannel.appendLine('Strategy 2: CodeLens API');
                }
                const codeLenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', documentUri);
                if (outputChannel) {
                    outputChannel.appendLine(`  executeCodeLensProvider: ${codeLenses ? `returned ${codeLenses.length} lenses` : 'null/undefined'}`);
                }
                if (codeLenses && codeLenses.length > 0) {
                    // Find CodeLens near our position (within a few lines)
                    const relevantLens = codeLenses.find(lens => Math.abs(lens.range.start.line - position.line) <= 3);
                    if (outputChannel) {
                        outputChannel.appendLine(`  Relevant lens near line ${position.line}: ${relevantLens ? `found at line ${relevantLens.range.start.line}` : 'none found'}`);
                    }
                    if (relevantLens && relevantLens.command) {
                        if (outputChannel) {
                            outputChannel.appendLine(`  CodeLens command: ${relevantLens.command.command}, args: ${relevantLens.command.arguments?.length || 0}`);
                            if (relevantLens.command.arguments && relevantLens.command.arguments.length > 0) {
                                outputChannel.appendLine(`  Command args[0] type: ${typeof relevantLens.command.arguments[0]}`);
                            }
                        }
                        // CodeLens command often contains reference locations
                        if (relevantLens.command.command === 'editor.action.showReferences' &&
                            relevantLens.command.arguments &&
                            relevantLens.command.arguments.length >= 3) {
                            references = relevantLens.command.arguments[2];
                            apiUsed = 'CodeLens';
                            if (progress && depth === 0) {
                                progress.report({ message: `✅ CodeLens API found ${references.length} references` });
                            }
                            if (outputChannel) {
                                outputChannel.appendLine(`  ✅ SUCCESS: Found ${references.length} references`);
                            }
                        }
                        else {
                            if (outputChannel) {
                                outputChannel.appendLine(`  CodeLens command is not 'editor.action.showReferences', skipping`);
                            }
                        }
                    }
                }
            }
            catch (error) {
                // CodeLens not supported or failed
                if (outputChannel) {
                    outputChannel.appendLine(`  ❌ ERROR: ${error}`);
                }
                if (progress && depth === 0) {
                    progress.report({ message: `CodeLens API error: ${error}` });
                }
            }
        }
        // Strategy 3: Try standard Reference Provider
        if (!references || references.length === 0) {
            try {
                if (progress && depth === 0) {
                    progress.report({ message: `Trying Reference Provider API...` });
                }
                if (outputChannel) {
                    outputChannel.appendLine('Strategy 3: Reference Provider API');
                }
                references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', documentUri, position);
                if (outputChannel) {
                    outputChannel.appendLine(`  executeReferenceProvider: ${references ? `returned ${references.length} references` : 'null/undefined'}`);
                }
                if (references && references.length > 0) {
                    apiUsed = 'Reference Provider';
                    if (progress && depth === 0) {
                        progress.report({ message: `✅ Reference Provider found ${references.length} references` });
                    }
                    if (outputChannel) {
                        outputChannel.appendLine(`  ✅ SUCCESS: Found ${references.length} references`);
                    }
                }
            }
            catch (error) {
                if (outputChannel) {
                    outputChannel.appendLine(`  ❌ ERROR: ${error}`);
                }
            }
        }
        // Log final state before fallback check
        if (outputChannel) {
            outputChannel.appendLine(`\nFinal check: references=${references ? references.length : 'null/undefined'}, apiUsed='${apiUsed}'`);
        }
        // Strategy 4: Manual file scan as last resort
        if (!references || references.length === 0) {
            // Check if file scan is enabled (either by configuration or forced)
            const config = vscode.workspace.getConfiguration('nixUpstreamCheck');
            const fileScanEnabled = forceFileScan || config.get('enableFileScanFallback', false);
            if (fileScanEnabled) {
                if (progress) {
                    progress.report({ message: `⚠️ [depth ${depth}] All language server APIs returned no results. Falling back to file scanning (slow)...` });
                }
                if (outputChannel) {
                    outputChannel.appendLine(`Strategy 4 at depth ${depth}: Manual File Scan (Fallback)`);
                    outputChannel.appendLine(`  Reason: references=${references}, length=${references?.length}`);
                    if (depth === 0 && !forceFileScan) {
                        vscode.window.showWarningMessage('⚠️ All language server APIs failed. Using slow file-scan. Check Output panel for details.', 'View Output').then(selection => {
                            if (selection === 'View Output') {
                                outputChannel.show();
                            }
                        });
                    }
                }
                references = await manualReferenceSearch(methodName, documentUri, position);
                apiUsed = 'File Scan (Fallback)';
                if (outputChannel) {
                    outputChannel.appendLine(`  File scan at depth ${depth}: found ${references.length} references`);
                }
            }
            else {
                if (outputChannel) {
                    outputChannel.appendLine(`Strategy 4: File scan disabled (enable in settings or use 'Exhaustive Search' context menu)`);
                }
                apiUsed = 'No results (file scan disabled)';
            }
        }
        else {
            if (outputChannel) {
                outputChannel.appendLine(`\n✅ Using ${apiUsed} with ${references.length} references - NO fallback needed`);
            }
            if (progress && depth === 0) {
                progress.report({ message: `✅ Using ${apiUsed} - found ${references.length} references` });
            }
        }
        if (!references || references.length === 0) {
            if (depth === 0 && progress) {
                progress.report({ message: `No references found for ${methodName}. This might be a leaf method or the language server hasn't indexed the workspace yet.` });
            }
            return { tree: emptyTree, apiUsed };
        }
        // Report progress
        if (progress) {
            progress.report({ message: `Found ${references.length} references to ${methodName}, analyzing...` });
        }
        // For each reference, find the enclosing method and recurse
        const upstreamNodes = [];
        const processedMethods = new Map(); // Changed to Map to store method info with reference locations
        for (let i = 0; i < references.length; i++) {
            if (token?.isCancellationRequested)
                break;
            const ref = references[i];
            // Skip the definition itself
            if (ref.uri.fsPath === documentUri.fsPath && ref.range.start.line === position.line) {
                continue;
            }
            const doc = await vscode.workspace.openTextDocument(ref.uri);
            let methodDef = null;
            // Find the enclosing method by searching upwards from the reference
            for (let j = ref.range.start.line; j >= 0; j--) {
                const line = doc.lineAt(j).text;
                // Use the helper to validate it's actually a method definition
                if (!isMethodDefinition(line)) {
                    continue;
                }
                const m = getMethodMatch(line);
                if (m) {
                    // Find the character position of the method name on the line
                    const methodName = m[2];
                    const methodNameIndex = line.indexOf(methodName);
                    methodDef = {
                        name: methodName,
                        namespace: '',
                        file: ref.uri.fsPath,
                        line: j,
                        character: methodNameIndex >= 0 ? methodNameIndex : 0,
                        referenceLocations: [] // Initialize the reference locations array
                    };
                    // Find namespace for this method
                    for (let k = j; k >= 0; k--) {
                        const ns = doc.lineAt(k).text.match(/namespace\s+([\w\.]+)/);
                        if (ns) {
                            methodDef.namespace = ns[1];
                            break;
                        }
                    }
                    break;
                }
            }
            if (methodDef) {
                const methodKey = `${methodDef.namespace}.${methodDef.name}@${methodDef.file}:${methodDef.line}`;
                // Store the reference location
                const refLocation = {
                    file: ref.uri.fsPath,
                    line: ref.range.start.line,
                    character: ref.range.start.character
                };
                // Check if we've already found this method
                if (processedMethods.has(methodKey)) {
                    // Add this reference location to the existing method
                    const existingMethod = processedMethods.get(methodKey);
                    existingMethod.referenceLocations.push(refLocation);
                    continue;
                }
                // First time seeing this method - add the reference location
                methodDef.referenceLocations.push(refLocation);
                processedMethods.set(methodKey, methodDef);
            }
            // Report progress per reference
            if (progress && references.length > 1) {
                const percent = Math.round(((i + 1) / references.length) * 100);
                progress.report({ message: `Processing reference ${i + 1}/${references.length} of ${methodName} (${percent}%)` });
            }
        }
        // Now process all unique methods found and recurse on them
        for (const [, methodDef] of processedMethods.entries()) {
            if (token?.isCancellationRequested)
                break;
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(methodDef.file));
            // Check for controller-level method (Http attribute)
            let isController = false;
            for (let k = Math.max(0, methodDef.line - 5); k <= methodDef.line; k++) {
                const attrLine = doc.lineAt(k).text;
                if (/\[Http(Get|Post|Put|Delete|Patch)?/.test(attrLine)) {
                    isController = true;
                    methodDef.httpAttribute = attrLine.trim();
                    break;
                }
            }
            if (isController) {
                // Stop at controller endpoints
                upstreamNodes.push({ ...methodDef, children: [] });
                // Update tree progressively
                treeDataProvider.refresh();
            }
            else {
                // Recurse further upstream
                const childNode = { ...methodDef, children: [] };
                upstreamNodes.push(childNode);
                // Update tree progressively
                treeDataProvider.refresh();
                const parentResult = await findUpstreamReferences(methodDef.name, methodDef.namespace, vscode.Uri.file(methodDef.file), new vscode.Position(methodDef.line, methodDef.character || 0), progress, token, outputChannel, visited, depth + 1, forceFileScan);
                if (parentResult && parentResult.tree.children.length > 0) {
                    childNode.children = parentResult.tree.children;
                    // Update tree again after children are found
                    treeDataProvider.refresh();
                }
            }
        }
        const finalTree = { name: methodName, namespace: namespaceName, file: documentUri.fsPath, line: position.line, children: upstreamNodes };
        return { tree: finalTree, apiUsed };
    }
    // Register the tree data provider for the sidebar
    const treeDataProvider = new NixUpstreamTreeProvider();
    const treeView = vscode.window.createTreeView('nixUpstreamCheckTree', {
        treeDataProvider,
        manageCheckboxStateManually: true // We'll handle checkbox state ourselves
    });
    context.subscriptions.push(treeView);
    // Handle checkbox state changes
    treeView.onDidChangeCheckboxState(e => {
        e.items.forEach(([item, state]) => {
            if (item.treeData) {
                const isChecked = state === vscode.TreeItemCheckboxState.Checked;
                item.checked = isChecked;
                item.treeData.checked = isChecked;
                treeDataProvider.updateCheckboxState(item, isChecked);
            }
        });
    });
    // Register command to open file location when clicking on tree nodes
    let openLocationCommand = vscode.commands.registerCommand('nixUpstreamCheck.openLocation', async (treeData) => {
        if (treeData.file && typeof treeData.line === 'number') {
            const uri = vscode.Uri.file(treeData.file);
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);
            // Use character position if available (for reference locations), otherwise default to 0
            const char = typeof treeData.character === 'number' ? treeData.character : 0;
            const position = new vscode.Position(treeData.line, char);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }
    });
    context.subscriptions.push(openLocationCommand);
    // Register command for exhaustive search on a specific tree node
    let exhaustiveSearchCommand = vscode.commands.registerCommand('nixUpstreamCheck.exhaustiveSearch', async (node) => {
        if (!node || !node.treeData) {
            vscode.window.showWarningMessage('No node selected for exhaustive search');
            return;
        }
        const treeData = node.treeData;
        const methodName = treeData.name;
        const namespaceName = treeData.namespace || '';
        const file = treeData.file;
        const line = treeData.line;
        const character = treeData.character || 0;
        if (!file || typeof line !== 'number') {
            vscode.window.showWarningMessage('Invalid node data for exhaustive search');
            return;
        }
        outputChannel.clear();
        outputChannel.appendLine(`=== Exhaustive Search (with file scan) ===`);
        outputChannel.appendLine(`Method: ${methodName}`);
        outputChannel.appendLine(`Namespace: ${namespaceName}`);
        outputChannel.appendLine(`File: ${file}`);
        outputChannel.appendLine(`Position: line ${line}, char ${character}`);
        outputChannel.appendLine('');
        outputChannel.show(true);
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Exhaustive search for ${methodName}`,
            cancellable: true
        }, async (progress, token) => {
            const result = await findUpstreamReferences(methodName, namespaceName, vscode.Uri.file(file), new vscode.Position(line, character), progress, token, outputChannel, new Set(), 0, true // Force file scan
            );
            // Update the tree node with new results
            treeData.children = result.tree.children;
            treeDataProvider.refresh();
            return result.tree;
        });
        vscode.window.showInformationMessage(`Exhaustive search complete for ${methodName}`);
    });
    context.subscriptions.push(exhaustiveSearchCommand);
    // Register command to expand all tree nodes
    let expandAllCommand = vscode.commands.registerCommand('nixUpstreamCheck.expandAll', async () => {
        const expandRecursively = async (node) => {
            await treeView.reveal(node, { select: false, focus: false, expand: true });
            const children = await treeDataProvider.getChildren(node);
            for (const child of children) {
                if (child.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
                    await expandRecursively(child);
                }
            }
        };
        const rootNodes = treeDataProvider.getRootNodes();
        for (const root of rootNodes) {
            await expandRecursively(root);
        }
    });
    context.subscriptions.push(expandAllCommand);
    // Register command to clear the tree
    let clearTreeCommand = vscode.commands.registerCommand('nixUpstreamCheck.clearTree', () => {
        treeDataProvider.clearTree();
        vscode.window.showInformationMessage('Tree cleared. Run "Nix Upstream Check" to start a new search.');
    });
    context.subscriptions.push(clearTreeCommand);
    // Register command to export tree as JSON
    let exportJsonCommand = vscode.commands.registerCommand('nixUpstreamCheck.exportJson', async () => {
        const trees = treeDataProvider.getCallTrees();
        if (trees.length === 0) {
            vscode.window.showWarningMessage('No data to export. Run "Nix Upstream Check" first.');
            return;
        }
        const exportData = {
            exportedAt: new Date().toISOString(),
            trees: trees.map((tree) => treeDataProvider.serializeTreeWithCheckboxes(tree))
        };
        const jsonContent = JSON.stringify(exportData, null, 2);
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('upstream-references.json'),
            filters: { 'JSON': ['json'] }
        });
        if (uri) {
            const bytes = new Uint8Array(jsonContent.length);
            for (let i = 0; i < jsonContent.length; i++) {
                bytes[i] = jsonContent.charCodeAt(i);
            }
            await vscode.workspace.fs.writeFile(uri, bytes);
            vscode.window.showInformationMessage(`Tree exported to ${uri.fsPath}`);
        }
    });
    context.subscriptions.push(exportJsonCommand);
    // Register command to export tree as Markdown
    let exportMarkdownCommand = vscode.commands.registerCommand('nixUpstreamCheck.exportMarkdown', async () => {
        const trees = treeDataProvider.getCallTrees();
        if (trees.length === 0) {
            vscode.window.showWarningMessage('No data to export. Run "Nix Upstream Check" first.');
            return;
        }
        let markdown = `# Upstream References Report\n\n`;
        markdown += `Generated: ${new Date().toLocaleString()}\n\n`;
        markdown += `---\n\n`;
        trees.forEach((tree, index) => {
            markdown += treeDataProvider.treeToMarkdown(tree, 0, index + 1);
            markdown += `\n---\n\n`;
        });
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('upstream-references.md'),
            filters: { 'Markdown': ['md'] }
        });
        if (uri) {
            const bytes = new Uint8Array(markdown.length);
            for (let i = 0; i < markdown.length; i++) {
                bytes[i] = markdown.charCodeAt(i);
            }
            await vscode.workspace.fs.writeFile(uri, bytes);
            vscode.window.showInformationMessage(`Tree exported to ${uri.fsPath}`);
        }
    });
    context.subscriptions.push(exportMarkdownCommand);
}
exports.activate = activate;
function deactivate() { }
exports.deactivate = deactivate;
// Placeholder tree provider
class NixUpstreamTreeProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.callTrees = [];
        this.rootNodes = [];
        this.nodeParentMap = new Map();
        this.checkedStates = new Map(); // Track checkbox states
    }
    setCallTree(tree) {
        this.callTrees = [tree];
        this.rootNodes = [];
        this._onDidChangeTreeData.fire();
    }
    addCallTree(tree) {
        this.callTrees.push(tree);
        this.rootNodes = []; // Will be rebuilt
        this._onDidChangeTreeData.fire();
    }
    replaceLastTree(tree) {
        if (this.callTrees.length > 0) {
            this.callTrees[this.callTrees.length - 1] = tree;
            this.rootNodes = []; // Will be rebuilt
            this._onDidChangeTreeData.fire();
        }
    }
    clearTree() {
        this.callTrees = [];
        this.rootNodes = [];
        this.nodeParentMap.clear();
        this.checkedStates.clear();
        this._onDidChangeTreeData.fire();
    }
    // Ensure the tree persists when switching away and back
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    // Update checkbox state for a node
    updateCheckboxState(node, checked) {
        if (node.treeData) {
            const key = this.getNodeKey(node.treeData);
            this.checkedStates.set(key, checked);
        }
    }
    // Get a unique key for a tree data node
    getNodeKey(treeData) {
        if (treeData.isReference) {
            return `ref:${treeData.file}:${treeData.line}:${treeData.character}`;
        }
        return `method:${treeData.file}:${treeData.line}:${treeData.name || ''}`;
    }
    // Get the checkbox state for a tree data node
    getCheckboxState(treeData) {
        const key = this.getNodeKey(treeData);
        return this.checkedStates.get(key) || false;
    }
    getRootNodes() {
        return this.rootNodes;
    }
    getCallTrees() {
        return this.callTrees;
    }
    // Serialize tree with checkbox states for JSON export
    serializeTreeWithCheckboxes(tree) {
        const checked = this.getCheckboxState(tree);
        const serialized = {
            name: tree.name,
            namespace: tree.namespace,
            file: tree.file,
            line: tree.line,
            character: tree.character,
            checked: checked
        };
        if (tree.httpAttribute) {
            serialized.httpAttribute = tree.httpAttribute;
        }
        // Add reference locations if present
        if (tree.referenceLocations && tree.referenceLocations.length > 0) {
            serialized.referenceLocations = tree.referenceLocations.map((ref) => ({
                file: ref.file,
                line: ref.line,
                character: ref.character,
                checked: this.getCheckboxState(ref)
            }));
        }
        // Recursively serialize children
        if (tree.children && tree.children.length > 0) {
            serialized.children = tree.children.map((child) => this.serializeTreeWithCheckboxes(child));
        }
        return serialized;
    }
    // Convert tree to Markdown format
    treeToMarkdown(tree, depth, searchNumber) {
        const indent = '  '.repeat(depth);
        const checked = this.getCheckboxState(tree);
        const checkmark = checked ? '[x]' : '[ ]';
        let md = '';
        if (depth === 0 && searchNumber) {
            md += `## Search ${searchNumber}: ${tree.name}\n\n`;
            md += `**Namespace:** ${tree.namespace || 'N/A'}\n\n`;
            md += `**Location:** [${tree.file}:${tree.line + 1}](${tree.file}#L${tree.line + 1})\n\n`;
            if (tree.httpAttribute) {
                md += `**HTTP Attribute:** ${tree.httpAttribute}\n\n`;
            }
        }
        else {
            const httpAttr = tree.httpAttribute ? ` [${tree.httpAttribute}]` : '';
            md += `${indent}- ${checkmark} **${tree.name}**${httpAttr}\n`;
            md += `${indent}  - Location: [${tree.file}:${tree.line + 1}](${tree.file}#L${tree.line + 1})\n`;
            if (tree.namespace) {
                md += `${indent}  - Namespace: ${tree.namespace}\n`;
            }
        }
        // Add reference locations
        if (tree.referenceLocations && tree.referenceLocations.length > 0) {
            md += `${indent}  - **Reference locations:**\n`;
            tree.referenceLocations.forEach((ref) => {
                const refChecked = this.getCheckboxState(ref);
                const refCheckmark = refChecked ? '[x]' : '[ ]';
                const fileName = ref.file.split(/[/\\]/).pop() || ref.file;
                md += `${indent}    - ${refCheckmark} [${fileName}:${ref.line + 1}:${ref.character + 1}](${ref.file}#L${ref.line + 1})\n`;
            });
        }
        // Add children (upstream callers)
        if (tree.children && tree.children.length > 0) {
            if (depth === 0) {
                md += `\n### Upstream Callers:\n\n`;
            }
            tree.children.forEach((child) => {
                md += this.treeToMarkdown(child, depth + 1);
            });
        }
        return md;
    }
    getTreeItem(element) {
        return element;
    }
    getParent(element) {
        return this.nodeParentMap.get(element);
    }
    getChildren(element) {
        if (this.callTrees.length === 0) {
            return Promise.resolve([
                new NixUpstreamNode('📋 How to use:', '', false, undefined, vscode.TreeItemCollapsibleState.None),
                new NixUpstreamNode('1. Build your project first (dotnet build)', '', false, undefined, vscode.TreeItemCollapsibleState.None),
                new NixUpstreamNode('2. Wait for C# extension to finish loading', '', false, undefined, vscode.TreeItemCollapsibleState.None),
                new NixUpstreamNode('3. Place cursor on a C# method', '', false, undefined, vscode.TreeItemCollapsibleState.None),
                new NixUpstreamNode('4. Right-click → "Nix Upstream Check"', '', false, undefined, vscode.TreeItemCollapsibleState.None),
                new NixUpstreamNode('', '', false, undefined, vscode.TreeItemCollapsibleState.None),
                new NixUpstreamNode('⚠️ Important: Ensure code is saved and built', '', false, undefined, vscode.TreeItemCollapsibleState.None),
                new NixUpstreamNode('for accurate reference detection!', '', false, undefined, vscode.TreeItemCollapsibleState.None)
            ]);
        }
        if (!element) {
            // Root level - show all search results
            this.rootNodes = this.callTrees.map(tree => {
                const node = this.nodeFromTree(tree, false);
                this.nodeParentMap.set(node, undefined); // Root has no parent
                return node;
            });
            return Promise.resolve(this.rootNodes);
        }
        // Children are both reference locations AND upstream callers
        if (element['treeData']) {
            const children = [];
            const treeData = element['treeData'];
            // First, add reference locations if they exist
            if (treeData.referenceLocations && treeData.referenceLocations.length > 0) {
                for (const refLoc of treeData.referenceLocations) {
                    const fileName = refLoc.file.split(/[/\\]/).pop() || refLoc.file;
                    const label = `📍 ${fileName}:${refLoc.line + 1}`;
                    // Create a tree data object for the reference location
                    const refTreeData = {
                        name: label,
                        file: refLoc.file,
                        line: refLoc.line,
                        character: refLoc.character,
                        isReference: true
                    };
                    // Use nodeFromTree to ensure command is set properly
                    const refNode = this.nodeFromTree(refTreeData, false);
                    this.nodeParentMap.set(refNode, element);
                    children.push(refNode);
                }
            }
            // Then, add upstream method callers
            if (treeData.children && treeData.children.length > 0) {
                for (const child of treeData.children) {
                    const childNode = this.nodeFromTree(child, false);
                    this.nodeParentMap.set(childNode, element);
                    children.push(childNode);
                }
            }
            return Promise.resolve(children);
        }
        return Promise.resolve([]);
    }
    nodeFromTree(tree, checked) {
        // Handle reference location nodes differently
        let label;
        let tooltip;
        let collapsibleState;
        if (tree.isReference) {
            // Reference location node
            label = tree.name; // Already formatted as "📍 filename:line"
            tooltip = `Reference at:\n${tree.file}:${tree.line + 1}:${tree.character + 1}`;
            collapsibleState = vscode.TreeItemCollapsibleState.None;
        }
        else {
            // Method node
            label = tree.name + (tree.httpAttribute ? ` [${tree.httpAttribute}]` : '');
            tooltip = tree.namespace ? `${tree.namespace}\n${tree.file ? tree.file : ''}:${tree.line !== undefined ? tree.line + 1 : ''}` : '';
            // Node is expandable if it has children OR reference locations
            const hasChildren = tree.children && tree.children.length > 0;
            const hasReferences = tree.referenceLocations && tree.referenceLocations.length > 0;
            collapsibleState = (hasChildren || hasReferences)
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None;
        }
        // Use stored checkbox state if available
        const isChecked = this.getCheckboxState(tree);
        const node = new NixUpstreamNode(label, tooltip, isChecked, tree, collapsibleState);
        // Make all nodes with file location clickable
        if (tree.file && typeof tree.line === 'number') {
            node.command = {
                command: 'nixUpstreamCheck.openLocation',
                title: tree.isReference ? 'Open Reference Location' : 'Open Location',
                arguments: [tree]
            };
        }
        return node;
    }
}
class NixUpstreamNode extends vscode.TreeItem {
    constructor(label, tooltip, checked, treeData, collapsibleState = vscode.TreeItemCollapsibleState.None) {
        super(label, collapsibleState);
        this.tooltip = tooltip;
        this.checked = checked;
        this.treeData = treeData;
        // Only set context value and checkbox for actual data nodes (not info messages)
        if (treeData) {
            this.contextValue = 'nixUpstreamNode';
            // Set checkbox state using the proper VSCode API
            this.checkboxState = checked
                ? vscode.TreeItemCheckboxState.Checked
                : vscode.TreeItemCheckboxState.Unchecked;
        }
        else {
            // Informational nodes - no context menu or checkbox
            this.contextValue = 'nixUpstreamInfo';
        }
    }
}
//# sourceMappingURL=extension.js.map