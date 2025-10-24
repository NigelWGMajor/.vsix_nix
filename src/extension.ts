// Entry point for the Nix Upstream Check extension
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
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

    // Pattern 2a: PERMISSIVE - for cursor detection (matches any return type)
    // Simplified to match any valid type identifier ([\w.]+) with optional generics
    const methodRegexNoKeywordsPermissive = /^\s*([\w.]+)(<[\s\S]*?>)?\s+(\w+)\s*\(/;

    // Pattern 2b: RESTRICTIVE - for finding enclosing methods (known return types only)
    // Used during reference search to avoid false positives like variable declarations
    const methodRegexNoKeywordsRestrictive = /^\s*(Task|ValueTask|void|int|long|string|bool|double|float|decimal|byte|char|short|object|IEnumerable|ICollection|IList|IAsyncEnumerable|List|Dictionary|Action|Func)(<[\s\S]*?>)?\s+(\w+)\s*\(/;

    // Pattern for class detection
    // Matches: class MyClass, public class MyClass, public sealed class MyClass, etc.
    const classRegex = /\b(?:public|private|protected|internal)?\s*(?:abstract|sealed|static|partial)?\s*class\s+(\w+)/;

    // Helper function: check if line looks like code that's NOT a method definition
    const isNonMethodCode = (line: string): boolean => {
        const trimmed = line.trim();

        // Check for control flow statements and other non-method code
        if (trimmed.startsWith('catch ') ||
            trimmed.startsWith('using ') ||
            trimmed.startsWith('if ') ||
            trimmed.startsWith('for ') ||
            trimmed.startsWith('foreach ') ||
            trimmed.startsWith('while ') ||
            trimmed.startsWith('switch ') ||
            trimmed.startsWith('throw ') ||
            trimmed.startsWith('return ') ||
            trimmed.startsWith('var ') ||
            trimmed.startsWith('await ') ||
            trimmed.startsWith('new ') ||
            trimmed.includes('=>')) {    // Lambda expressions
            return true;
        }

        // Check for variable assignment (but NOT default parameter values)
        // Variable assignments have '=' but NOT inside parentheses (method parameters)
        if (trimmed.includes(' = ')) {
            // If there's an opening paren before the '=', it's likely a default parameter
            const equalIndex = trimmed.indexOf(' = ');
            const parenIndex = trimmed.indexOf('(');
            // If no opening paren, or '=' comes before '(', it's a variable assignment
            if (parenIndex === -1 || equalIndex < parenIndex) {
                return true;
            }
        }

        return false;
    };

    // Check if line is a method definition at CURSOR (permissive - any return type)
    const isMethodDefinitionAtCursor = (line: string): boolean => {
        if (isNonMethodCode(line)) return false;
        return methodRegexWithKeywords.test(line) || methodRegexNoKeywordsPermissive.test(line);
    };

    // Check if line is an ENCLOSING method during search (restrictive - known return types)
    const isEnclosingMethodDefinition = (line: string): boolean => {
        if (isNonMethodCode(line)) return false;
        return methodRegexWithKeywords.test(line) || methodRegexNoKeywordsRestrictive.test(line);
    };

    // Extract method name from cursor position (permissive)
    const getMethodMatchAtCursor = (line: string): RegExpMatchArray | null => {
        let match = line.match(methodRegexWithKeywords);
        if (match) return match;

        match = line.match(methodRegexNoKeywordsPermissive);
        if (match) {
            const returnType = match[1] + (match[2] || '');
            return [match[0], returnType, match[3]];
        }
        return null;
    };

    // Extract method name from enclosing method (restrictive)
    const getEnclosingMethodMatch = (line: string): RegExpMatchArray | null => {
        let match = line.match(methodRegexWithKeywords);
        if (match) return match;

        match = line.match(methodRegexNoKeywordsRestrictive);
        if (match) {
            const returnType = match[1] + (match[2] || '');
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

        // Open the sidebar panel
        await vscode.commands.executeCommand('nixUpstreamCheckTree.focus');

        const document = editor.document;
        const position = editor.selection.active;

        // Collect lines starting from the current line, until we find the opening parenthesis and closing parenthesis
        let signatureLines = [];
        let foundStart = false;
        // Pattern to detect start of method signature: either has a modifier keyword OR looks like "Type MethodName("
        const methodStartPattern = /(?:public|private|protected|internal|static|virtual|override|async|sealed|extern|unsafe|new|partial)|(?:[\w.<>]+\s+\w+\s*\()/;

        for (let i = position.line; i < document.lineCount && signatureLines.length < 10; i++) {
            const text = document.lineAt(i).text.trim();
            if (!foundStart && text.length === 0) continue;
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

        // Try to detect class definition first
        const classMatch = signatureText.match(classRegex);
        if (classMatch) {
            const className = classMatch[1];
            // Handle class change impact analysis
            await handleClassChangeAnalysis(className, document, position, outputChannel, context);
            return;
        }

        // Validate it's a method definition at cursor
        if (!isMethodDefinitionAtCursor(signatureText)) {
            vscode.window.showWarningMessage('Could not detect a C# method or class definition at the cursor. Make sure cursor is on a method signature or class definition.');
            return;
        }

        const match = getMethodMatchAtCursor(signatureText);
        let methodName = '';
        if (match) {
            methodName = match[2];
        } else {
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
            title: `Searching upstream: ${methodName}`,
            cancellable: true
        }, async (progress, token) => {
            const result = await findUpstreamReferences(
                methodName,
                namespaceName,
                document.uri,
                position,
                progress,
                token,
                outputChannel
            );
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
        } else {
            vscode.window.showInformationMessage(`✅ Upstream search complete for ${methodName}`);
        }
    });
    context.subscriptions.push(disposable);

    // Manual fallback reference search when language server hasn't indexed yet
    async function manualReferenceSearch(methodName: string, documentUri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
        const files = await vscode.workspace.findFiles('**/*.cs', '**/obj/**');
        const references: vscode.Location[] = [];
        // Allow for optional generic type parameters before the opening paren
        const callRegex = new RegExp(`\\b${methodName}\\s*(<[^>]+>)?\\s*\\(`);

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

    // Handle class change impact analysis
    async function handleClassChangeAnalysis(
        className: string,
        document: vscode.TextDocument,
        position: vscode.Position,
        outputChannel: vscode.OutputChannel,
        context: vscode.ExtensionContext
    ) {
        // Open the sidebar panel
        await vscode.commands.executeCommand('nixUpstreamCheckTree.focus');

        // Search upwards for namespace
        let namespaceName = '';
        for (let i = position.line; i >= 0; i--) {
            const nsMatch = document.lineAt(i).text.match(/namespace\s+([\w\.]+)/);
            if (nsMatch) {
                namespaceName = nsMatch[1];
                break;
            }
        }

        outputChannel.clear();
        outputChannel.appendLine('=== Nix Upstream Check - Class Change Analysis ===');
        outputChannel.appendLine(`Class: ${className}`);
        outputChannel.appendLine(`Namespace: ${namespaceName}`);
        outputChannel.appendLine(`File: ${document.uri.fsPath}`);
        outputChannel.appendLine(`Position: line ${position.line}`);
        outputChannel.appendLine('');
        outputChannel.show(true);

        // Use Reference Provider to find all class references
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Analyzing class: ${className}`,
            cancellable: true
        }, async (progress, token) => {
            // Find all references to the class
            const references = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider',
                document.uri,
                position
            );

            if (!references || references.length === 0) {
                vscode.window.showInformationMessage(`No references found for class ${className}`);
                return;
            }

            outputChannel.appendLine(`Found ${references.length} references to analyze`);

            // Analyze each reference to determine type (N = new, P = parameter, I = interface)
            const categorizedRefs: Array<{
                location: vscode.Location;
                type: 'N' | 'P' | 'I' | 'other';
                enclosingMethod?: string;
                enclosingMethodLocation?: { line: number; character: number; };
            }> = [];

            for (const ref of references) {
                // Skip the class definition itself
                if (ref.uri.fsPath === document.uri.fsPath && ref.range.start.line === position.line) {
                    continue;
                }

                const refDoc = await vscode.workspace.openTextDocument(ref.uri);
                const refLine = refDoc.lineAt(ref.range.start.line).text.trim();

                // Skip comments and string literals
                if (refLine.startsWith('//') || refLine.startsWith('/*') || refLine.startsWith('*')) {
                    continue;
                }

                // Skip using statements
                if (refLine.startsWith('using ') || refLine.includes('using ')) {
                    continue;
                }

                // Skip namespace declarations
                if (refLine.includes('namespace ')) {
                    continue;
                }

                // Skip inheritance declarations (: BaseClass)
                if (refLine.includes(': ' + className) || refLine.includes(',' + className)) {
                    // Only skip if it's part of class/interface definition line
                    if (refLine.includes('class ') || refLine.includes('interface ') || refLine.includes('struct ')) {
                        continue;
                    }
                }

                // Check if it's a 'new' instantiation
                const newPattern = new RegExp(`new\\s+${className}\\s*\\(`);
                if (newPattern.test(refLine)) {
                    // Find the enclosing method
                    const enclosingInfo = findEnclosingMethod(refDoc, ref.range.start.line);
                    if (enclosingInfo) { // Only add if we found an enclosing method
                        categorizedRefs.push({
                            location: ref,
                            type: 'N',
                            enclosingMethod: enclosingInfo.name,
                            enclosingMethodLocation: enclosingInfo.location
                        });
                    }
                    continue;
                }

                // Check if it's in an interface signature
                const isInterfaceSignature = isClassUsedInInterfaceSignature(refDoc, ref.range.start.line, className);
                if (isInterfaceSignature) {
                    const enclosingInfo = findEnclosingMethod(refDoc, ref.range.start.line);
                    if (enclosingInfo) { // Only add if we found an enclosing method
                        categorizedRefs.push({
                            location: ref,
                            type: 'I',
                            enclosingMethod: enclosingInfo.name,
                            enclosingMethodLocation: enclosingInfo.location
                        });
                    }
                    continue;
                }

                // Check if it's a parameter (inside method signature before opening brace)
                const isParameter = isClassUsedAsParameter(refDoc, ref.range.start.line, className);
                if (isParameter) {
                    const enclosingInfo = findEnclosingMethod(refDoc, ref.range.start.line);
                    if (enclosingInfo) { // Only add if we found an enclosing method
                        categorizedRefs.push({
                            location: ref,
                            type: 'P',
                            enclosingMethod: enclosingInfo.name,
                            enclosingMethodLocation: enclosingInfo.location
                        });
                    }
                    continue;
                }

                // Skip other types (variable declarations, return types, etc.)
                // Don't add to categorizedRefs to reduce noise in output
            }

            const nCount = categorizedRefs.filter(r => r.type === 'N').length;
            const pCount = categorizedRefs.filter(r => r.type === 'P').length;
            const iCount = categorizedRefs.filter(r => r.type === 'I').length;

            outputChannel.appendLine(`\nCategorized references:`);
            outputChannel.appendLine(`  [N] New/Instantiation: ${nCount}`);
            outputChannel.appendLine(`  [P] Parameter: ${pCount}`);
            outputChannel.appendLine(`  [I] Interface: ${iCount}`);
            outputChannel.appendLine(`  Total relevant: ${categorizedRefs.length}`);

            if (categorizedRefs.length === 0) {
                vscode.window.showInformationMessage(`No [N]ew, [P]arameter, or [I]nterface references found for ${className}`);
                return;
            }

            progress.report({ message: `Found ${nCount} [N], ${pCount} [P], ${iCount} [I] refs` });

            // Group by enclosing method and build trees
            const methodGroups = new Map<string, typeof categorizedRefs>();
            for (const ref of categorizedRefs) {
                if (!ref.enclosingMethod || !ref.enclosingMethodLocation) continue;

                const key = `${ref.location.uri.fsPath}:${ref.enclosingMethodLocation.line}:${ref.enclosingMethod}`;
                if (!methodGroups.has(key)) {
                    methodGroups.set(key, []);
                }
                methodGroups.get(key)!.push(ref);
            }

            // Build tree structure similar to method caller tree
            const initialTree = {
                name: className,
                namespace: namespaceName,
                file: document.uri.fsPath,
                line: position.line,
                isClass: true, // Flag to indicate this is a class node
                children: [] as any[]
            };

            // For each method that references the class, add it as a child
            for (const [key, refs] of methodGroups) {
                const firstRef = refs[0];
                if (!firstRef.enclosingMethod || !firstRef.enclosingMethodLocation) continue;

                // Get namespace for the method
                const methodDoc = await vscode.workspace.openTextDocument(firstRef.location.uri);
                let methodNamespace = '';
                for (let i = firstRef.enclosingMethodLocation.line; i >= 0; i--) {
                    const nsMatch = methodDoc.lineAt(i).text.match(/namespace\s+([\w\.]+)/);
                    if (nsMatch) {
                        methodNamespace = nsMatch[1];
                        break;
                    }
                }

                const methodNode = {
                    name: firstRef.enclosingMethod,
                    namespace: methodNamespace,
                    file: firstRef.location.uri.fsPath,
                    line: firstRef.enclosingMethodLocation.line,
                    character: firstRef.enclosingMethodLocation.character,
                    children: [],
                    referenceLocations: refs.map(r => ({
                        file: r.location.uri.fsPath,
                        line: r.location.range.start.line,
                        character: r.location.range.start.character,
                        referenceType: r.type // Add type indicator (N or P)
                    }))
                };

                initialTree.children.push(methodNode);
            }

            treeDataProvider.addCallTree(initialTree);

            // Auto-expand the tree root
            const rootNodes = treeDataProvider.getRootNodes();
            if (rootNodes && rootNodes.length > 0) {
                const latestRoot = rootNodes[rootNodes.length - 1];
                await treeView.reveal(latestRoot, { select: false, focus: false, expand: true });
            }

            vscode.window.showInformationMessage(`✅ Class impact analysis complete for ${className}: ${categorizedRefs.length} relevant references found`);
        });
    }

    // Helper: Check if class is used as a parameter in a method signature
    function isClassUsedAsParameter(doc: vscode.TextDocument, lineNumber: number, className: string): boolean {
        // Look at current line and potentially previous lines to find method signature
        let signatureText = '';
        let foundMethodStart = false;

        for (let i = lineNumber; i >= Math.max(0, lineNumber - 5); i--) {
            const lineText = doc.lineAt(i).text;
            signatureText = lineText + ' ' + signatureText;

            // Check if we've found a method definition
            if (methodRegexWithKeywords.test(lineText) || methodRegexNoKeywordsRestrictive.test(lineText)) {
                foundMethodStart = true;
                break;
            }

            // If we hit an opening brace without finding a method, this isn't a parameter
            if (lineText.includes('{')) {
                return false;
            }
        }

        if (!foundMethodStart) {
            return false;
        }

        // Check if className appears between '(' and ')' in the signature
        const paramPattern = new RegExp(`\\(([^)]*\\b${className}\\b[^)]*)\\)`);
        return paramPattern.test(signatureText);
    }

    // Helper: Check if class is used in an interface method signature
    function isClassUsedInInterfaceSignature(doc: vscode.TextDocument, lineNumber: number, className: string): boolean {
        // Search backwards to find if we're inside an interface definition
        let inInterface = false;
        let interfaceStartLine = -1;

        for (let i = lineNumber; i >= Math.max(0, lineNumber - 50); i--) {
            const lineText = doc.lineAt(i).text.trim();

            // If we hit a class definition, we're not in an interface
            if (/\bclass\s+\w+/.test(lineText)) {
                return false;
            }

            // Check if we found an interface definition
            if (/\binterface\s+\w+/.test(lineText)) {
                inInterface = true;
                interfaceStartLine = i;
                break;
            }
        }

        // If not in an interface, return false
        if (!inInterface) {
            return false;
        }

        // Now check if the className appears in a method signature within the interface
        // Look at current line and potentially previous lines to find method signature
        let signatureText = '';
        let foundMethodStart = false;

        for (let i = lineNumber; i >= Math.max(interfaceStartLine, lineNumber - 5); i--) {
            const lineText = doc.lineAt(i).text;
            signatureText = lineText + ' ' + signatureText;

            // Check if we've found a method definition (interface methods don't need access modifiers)
            if (methodRegexNoKeywordsPermissive.test(lineText) || methodRegexWithKeywords.test(lineText)) {
                foundMethodStart = true;
                break;
            }

            // If we hit an opening brace or semicolon, stop looking
            if (lineText.includes('{') || lineText.includes(';')) {
                break;
            }
        }

        // If we found a method signature and className appears in it (as parameter or return type)
        if (foundMethodStart && signatureText.includes(className)) {
            return true;
        }

        return false;
    }

    // Helper: Find enclosing method for a given line
    function findEnclosingMethod(doc: vscode.TextDocument, lineNumber: number): { name: string; location: { line: number; character: number; } } | null {
        // Search upwards to find the containing method
        for (let i = lineNumber; i >= 0; i--) {
            const lineText = doc.lineAt(i).text;

            if (isEnclosingMethodDefinition(lineText)) {
                const match = getEnclosingMethodMatch(lineText);
                if (match) {
                    const methodName = match[2];
                    const character = lineText.indexOf(methodName);
                    return {
                        name: methodName,
                        location: { line: i, character }
                    };
                }
            }
        }

        return null;
    }

    // Recursive upstream reference search
    type MethodDef = { name: string; namespace: string; file: string; line: number; character?: number; httpAttribute?: string; referenceLocations?: Array<{ file: string; line: number; character: number; }> };
    type SearchResult = { tree: any; apiUsed: string };

    async function findUpstreamReferences(
        methodName: string,
        namespaceName: string,
        documentUri: vscode.Uri,
        position: vscode.Position,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken,
        outputChannel?: vscode.OutputChannel,
        visited: Set<string> = new Set(),
        depth: number = 0,
        forceFileScan: boolean = false
    ): Promise<SearchResult> {
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

        // Try multiple APIs in priority order
        let references: vscode.Location[] | undefined;
        let apiUsed = '';

        // Strategy 1: Try Call Hierarchy API (best for finding callers)
        try {

            const callHierarchy = await vscode.commands.executeCommand<any[]>(
                'vscode.prepareCallHierarchy',
                documentUri,
                position
            );

            if (callHierarchy && callHierarchy.length > 0) {
                const incomingCalls = await vscode.commands.executeCommand<any[]>(
                    'vscode.provideIncomingCalls',
                    callHierarchy[0]
                );

                if (incomingCalls && incomingCalls.length > 0) {
                    references = incomingCalls.map((call: any) => {
                        // Each incoming call has 'from' (the caller) and 'fromRanges' (call sites)
                        const fromRange = call.fromRanges && call.fromRanges.length > 0
                            ? call.fromRanges[0]
                            : call.from.range;
                        return new vscode.Location(call.from.uri, fromRange);
                    });
                    apiUsed = 'Call Hierarchy';
                }
            }
        } catch (error) {
            // Call Hierarchy not supported or failed - silently continue to next strategy
        }

        // Strategy 2: Try CodeLens provider (this is what shows reference counts)
        if (!references || references.length === 0) {
            try {

                const codeLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
                    'vscode.executeCodeLensProvider',
                    documentUri
                );

                if (codeLenses && codeLenses.length > 0) {
                    // Find CodeLens near our position (within a few lines)
                    const relevantLens = codeLenses.find(lens =>
                        Math.abs(lens.range.start.line - position.line) <= 3
                    );

                    if (relevantLens && relevantLens.command) {
                        // CodeLens command often contains reference locations
                        if (relevantLens.command.command === 'editor.action.showReferences' &&
                            relevantLens.command.arguments &&
                            relevantLens.command.arguments.length >= 3) {
                            references = relevantLens.command.arguments[2] as vscode.Location[];
                            apiUsed = 'CodeLens';
                        }
                    }
                }
            } catch (error) {
                // CodeLens not supported or failed - silently continue to next strategy
            }
        }

        // Strategy 3: Try standard Reference Provider
        if (!references || references.length === 0) {
            try {
                references = await vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeReferenceProvider',
                    documentUri,
                    position
                );

                if (references && references.length > 0) {
                    apiUsed = 'Reference Provider';
                }
            } catch (error) {
                // Reference Provider not supported or failed - silently continue
            }
        }

        // Strategy 4: Manual file scan as last resort
        if (!references || references.length === 0) {
            // Check if file scan is enabled (either by configuration or forced)
            const config = vscode.workspace.getConfiguration('nixUpstreamCheck');
            const fileScanEnabled = forceFileScan || config.get<boolean>('enableFileScanFallback', false);

            if (fileScanEnabled) {
                references = await manualReferenceSearch(methodName, documentUri, position);
                apiUsed = 'File Scan (Fallback)';
            } else {
                apiUsed = 'No results (file scan disabled)';
            }
        }

        if (!references || references.length === 0) {
            return { tree: emptyTree, apiUsed };
        }

        // For each reference, find the enclosing method and recurse
        const upstreamNodes = [];
        const processedMethods = new Map<string, MethodDef>(); // Changed to Map to store method info with reference locations

        for (let i = 0; i < references.length; i++) {
            if (token?.isCancellationRequested) break;

            const ref = references[i];

            // Skip the definition itself
            if (ref.uri.fsPath === documentUri.fsPath && ref.range.start.line === position.line) {
                continue;
            }

            const doc = await vscode.workspace.openTextDocument(ref.uri);
            const refLine = doc.lineAt(ref.range.start.line).text;

            // FILTER: Only process actual method CALLS or related method definitions, not other references
            // Check if this line contains a method call pattern: methodName(
            // Pattern matches: methodName followed by optional generic type args, then opening paren
            // This handles: Method(), Method<T>(), (await Method()), obj.Method(), etc.
            const methodCallPattern = new RegExp(`\\b${methodName}\\s*(<[^>]+>)?\\s*\\(`);
            if (!methodCallPattern.test(refLine)) {
                // Skip references that aren't method calls (e.g., variable declarations, return types, etc.)
                continue;
            }

            // Check if this is a method definition
            const isDefinitionLine = methodRegexWithKeywords.test(refLine) || methodRegexNoKeywordsPermissive.test(refLine);

            // Skip method definitions EXCEPT the one we started from (we want to see interface/implementation siblings)
            // If it's the same file and line we started from, skip it (that's our starting point)
            // Otherwise, if it's a definition, we'll process it as a sibling (interface or implementation)
            if (isDefinitionLine) {
                // Skip the exact line we're searching from
                if (ref.uri.fsPath === documentUri.fsPath && ref.range.start.line === position.line) {
                    continue;
                }
                // For other definitions, we want to show them as siblings (interface/implementation)
                // We'll process them differently below
            }

            let methodDef: MethodDef | null = null;

            // If this is a definition line (interface or implementation), parse it directly
            if (isDefinitionLine) {
                // Parse the method name from the definition itself
                let match = refLine.match(methodRegexWithKeywords);
                if (!match) {
                    match = refLine.match(methodRegexNoKeywordsPermissive);
                }

                if (match) {
                    // For methodRegexWithKeywords: method name is in match[2]
                    // For methodRegexNoKeywordsPermissive: method name is in match[3]
                    const extractedMethodName = match.length > 3 && match[3] ? match[3] : match[2];

                    // Find namespace
                    let namespace = '';
                    for (let k = ref.range.start.line; k >= 0; k--) {
                        const ns = doc.lineAt(k).text.match(/namespace\s+([\w\.]+)/);
                        if (ns) {
                            namespace = ns[1];
                            break;
                        }
                    }

                    methodDef = {
                        name: extractedMethodName,
                        namespace: namespace,
                        file: ref.uri.fsPath,
                        line: ref.range.start.line,
                        character: refLine.indexOf(extractedMethodName),
                        referenceLocations: []
                    };
                }
            } else {
                // Find the enclosing method by searching upwards from the reference
                for (let j = ref.range.start.line; j >= 0; j--) {
                    const line = doc.lineAt(j).text;

                // Check if it's a method definition (use permissive patterns for method upstream search)
                if (isNonMethodCode(line)) {
                    continue;
                }

                // Try both patterns (with keywords and without)
                let m = line.match(methodRegexWithKeywords);
                if (!m) {
                    m = line.match(methodRegexNoKeywordsPermissive);
                }

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
                    const existingMethod = processedMethods.get(methodKey)!;
                    // Don't add if the reference is the method definition itself (avoids redundant pushpin)
                    const isDefinitionItself = refLocation.file === existingMethod.file &&
                                              refLocation.line === existingMethod.line;
                    if (!isDefinitionItself) {
                        existingMethod.referenceLocations!.push(refLocation);
                    }
                    continue;
                }

                // First time seeing this method
                // Don't add the reference location if it's the definition itself (avoids redundant pushpin)
                const isDefinitionItself = refLocation.file === methodDef.file &&
                                          refLocation.line === methodDef.line;
                if (!isDefinitionItself) {
                    methodDef.referenceLocations!.push(refLocation);
                }
                processedMethods.set(methodKey, methodDef);
            }
        }

        // Report summary after processing all references
        if (progress && depth === 0) {
            const totalRefs = Array.from(processedMethods.values()).reduce((sum, m) => sum + (m.referenceLocations?.length || 0), 0);
            progress.report({ message: `Found ${totalRefs} refs in ${processedMethods.size} methods` });
        }

        // Now process all unique methods found and recurse on them
        for (const [, methodDef] of processedMethods.entries()) {
            if (token?.isCancellationRequested) break;

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
            } else {
                // Recurse further upstream
                const childNode = { ...methodDef, children: [] };
                upstreamNodes.push(childNode);

                // Update tree progressively
                treeDataProvider.refresh();

                const parentResult = await findUpstreamReferences(
                    methodDef.name,
                    methodDef.namespace,
                    vscode.Uri.file(methodDef.file),
                    new vscode.Position(methodDef.line, methodDef.character || 0),
                    progress,
                    token,
                    outputChannel,
                    visited,
                    depth + 1,
                    forceFileScan
                );

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
        manageCheckboxStateManually: true  // We'll handle checkbox state ourselves
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
    let openLocationCommand = vscode.commands.registerCommand('nixUpstreamCheck.openLocation', async (treeData: any) => {
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
    let exhaustiveSearchCommand = vscode.commands.registerCommand('nixUpstreamCheck.exhaustiveSearch', async (node: NixUpstreamNode) => {
        if (!node || !node.treeData) {
            vscode.window.showWarningMessage('No node selected for exhaustive search');
            return;
        }

        const treeData = node.treeData;
        let methodName = treeData.name;
        let namespaceName = treeData.namespace || '';
        let file = treeData.file;
        let line = treeData.line;
        let character = treeData.character || 0;

        // If this is a reference node, find the enclosing method
        if (treeData.isReference) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            const enclosingInfo = findEnclosingMethod(doc, line);

            if (!enclosingInfo) {
                vscode.window.showWarningMessage('Could not find enclosing method for this reference');
                return;
            }

            methodName = enclosingInfo.name;
            line = enclosingInfo.location.line;
            character = enclosingInfo.location.character;

            // Find namespace for the enclosing method
            for (let i = line; i >= 0; i--) {
                const ns = doc.lineAt(i).text.match(/namespace\s+([\w\.]+)/);
                if (ns) {
                    namespaceName = ns[1];
                    break;
                }
            }
        }

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
            const result = await findUpstreamReferences(
                methodName,
                namespaceName,
                vscode.Uri.file(file),
                new vscode.Position(line, character),
                progress,
                token,
                outputChannel,
                new Set(),
                0,
                true  // Force file scan
            );

            // Update the tree node with new results
            treeData.children = result.tree.children;
            treeDataProvider.refresh();

            return result.tree;
        });

        vscode.window.showInformationMessage(`Exhaustive search complete for ${methodName}`);
    });
    context.subscriptions.push(exhaustiveSearchCommand);

    // Register command to search upstream from any node location
    let searchUpstreamFromReferenceCommand = vscode.commands.registerCommand('nixUpstreamCheck.searchUpstreamFromReference', async (node: NixUpstreamNode) => {
        if (!node || !node.treeData) {
            vscode.window.showWarningMessage('No node selected');
            return;
        }

        const nodeData = node.treeData;
        const file = nodeData.file;
        const line = nodeData.line;
        const character = nodeData.character || 0;

        if (!file || typeof line !== 'number') {
            vscode.window.showWarningMessage('Invalid node location data');
            return;
        }

        // Open the document to find the enclosing method
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));

        // Find the method to search from
        let methodDef: { name: string; namespace: string; line: number; character: number; } | null = null;

        // If this is a reference node, find the enclosing method
        // If it's already a method node, use its data directly
        if (nodeData.isReference) {
            // Find the enclosing method by searching upwards
            for (let j = line; j >= 0; j--) {
                const lineText = doc.lineAt(j).text;

                // Check if it's a method definition
                if (isNonMethodCode(lineText)) {
                    continue;
                }

                // Try both patterns (with keywords and without)
                let m = lineText.match(methodRegexWithKeywords);
                if (!m) {
                    m = lineText.match(methodRegexNoKeywordsPermissive);
                }

                if (m) {
                    const methodName = m[2];
                    const methodNameIndex = lineText.indexOf(methodName);

                    // Find namespace for this method
                    let namespace = '';
                    for (let k = j; k >= 0; k--) {
                        const ns = doc.lineAt(k).text.match(/namespace\s+([\w\.]+)/);
                        if (ns) {
                            namespace = ns[1];
                            break;
                        }
                    }

                    methodDef = {
                        name: methodName,
                        namespace: namespace,
                        line: j,
                        character: methodNameIndex >= 0 ? methodNameIndex : 0
                    };
                    break;
                }
            }
        } else {
            // This is a method/class node, need to parse the actual method name from the file
            // (nodeData.name contains the formatted display name with type indicators)
            const lineText = doc.lineAt(line).text;

            // Try to extract the actual method name from the line
            let m = lineText.match(methodRegexWithKeywords);
            if (!m) {
                m = lineText.match(methodRegexNoKeywordsPermissive);
            }

            if (m) {
                const methodName = m[2];
                const methodNameIndex = lineText.indexOf(methodName);

                methodDef = {
                    name: methodName,
                    namespace: nodeData.namespace || '',
                    line: line,
                    character: methodNameIndex >= 0 ? methodNameIndex : character
                };
            } else {
                // Fallback: try to extract from nodeData.name by removing type indicators
                // Remove bold unicode characters and extra formatting
                let cleanName = nodeData.name.replace(/^[𝐌𝐂𝐒𝐎𝐈𝐍𝐏c]\s+/, '');
                // Remove HTTP attributes
                cleanName = cleanName.replace(/\s*\[Http.*?\].*$/, '');
                // Remove stats in parentheses at the end
                cleanName = cleanName.replace(/\s*\(.*\)$/, '');

                methodDef = {
                    name: cleanName.trim(),
                    namespace: nodeData.namespace || '',
                    line: line,
                    character: character
                };
            }
        }

        if (!methodDef) {
            vscode.window.showWarningMessage('Could not find method for upstream search');
            return;
        }

        // Now start the upstream search from the method
        outputChannel.clear();
        outputChannel.appendLine('=== Upstream Search from Selected Node ===');
        outputChannel.appendLine(`Source: ${file}:${line + 1}`);
        outputChannel.appendLine(`Method: ${methodDef.name}`);
        outputChannel.appendLine(`Namespace: ${methodDef.namespace}`);
        outputChannel.appendLine('');
        outputChannel.show(true);

        // Initialize the tree with the enclosing method
        const initialTree = {
            name: methodDef.name,
            namespace: methodDef.namespace,
            file: file,
            line: methodDef.line,
            children: []
        };
        treeDataProvider.addCallTree(initialTree);

        // Start recursive upstream search with progress
        // Store methodDef in a const to satisfy TypeScript's null checking in async context
        const enclosingMethod = methodDef;
        let apiUsedGlobal = '';
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Searching upstream references for ${enclosingMethod.name}`,
            cancellable: true
        }, async (progress, token) => {
            progress.report({ message: `🔍 Using C# Language Server APIs...` });
            const result = await findUpstreamReferences(
                enclosingMethod.name,
                enclosingMethod.namespace,
                vscode.Uri.file(file),
                new vscode.Position(enclosingMethod.line, enclosingMethod.character),
                progress,
                token,
                outputChannel
            );
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
            vscode.window.showInformationMessage(`✅ Upstream search complete for ${enclosingMethod.name} (using ${apiUsedGlobal})`);
        } else {
            vscode.window.showInformationMessage(`✅ Upstream search complete for ${enclosingMethod.name}`);
        }
    });
    context.subscriptions.push(searchUpstreamFromReferenceCommand);

    // Register command to expand all tree nodes
    let expandAllCommand = vscode.commands.registerCommand('nixUpstreamCheck.expandAll', async () => {
        // Helper to delay (using a proper async approach)
        const delay = (ms: number) => new Promise<void>(resolve => {
            const timer = (globalThis as any).setTimeout(() => resolve(), ms);
            return timer;
        });

        const expandRecursively = async (node: NixUpstreamNode, depth: number = 0) => {
            // Always try to reveal with expand
            try {
                await treeView.reveal(node, { select: false, focus: false, expand: true });
                // Wait a bit after revealing to let the UI update
                await delay(50);
            } catch (e) {
                // Ignore errors if node can't be revealed
            }

            // Get children after expansion
            const children = await treeDataProvider.getChildren(node);
            if (children && children.length > 0) {
                // Process children sequentially to avoid overwhelming the UI
                for (const child of children) {
                    await expandRecursively(child, depth + 1);
                }
            }
        };

        // Show progress
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Expanding tree...",
            cancellable: false
        }, async (progress) => {
            const rootNodes = treeDataProvider.getRootNodes();

            // Run twice to catch any nodes that were missed due to async timing
            for (let pass = 1; pass <= 2; pass++) {
                progress.report({
                    message: `Pass ${pass}/2...`,
                    increment: 0
                });

                for (let i = 0; i < rootNodes.length; i++) {
                    progress.report({
                        message: `Pass ${pass}/2: Expanding tree ${i + 1}/${rootNodes.length}...`,
                        increment: (50 / rootNodes.length)
                    });
                    await expandRecursively(rootNodes[i]);
                }
            }
        });
    });
    context.subscriptions.push(expandAllCommand);

    // Register command to prune unchecked items
    let pruneUncheckedCommand = vscode.commands.registerCommand('nixUpstreamCheck.pruneUnchecked', () => {
        const prunedCount = treeDataProvider.pruneUncheckedItems();
        vscode.window.showInformationMessage(`Pruned ${prunedCount} unchecked item(s) from the tree.`);
    });
    context.subscriptions.push(pruneUncheckedCommand);

    // Register command to clear the tree
    let clearTreeCommand = vscode.commands.registerCommand('nixUpstreamCheck.clearTree', () => {
        treeDataProvider.clearTree();
        vscode.window.showInformationMessage('Tree cleared. Run "Check Upstream" to start a new search.');
    });
    context.subscriptions.push(clearTreeCommand);

    // Register command to add comment above a node
    let addCommentAboveCommand = vscode.commands.registerCommand('nixUpstreamCheck.addCommentAbove', async (node: NixUpstreamNode) => {
        const comment = await vscode.window.showInputBox({
            prompt: 'Enter comment',
            placeHolder: 'Type your comment here...',
            validateInput: (value) => {
                return value.trim() ? null : 'Comment cannot be empty';
            }
        });

        if (comment) {
            const success = treeDataProvider.insertCommentAbove(node, comment.trim());
            if (!success) {
                vscode.window.showErrorMessage('Failed to add comment. Please try again.');
            }
        }
    });
    context.subscriptions.push(addCommentAboveCommand);

    // Register command to edit a comment node
    let editCommentCommand = vscode.commands.registerCommand('nixUpstreamCheck.editComment', async (node: NixUpstreamNode) => {
        const currentComment = node.treeData?.commentText || '';
        const newComment = await vscode.window.showInputBox({
            prompt: 'Edit comment',
            value: currentComment,
            validateInput: (value) => {
                return value.trim() ? null : 'Comment cannot be empty';
            }
        });

        if (newComment && newComment.trim() !== currentComment) {
            treeDataProvider.editComment(node, newComment.trim());
        }
    });
    context.subscriptions.push(editCommentCommand);

    // Register command to delete a comment node
    let deleteCommentCommand = vscode.commands.registerCommand('nixUpstreamCheck.deleteComment', async (node: NixUpstreamNode) => {
        const result = await vscode.window.showWarningMessage(
            'Delete this comment?',
            { modal: true },
            'Delete'
        );

        if (result === 'Delete') {
            const success = treeDataProvider.deleteComment(node);
            if (!success) {
                vscode.window.showErrorMessage('Failed to delete comment. Please try again.');
            }
        }
    });
    context.subscriptions.push(deleteCommentCommand);

    // Register command to export tree as JSON
    let exportJsonCommand = vscode.commands.registerCommand('nixUpstreamCheck.exportJson', async () => {
        const trees = treeDataProvider.getCallTrees();
        if (trees.length === 0) {
            vscode.window.showWarningMessage('No data to export. Run "Nix Upstream Check" first.');
            return;
        }

        const exportData = {
            exportedAt: new Date().toISOString(),
            trees: trees.map((tree: any) => treeDataProvider.serializeTreeWithCheckboxes(tree))
        };

        // Use the first tree's root member name as default filename
        const firstTree = trees[0];
        const defaultName = firstTree.name ? `${firstTree.name}.upstream.json` : 'upstream-references.upstream.json';

        const jsonContent = JSON.stringify(exportData, null, 2);
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultName),
            filters: { 'Upstream JSON': ['upstream.json'] }
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

    // Register command to export tree as Markdown (copy to clipboard)
    let exportMarkdownCommand = vscode.commands.registerCommand('nixUpstreamCheck.exportMarkdown', async () => {
        const trees = treeDataProvider.getCallTrees();
        if (trees.length === 0) {
            vscode.window.showWarningMessage('No data to export. Run "Nix Upstream Check" first.');
            return;
        }

        let markdown = `# Upstream References Report\n\n`;
        markdown += `Generated: ${new Date().toLocaleString()}\n\n`;
        markdown += `---\n\n`;

        trees.forEach((tree: any, index: number) => {
            markdown += treeDataProvider.treeToMarkdown(tree, 0, index + 1);
            markdown += `\n---\n\n`;
        });

        // Copy markdown to clipboard
        await vscode.env.clipboard.writeText(markdown);
        vscode.window.showInformationMessage('Markdown copied to clipboard!');
    });
    context.subscriptions.push(exportMarkdownCommand);

    // Register command to import/load .upstream.json files
    let importJsonCommand = vscode.commands.registerCommand('nixUpstreamCheck.importJson', async (uri?: vscode.Uri) => {
        // If URI is provided (from file explorer click), use it; otherwise show file picker
        let fileUri = uri;
        if (!fileUri) {
            // Get workspace folder as default directory
            const workspaceFolders = vscode.workspace.workspaceFolders;
            let defaultUri: vscode.Uri | undefined;

            if (workspaceFolders && workspaceFolders.length > 0) {
                defaultUri = workspaceFolders[0].uri;
            }

            const result = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { 'Upstream JSON': ['upstream.json'], 'All Files': ['*'] },
                defaultUri: defaultUri,
                openLabel: 'Import'
            });
            if (result && result.length > 0) {
                fileUri = result[0];
            }
        }

        if (!fileUri) {
            return;
        }

        try {
            // Ensure the URI has a valid scheme
            if (!fileUri.scheme || fileUri.scheme === '') {
                vscode.window.showErrorMessage('Invalid file path selected.');
                return;
            }

            const fileContent = await vscode.workspace.fs.readFile(fileUri);
            // Convert Uint8Array to string
            let jsonContent = '';
            for (let i = 0; i < fileContent.length; i++) {
                jsonContent += String.fromCharCode(fileContent[i]);
            }
            const importData = JSON.parse(jsonContent);

            if (!importData.trees || !Array.isArray(importData.trees)) {
                vscode.window.showErrorMessage('Invalid upstream JSON file format.');
                return;
            }

            // Add imported trees to existing ones (don't clear)
            importData.trees.forEach((tree: any) => {
                treeDataProvider.addCallTree(tree);
                // Restore checkbox states from the imported tree
                treeDataProvider.restoreCheckboxStates(tree);
            });

            vscode.window.showInformationMessage(`Added ${importData.trees.length} tree(s) from ${fileUri.fsPath}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to import file: ${error}`);
        }
    });
    context.subscriptions.push(importJsonCommand);

    // Automatically load .upstream.json files when opened
    const textDocumentListener = vscode.workspace.onDidOpenTextDocument(async (document) => {
        if (document.fileName.endsWith('.upstream.json')) {
            // Load the file into the tree view
            await vscode.commands.executeCommand('nixUpstreamCheck.importJson', document.uri);

            // Close the text editor and show the sidebar instead
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await vscode.commands.executeCommand('nixUpstreamCheckTree.focus');
        }
    });
    context.subscriptions.push(textDocumentListener);

    // Register command to add current line as a simple item (no upstream search)
    let addCurrentLineCommand = vscode.commands.registerCommand('nixUpstreamCheck.addCurrentLine', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor.');
            return;
        }

        const document = editor.document;
        const position = editor.selection.active;
        const line = document.lineAt(position.line);
        const lineText = line.text.trim();

        if (!lineText) {
            vscode.window.showWarningMessage('Current line is empty.');
            return;
        }

        // Try to extract method/class name from the line
        let itemName = '';
        let namespace = '';

        // Try method patterns first
        const methodMatch = lineText.match(methodRegexWithKeywords) ||
                           lineText.match(methodRegexNoKeywordsPermissive);
        if (methodMatch) {
            // Extract method name (last capture group)
            itemName = methodMatch[methodMatch.length - 1];
        } else {
            // Try class pattern
            const classMatch = lineText.match(classRegex);
            if (classMatch) {
                itemName = classMatch[1];
            } else {
                // Fallback: use first word or first identifier
                const identifierMatch = lineText.match(/\b([A-Za-z_]\w*)\b/);
                if (identifierMatch) {
                    itemName = identifierMatch[1];
                } else {
                    itemName = lineText.substring(0, 50); // Use first 50 chars
                }
            }
        }

        // Try to get namespace from document
        const fullText = document.getText();
        const namespaceMatch = fullText.match(/namespace\s+([\w.]+)/);
        if (namespaceMatch) {
            namespace = namespaceMatch[1];
        }

        // Create a simple tree item (no children, just a reference)
        const simpleItem = {
            name: itemName,
            namespace: namespace,
            file: document.uri.fsPath,
            line: position.line,
            character: position.character,
            children: [],
            referenceLocations: []
        };

        // Check if this item already exists
        const existingTree = treeDataProvider.findExistingTree(document.uri.fsPath, position.line);
        if (existingTree) {
            // Item already exists, reveal it in the tree
            const existingNode = treeDataProvider.findNodeByFileAndLine(document.uri.fsPath, position.line);
            if (existingNode) {
                treeView.reveal(existingNode, { select: true, focus: true, expand: false });
                vscode.window.showInformationMessage(`"${itemName}" is already in the tree (selected).`);
            } else {
                vscode.window.showInformationMessage(`"${itemName}" is already in the tree.`);
            }
            return;
        }

        // Add to tree
        const wasAdded = treeDataProvider.addCallTree(simpleItem);
        if (wasAdded) {
            vscode.window.showInformationMessage(`Added "${itemName}" to tree.`);
        } else {
            vscode.window.showWarningMessage(`"${itemName}" could not be added (may already exist).`);
        }
    });
    context.subscriptions.push(addCurrentLineCommand);

    // Command to remove a node from the tree
    let removeNodeCommand = vscode.commands.registerCommand('nixUpstreamCheck.removeNode', async (node: NixUpstreamNode) => {
        if (!node || !node.treeData) {
            vscode.window.showWarningMessage('No node selected.');
            return;
        }

        const itemName = node.treeData.name || 'item';

        // Confirm deletion
        const answer = await vscode.window.showWarningMessage(
            `Remove "${itemName}" from the tree?`,
            { modal: true },
            'Remove'
        );

        if (answer !== 'Remove') {
            return;
        }

        // Find and remove the tree that matches this node
        const removed = treeDataProvider.removeCallTree(node.treeData);
        if (removed) {
            vscode.window.showInformationMessage(`Removed "${itemName}" from tree.`);
        } else {
            vscode.window.showWarningMessage(`Could not remove "${itemName}".`);
        }
    });
    context.subscriptions.push(removeNodeCommand);
}

export function deactivate() {}

// Placeholder tree provider

    class NixUpstreamTreeProvider implements vscode.TreeDataProvider<NixUpstreamNode> {
        private _onDidChangeTreeData: vscode.EventEmitter<NixUpstreamNode | undefined | void> = new vscode.EventEmitter<NixUpstreamNode | undefined | void>();
        readonly onDidChangeTreeData: vscode.Event<NixUpstreamNode | undefined | void> = this._onDidChangeTreeData.event;
        private callTrees: any[] = [];
        private rootNodes: NixUpstreamNode[] = [];
        private nodeParentMap: Map<NixUpstreamNode, NixUpstreamNode | undefined> = new Map();
        private checkedStates: Map<string, boolean> = new Map(); // Track checkbox states

        setCallTree(tree: any) {
            this.callTrees = [tree];
            this.rootNodes = [];
            this._onDidChangeTreeData.fire();
        }

        addCallTree(tree: any): boolean {
            // Check for duplicates using the same key logic
            const newKey = this.getNodeKey(tree);
            const isDuplicate = this.callTrees.some(existingTree => {
                const existingKey = this.getNodeKey(existingTree);
                return existingKey === newKey;
            });

            if (isDuplicate) {
                return false; // Don't add duplicate
            }

            this.callTrees.push(tree);
            this.rootNodes = []; // Will be rebuilt
            this._onDidChangeTreeData.fire();
            return true; // Successfully added
        }

        replaceLastTree(tree: any) {
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

        // Insert a comment node above the specified node
        insertCommentAbove(node: NixUpstreamNode, commentText: string): boolean {
            // Create comment tree data
            const commentTreeData = {
                isComment: true,
                commentText: commentText,
                name: commentText
            };

            // Find parent of the node
            const parent = this.nodeParentMap.get(node);

            if (!parent) {
                // Node is at root level
                const nodeIndex = this.callTrees.findIndex(tree => tree === node.treeData);
                if (nodeIndex >= 0) {
                    this.callTrees.splice(nodeIndex, 0, commentTreeData);
                    this.rootNodes = []; // Will be rebuilt
                    this._onDidChangeTreeData.fire();
                    return true;
                }
            } else {
                // Node has a parent - insert into parent's children array
                const parentTreeData = parent.treeData;

                // Check if we need to insert into referenceLocations or children
                if (node.treeData.isReference && parentTreeData.referenceLocations) {
                    // Find the reference in parent's referenceLocations
                    const refIndex = parentTreeData.referenceLocations.findIndex((ref: any) =>
                        ref.file === node.treeData.file &&
                        ref.line === node.treeData.line &&
                        ref.character === node.treeData.character
                    );
                    if (refIndex >= 0) {
                        parentTreeData.referenceLocations.splice(refIndex, 0, commentTreeData);
                        this._onDidChangeTreeData.fire(parent);
                        return true;
                    }
                } else if (parentTreeData.children) {
                    // Find node in parent's children
                    const childIndex = parentTreeData.children.findIndex((child: any) => child === node.treeData);
                    if (childIndex >= 0) {
                        parentTreeData.children.splice(childIndex, 0, commentTreeData);
                        this._onDidChangeTreeData.fire(parent);
                        return true;
                    }
                }
            }

            return false;
        }

        // Edit comment text for a comment node
        editComment(node: NixUpstreamNode, newText: string): void {
            if (node.treeData && node.treeData.isComment) {
                node.treeData.commentText = newText;
                node.treeData.name = newText;
                node.label = `💬 ${newText}`;
                node.tooltip = newText;
                this._onDidChangeTreeData.fire(node);
            }
        }

        // Delete a comment node
        deleteComment(node: NixUpstreamNode): boolean {
            if (!node.treeData || !node.treeData.isComment) {
                return false;
            }

            const parent = this.nodeParentMap.get(node);

            if (!parent) {
                // Comment is at root level
                const commentIndex = this.callTrees.findIndex(tree => tree === node.treeData);
                if (commentIndex >= 0) {
                    this.callTrees.splice(commentIndex, 1);
                    this.rootNodes = [];
                    this._onDidChangeTreeData.fire();
                    return true;
                }
            } else {
                // Comment has a parent
                const parentTreeData = parent.treeData;

                // Check in referenceLocations first
                if (parentTreeData.referenceLocations) {
                    const refIndex = parentTreeData.referenceLocations.findIndex((ref: any) => ref === node.treeData);
                    if (refIndex >= 0) {
                        parentTreeData.referenceLocations.splice(refIndex, 1);
                        this._onDidChangeTreeData.fire(parent);
                        return true;
                    }
                }

                // Check in children
                if (parentTreeData.children) {
                    const childIndex = parentTreeData.children.findIndex((child: any) => child === node.treeData);
                    if (childIndex >= 0) {
                        parentTreeData.children.splice(childIndex, 1);
                        this._onDidChangeTreeData.fire(parent);
                        return true;
                    }
                }
            }

            return false;
        }

        // Helper function to determine type indicator based on file path and context
        private getTypeIndicator(filePath: string, isInterface: boolean = false): string {
            const fileName = filePath.toLowerCase();

            if (isInterface) return '𝐈';  // Bold I
            if (fileName.includes('controller')) return '𝐂';  // Bold C
            if (fileName.includes('service')) return '𝐒';  // Bold S
            if (fileName.includes('orchestrator')) return '𝐎';  // Bold O
            return '𝐌'; // Bold M - Default to Method
        }

        // Depth-first traversal: returns true if this node or any descendants are checked
        // MUST traverse entire tree - cannot return early or siblings won't be processed!
        private normalizeCheckStates(tree: any, depth: number = 0, debugOutput?: vscode.OutputChannel): boolean {
            let hasCheckedDescendant = false;

            // FIRST: ALWAYS traverse ALL children - never return early!
            if (tree.children && tree.children.length > 0) {
                for (const child of tree.children) {
                    // MUST call normalize on every child, even if we already found a checked one
                    const childHasChecked = this.normalizeCheckStates(child, depth + 1, debugOutput);
                    if (childHasChecked) {
                        hasCheckedDescendant = true;
                    }
                }
            }

            // SECOND: Check ALL reference locations - never break early!
            if (tree.referenceLocations && tree.referenceLocations.length > 0) {
                for (const ref of tree.referenceLocations) {
                    // IMPORTANT: Reference locations in the array don't have isReference flag
                    // but the UI nodes created from them do. We need to check using the SAME key
                    // that was used when the checkbox was stored (which includes isReference: true)
                    const refAsUINode = {
                        file: ref.file,
                        line: ref.line,
                        character: ref.character,
                        isReference: true  // This is what makes the key match!
                    };
                    const refChecked = this.getCheckboxState(refAsUINode);
                    if (refChecked) {
                        hasCheckedDescendant = true;
                    }
                }
            }

            // THIRD: Check if this node itself is checked
            const wasChecked = this.getCheckboxState(tree);
            if (wasChecked) {
                hasCheckedDescendant = true;
            }

            // FINALLY: ON THE WAY BACK UP: If any descendant is checked, auto-check this node
            if (hasCheckedDescendant && !wasChecked) {
                const nodeKey = this.getNodeKey(tree);
                this.checkedStates.set(nodeKey, true);
            }

            // Return whether this node or any descendant is checked
            return hasCheckedDescendant;
        }

        // DIAGNOSTIC version - normalizes checkboxes but doesn't delete anything
        pruneUncheckedItemsDiagnostic(outputChannel?: vscode.OutputChannel): number {
            let wouldPruneCount = 0;

            if (outputChannel) {
                outputChannel.appendLine(`=== STEP 1: NORMALIZING TREE (auto-checking parents) ===`);
            }

            // STEP 1: Normalize the tree - auto-check parents of checked descendants
            for (const tree of this.callTrees) {
                this.normalizeCheckStates(tree, 0, outputChannel);
            }

            if (outputChannel) {
                outputChannel.appendLine(`Normalization complete.\n`);
            }

            // Refresh the tree to show the updated checkmarks
            this.rootNodes = [];
            this._onDidChangeTreeData.fire();

            if (outputChannel) {
                outputChannel.appendLine(`\n=== CHECKBOX STATES AFTER NORMALIZATION ===`);
                outputChannel.appendLine(`Total checked items: ${this.checkedStates.size}`);
                this.checkedStates.forEach((checked, key) => {
                    outputChannel.appendLine(`  ${key}: ${checked}`);
                });
                outputChannel.appendLine(`\n=== STEP 2: ANALYZING WHAT WOULD BE PRUNED ===\n`);
            }

            // STEP 2: Count what WOULD be pruned (but don't actually prune)
            const analyzeTree = (tree: any, depth: number = 0): void => {
                const indent = '  '.repeat(depth);
                const nodeName = tree.name || 'unnamed';
                const nodeKey = this.getNodeKey(tree);
                const isChecked = this.getCheckboxState(tree);

                if (outputChannel) {
                    outputChannel.appendLine(`${indent}${nodeName}`);
                    outputChannel.appendLine(`${indent}  Key: ${nodeKey}`);
                    outputChannel.appendLine(`${indent}  Checked: ${isChecked}`);
                }

                // If this node is unchecked after normalization
                if (!isChecked) {
                    if (outputChannel) {
                        outputChannel.appendLine(`${indent}  ❌ WOULD DELETE ${nodeName}`);
                    }
                    wouldPruneCount++;
                    return; // Don't analyze children of nodes that would be deleted
                }

                if (outputChannel) {
                    outputChannel.appendLine(`${indent}  ✓ Would keep ${nodeName}`);
                }

                // Analyze children
                if (tree.children && tree.children.length > 0) {
                    for (const child of tree.children) {
                        analyzeTree(child, depth + 1);
                    }
                }

                // Analyze reference locations
                if (tree.referenceLocations && tree.referenceLocations.length > 0) {
                    for (const ref of tree.referenceLocations) {
                        const isRefChecked = this.getCheckboxState(ref);
                        const refName = `${ref.file}:${ref.line}`;
                        if (!isRefChecked) {
                            wouldPruneCount++;
                            if (outputChannel) {
                                outputChannel.appendLine(`${indent}  ❌ WOULD DELETE ref: ${refName}`);
                            }
                        } else {
                            if (outputChannel) {
                                outputChannel.appendLine(`${indent}  ✓ Would keep ref: ${refName}`);
                            }
                        }
                    }
                }
            };

            // Analyze all trees
            for (const tree of this.callTrees) {
                analyzeTree(tree, 0);
            }

            if (outputChannel) {
                outputChannel.appendLine(`\n=== DIAGNOSTIC COMPLETE ===`);
                outputChannel.appendLine(`Total items that WOULD be pruned: ${wouldPruneCount}`);
                outputChannel.appendLine(`Tree unchanged - checkmarks updated to show parent relationships`);
            }

            return wouldPruneCount;
        }

        // Prune unchecked items from the tree
        pruneUncheckedItems(outputChannel?: vscode.OutputChannel): number {
            let prunedCount = 0;

            // Check if debug output is enabled
            const config = vscode.workspace.getConfiguration('nixUpstreamCheck');
            const debugEnabled = config.get<boolean>('enablePruneDebugOutput', false);

            let debugOutput: vscode.OutputChannel | undefined;
            if (debugEnabled) {
                if (!outputChannel) {
                    debugOutput = vscode.window.createOutputChannel('Nix Upstream Check - Prune Debug');
                } else {
                    debugOutput = outputChannel;
                }
                debugOutput.clear();
                debugOutput.show(true);

                debugOutput.appendLine('=== PRUNE DEBUG ===');
                debugOutput.appendLine(`Total trees: ${this.callTrees.length}`);
                debugOutput.appendLine(`Checkbox states BEFORE normalization: ${this.checkedStates.size}`);
            }

            // STEP 1: Normalize the tree - auto-check parents of checked descendants
            for (const tree of this.callTrees) {
                this.normalizeCheckStates(tree, 0, debugOutput);
            }

            if (debugEnabled && debugOutput) {
                debugOutput.appendLine(`Checkbox states AFTER normalization: ${this.checkedStates.size}`);
                debugOutput.appendLine('\nAll checked states after normalization:');
                this.checkedStates.forEach((checked, key) => {
                    if (checked) {
                        debugOutput!.appendLine(`  ✓ ${key}`);
                    }
                });
                debugOutput.appendLine('\n=== STARTING PRUNING ===');
            }

            // STEP 2: Now prune - any node that's still unchecked has no checked descendants
            const pruneTree = (tree: any, depth: number = 0): any | null => {
                const isChecked = this.getCheckboxState(tree);

                if (debugEnabled && debugOutput) {
                    const indent = '  '.repeat(depth);
                    const nodeName = tree.name || 'unnamed';
                    const nodeKey = this.getNodeKey(tree);
                    debugOutput.appendLine(`${indent}${nodeName} (key: ${nodeKey}): checked=${isChecked}`);
                }

                // If this node is unchecked after normalization, it has no checked descendants
                if (!isChecked) {
                    if (debugEnabled && debugOutput) {
                        const indent = '  '.repeat(depth);
                        const nodeName = tree.name || 'unnamed';
                        debugOutput.appendLine(`${indent}  ❌ DELETING ${nodeName}`);
                    }
                    prunedCount++;
                    return null;
                }

                if (debugEnabled && debugOutput) {
                    const indent = '  '.repeat(depth);
                    const nodeName = tree.name || 'unnamed';
                    debugOutput.appendLine(`${indent}  ✓ KEEPING ${nodeName}`);
                }

                // This node is checked - keep it and recursively prune children
                if (tree.children && tree.children.length > 0) {
                    const beforeCount = tree.children.length;
                    tree.children = tree.children
                        .map((child: any) => pruneTree(child, depth + 1))
                        .filter((child: any) => child !== null);
                    const afterCount = tree.children.length;
                    if (debugEnabled && debugOutput && beforeCount !== afterCount) {
                        const indent = '  '.repeat(depth);
                        debugOutput.appendLine(`${indent}  Children: ${beforeCount} -> ${afterCount}`);
                    }
                }

                // Prune unchecked reference locations
                if (tree.referenceLocations && tree.referenceLocations.length > 0) {
                    const beforeCount = tree.referenceLocations.length;
                    tree.referenceLocations = tree.referenceLocations.filter((ref: any) => {
                        // Use the same key format fix as in normalizeCheckStates
                        const refAsUINode = {
                            file: ref.file,
                            line: ref.line,
                            character: ref.character,
                            isReference: true
                        };
                        const isRefChecked = this.getCheckboxState(refAsUINode);
                        if (debugEnabled && debugOutput) {
                            const indent = '  '.repeat(depth);
                            const refKey = this.getNodeKey(refAsUINode);
                            debugOutput.appendLine(`${indent}  Ref ${refKey}: checked=${isRefChecked}`);
                        }
                        if (!isRefChecked) {
                            prunedCount++;
                            return false;
                        }
                        return true;
                    });
                    const afterCount = tree.referenceLocations.length;
                    if (debugEnabled && debugOutput && beforeCount !== afterCount) {
                        const indent = '  '.repeat(depth);
                        debugOutput.appendLine(`${indent}  Refs: ${beforeCount} -> ${afterCount}`);
                    }
                }

                return tree;
            };

            // Prune all trees
            this.callTrees = this.callTrees
                .map((tree: any) => pruneTree(tree, 0))
                .filter((tree: any) => tree !== null);

            this.rootNodes = [];
            this._onDidChangeTreeData.fire();

            if (debugEnabled && debugOutput) {
                debugOutput.appendLine(`\n=== PRUNE COMPLETE ===`);
                debugOutput.appendLine(`Total items deleted: ${prunedCount}`);
                debugOutput.appendLine(`Remaining trees: ${this.callTrees.length}`);
            }

            return prunedCount;
        }

        // Ensure the tree persists when switching away and back
        refresh() {
            this._onDidChangeTreeData.fire();
        }

        // Update checkbox state for a node
        updateCheckboxState(node: NixUpstreamNode, checked: boolean) {
            if (node.treeData) {
                const key = this.getNodeKey(node.treeData);
                this.checkedStates.set(key, checked);
            }
        }

        // Get a unique key for a tree data node
        private getNodeKey(treeData: any): string {
            if (treeData.isReference) {
                return `ref:${treeData.file}:${treeData.line}:${treeData.character}`;
            }
            return `method:${treeData.file}:${treeData.line}:${treeData.name || ''}`;
        }

        // Get the checkbox state for a tree data node
        getCheckboxState(treeData: any): boolean {
            const key = this.getNodeKey(treeData);
            return this.checkedStates.get(key) || false;
        }

        getRootNodes(): NixUpstreamNode[] {
            return this.rootNodes;
        }

        getCallTrees(): any[] {
            return this.callTrees;
        }

        // Find an existing tree by file and line
        findExistingTree(file: string, line: number): any | undefined {
            return this.callTrees.find(tree => {
                return tree.file === file && tree.line === line;
            });
        }

        // Find a node in the tree by file and line (returns the UI node)
        findNodeByFileAndLine(file: string, line: number): NixUpstreamNode | undefined {
            // First check root nodes
            for (const rootNode of this.rootNodes) {
                if (rootNode.treeData &&
                    rootNode.treeData.file === file &&
                    rootNode.treeData.line === line) {
                    return rootNode;
                }
            }
            return undefined;
        }

        // Remove a node from the tree (works for root trees, child nodes, and references)
        removeCallTree(treeData: any): boolean {
            // Try to remove as a root tree first
            const rootIndex = this.callTrees.indexOf(treeData);
            if (rootIndex > -1) {
                this.callTrees.splice(rootIndex, 1);
                this.rootNodes = []; // Will be rebuilt
                this._onDidChangeTreeData.fire();
                return true;
            }

            // If not a root, search through all trees to find and remove this node
            const removeFromTree = (tree: any): boolean => {
                // Check if this node has children
                if (tree.children && tree.children.length > 0) {
                    const childIndex = tree.children.indexOf(treeData);
                    if (childIndex > -1) {
                        tree.children.splice(childIndex, 1);
                        return true;
                    }

                    // Recursively search children
                    for (const child of tree.children) {
                        if (removeFromTree(child)) {
                            return true;
                        }
                    }
                }

                // Check if this node has reference locations
                if (tree.referenceLocations && tree.referenceLocations.length > 0) {
                    const refIndex = tree.referenceLocations.indexOf(treeData);
                    if (refIndex > -1) {
                        tree.referenceLocations.splice(refIndex, 1);
                        return true;
                    }

                    // For reference nodes, we need to match by file and line
                    if (treeData.isReference) {
                        const matchingRefIndex = tree.referenceLocations.findIndex((ref: any) =>
                            ref.file === treeData.file &&
                            ref.line === treeData.line &&
                            ref.character === treeData.character
                        );
                        if (matchingRefIndex > -1) {
                            tree.referenceLocations.splice(matchingRefIndex, 1);
                            return true;
                        }
                    }
                }

                return false;
            };

            // Search through all root trees
            for (const rootTree of this.callTrees) {
                if (removeFromTree(rootTree)) {
                    this.rootNodes = []; // Will be rebuilt
                    this._onDidChangeTreeData.fire();
                    return true;
                }
            }

            return false;
        }

        // Serialize tree with checkbox states for JSON export
        serializeTreeWithCheckboxes(tree: any): any {
            const checked = this.getCheckboxState(tree);
            const serialized: any = {
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
                serialized.referenceLocations = tree.referenceLocations.map((ref: any) => {
                    // Create a reference-like object for getNodeKey to match UI nodes
                    const refData = { ...ref, isReference: true };
                    return {
                        file: ref.file,
                        line: ref.line,
                        character: ref.character,
                        checked: this.getCheckboxState(refData)
                    };
                });
            }

            // Recursively serialize children
            if (tree.children && tree.children.length > 0) {
                serialized.children = tree.children.map((child: any) => this.serializeTreeWithCheckboxes(child));
            }

            return serialized;
        }

        // Restore checkbox states from imported tree data
        restoreCheckboxStates(tree: any) {
            // Restore the checkbox state for this node
            if (tree.checked !== undefined) {
                const key = this.getNodeKey(tree);
                this.checkedStates.set(key, tree.checked);
            }

            // Restore checkbox states for reference locations
            if (tree.referenceLocations && tree.referenceLocations.length > 0) {
                tree.referenceLocations.forEach((ref: any) => {
                    if (ref.checked !== undefined) {
                        // Create a reference-like object for getNodeKey
                        const refData = { ...ref, isReference: true };
                        const key = this.getNodeKey(refData);
                        this.checkedStates.set(key, ref.checked);
                    }
                });
            }

            // Recursively restore checkbox states for children
            if (tree.children && tree.children.length > 0) {
                tree.children.forEach((child: any) => this.restoreCheckboxStates(child));
            }
        }

        // Convert tree to Markdown format
        treeToMarkdown(tree: any, depth: number, searchNumber?: number): string {
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
            } else {
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
                tree.referenceLocations.forEach((ref: any) => {
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
                tree.children.forEach((child: any) => {
                    md += this.treeToMarkdown(child, depth + 1);
                });
            }

            return md;
        }

        getTreeItem(element: NixUpstreamNode): vscode.TreeItem {
            return element;
        }

        getParent(element: NixUpstreamNode): vscode.ProviderResult<NixUpstreamNode> {
            return this.nodeParentMap.get(element);
        }

        getChildren(element?: NixUpstreamNode): Promise<NixUpstreamNode[]> {
            if (this.callTrees.length === 0) {
                return Promise.resolve([
                    new NixUpstreamNode('📋 How to use:', '', false, undefined, vscode.TreeItemCollapsibleState.None),
                    new NixUpstreamNode('1. Build your project first (dotnet build)', '', false, undefined, vscode.TreeItemCollapsibleState.None),
                    new NixUpstreamNode('2. Wait for C# extension to finish loading', '', false, undefined, vscode.TreeItemCollapsibleState.None),
                    new NixUpstreamNode('3. Place cursor on a C# method', '', false, undefined, vscode.TreeItemCollapsibleState.None),
                    new NixUpstreamNode('4. Right-click → "Check Upstream"', '', false, undefined, vscode.TreeItemCollapsibleState.None),
                    new NixUpstreamNode('', '', false, undefined, vscode.TreeItemCollapsibleState.None),
                    new NixUpstreamNode('⚠️ Important: Ensure code is saved and built', '', false, undefined, vscode.TreeItemCollapsibleState.None),
                    new NixUpstreamNode('for accurate reference detection!', '', false, undefined, vscode.TreeItemCollapsibleState.None)
                ]);
            }
            if (!element) {
                // Root level - show all search results
                this.rootNodes = this.callTrees.map(tree => {
                    const node = this.nodeFromTree(tree, false, true); // Pass true for isRoot
                    this.nodeParentMap.set(node, undefined); // Root has no parent
                    return node;
                });
                return Promise.resolve(this.rootNodes);
            }
            // Children are both reference locations AND upstream callers
            if (element['treeData']) {
                const children: NixUpstreamNode[] = [];
                const treeData = element['treeData'];

                // First, add reference locations if they exist
                if (treeData.referenceLocations && treeData.referenceLocations.length > 0) {
                    for (const refLoc of treeData.referenceLocations) {
                        const fileName = refLoc.file.split(/[/\\]/).pop() || refLoc.file;
                        // Add reference type indicator if available (N or P for class references, I for interfaces)
                        let refTypePrefix = '';
                        if (refLoc.referenceType === 'N') {
                            refTypePrefix = '𝐍 ';  // Bold N for new/instantiation
                        } else if (refLoc.referenceType === 'P') {
                            refTypePrefix = '𝐏 ';  // Bold P for parameter
                        } else if (refLoc.referenceType === 'I') {
                            refTypePrefix = '𝐈 ';  // Bold I for interface
                        }
                        const label = `${refTypePrefix}📍 ${fileName}:${refLoc.line + 1}`;
                        // Create a tree data object for the reference location
                        const refTreeData = {
                            name: label,
                            file: refLoc.file,
                            line: refLoc.line,
                            character: refLoc.character,
                            isReference: true,
                            referenceType: refLoc.referenceType // Preserve for checkbox key generation
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

        // Count total methods and references in a tree
        private countTreeStats(tree: any): { methods: number; refs: number } {
            let methods = 0;
            let refs = 0;

            // Count this node if it's a method (not a reference)
            if (!tree.isReference && tree.name) {
                methods = 1;
            }

            // Count reference locations
            if (tree.referenceLocations && tree.referenceLocations.length > 0) {
                refs += tree.referenceLocations.length;
            }

            // Recursively count children
            if (tree.children && tree.children.length > 0) {
                for (const child of tree.children) {
                    const childStats = this.countTreeStats(child);
                    methods += childStats.methods;
                    refs += childStats.refs;
                }
            }

            return { methods, refs };
        }

        nodeFromTree(tree: any, checked: boolean, isRoot: boolean = false): NixUpstreamNode {
            // Handle comment nodes
            if (tree.isComment) {
                const commentNode = new NixUpstreamNode(
                    `💬 ${tree.commentText}`,
                    tree.commentText,
                    false,
                    tree,
                    vscode.TreeItemCollapsibleState.None
                );
                return commentNode;
            }

            // Handle reference location nodes differently
            let label: string;
            let tooltip: string;
            let collapsibleState: vscode.TreeItemCollapsibleState;

            if (tree.isReference) {
                // Reference location node
                label = tree.name; // Already formatted as "📍 filename:line"
                tooltip = `Reference at:\n${tree.file}:${tree.line + 1}:${tree.character + 1}`;
                collapsibleState = vscode.TreeItemCollapsibleState.None;
            } else if (tree.isClass) {
                // Class node - use lowercase 'c' indicator
                label = `c ${tree.name}`;

                // For root nodes, add the stats
                if (isRoot) {
                    const stats = this.countTreeStats(tree);
                    // For class nodes, show methods that use the class
                    const methodCount = stats.methods;
                    if (methodCount > 0 || stats.refs > 0) {
                        label += ` (${stats.refs} ref${stats.refs !== 1 ? 's' : ''} in ${methodCount} method${methodCount !== 1 ? 's' : ''})`;
                    }
                }

                tooltip = tree.namespace ? `${tree.namespace}\n${tree.file ? tree.file : ''}:${tree.line !== undefined ? tree.line + 1 : ''}` : '';

                // Node is expandable if it has children OR reference locations
                const hasChildren = tree.children && tree.children.length > 0;
                const hasReferences = tree.referenceLocations && tree.referenceLocations.length > 0;
                // Default to EXPANDED for all nodes that have children
                if (hasChildren || hasReferences) {
                    collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                } else {
                    collapsibleState = vscode.TreeItemCollapsibleState.None;
                }
            } else {
                // Method node - determine type indicator
                let isInterfaceMethod = false;

                // Check if this method is in an interface by examining the source
                if (tree.file && typeof tree.line === 'number') {
                    try {
                        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === tree.file);
                        if (doc) {
                            // Search backwards from the method line to find interface or class
                            for (let i = tree.line; i >= Math.max(0, tree.line - 50); i--) {
                                const lineText = doc.lineAt(i).text.trim();
                                if (/\bclass\s+\w+/.test(lineText)) {
                                    // Hit a class first, not an interface
                                    break;
                                }
                                if (/\binterface\s+\w+/.test(lineText)) {
                                    isInterfaceMethod = true;
                                    break;
                                }
                            }
                        }
                    } catch (e) {
                        // If we can't check, fall back to filename check
                        isInterfaceMethod = tree.file.toLowerCase().includes('interface');
                    }
                }

                const baseTypeIndicator = this.getTypeIndicator(tree.file || '', false);

                // If it's an interface method, prepend 𝐈 to whatever type indicator it has
                const typeIndicator = isInterfaceMethod ? `𝐈${baseTypeIndicator}` : baseTypeIndicator;

                // Add type indicator before the method name (no brackets, using bold unicode)
                label = `${typeIndicator} ${tree.name}${tree.httpAttribute ? ` [${tree.httpAttribute}]` : ''}`;

                // For root nodes, add the stats
                if (isRoot) {
                    const stats = this.countTreeStats(tree);
                    // Subtract 1 from methods because we don't count the root itself
                    const methodCount = stats.methods - 1;
                    if (methodCount > 0 || stats.refs > 0) {
                        label += ` (${stats.refs} ref${stats.refs !== 1 ? 's' : ''} in ${methodCount} method${methodCount !== 1 ? 's' : ''})`;
                    }
                }

                tooltip = tree.namespace ? `${tree.namespace}\n${tree.file ? tree.file : ''}:${tree.line !== undefined ? tree.line + 1 : ''}` : '';

                // Node is expandable if it has children OR reference locations
                const hasChildren = tree.children && tree.children.length > 0;
                const hasReferences = tree.referenceLocations && tree.referenceLocations.length > 0;
                // Default to EXPANDED for all nodes that have children
                if (hasChildren || hasReferences) {
                    collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                } else {
                    collapsibleState = vscode.TreeItemCollapsibleState.None;
                }
            }

            // Check if this node already has a stored checkbox state
            const nodeKey = this.getNodeKey(tree);
            const hasStoredState = this.checkedStates.has(nodeKey);

            // If no stored state exists, default to checked; otherwise use stored state
            let isChecked: boolean;
            if (hasStoredState) {
                isChecked = this.checkedStates.get(nodeKey)!;
            } else {
                // New items default to checked
                isChecked = true;
                this.checkedStates.set(nodeKey, true);
            }

            const node = new NixUpstreamNode(label, tooltip, isChecked, tree, collapsibleState);

            // Make all nodes with file location clickable
            if (tree.file && typeof tree.line === 'number') {
                (node as vscode.TreeItem).command = {
                    command: 'nixUpstreamCheck.openLocation',
                    title: tree.isReference ? 'Open Reference Location' : 'Open Location',
                    arguments: [tree]
                };
            }
            return node;
        }
    }

class NixUpstreamNode extends vscode.TreeItem {
    public treeData: any;
    public checked: boolean;
    public isCommentNode?: boolean;
    constructor(
        label: string,
        tooltip: string,
        checked: boolean,
        treeData?: any,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(label, collapsibleState);
        (this as vscode.TreeItem).tooltip = tooltip;
        this.checked = checked;
        this.treeData = treeData;
        this.isCommentNode = treeData?.isComment || false;

        // Only set context value and checkbox for actual data nodes (not info messages)
        if (treeData) {
            // Set different context values for reference nodes vs method/class nodes
            if (treeData.isComment) {
                (this as vscode.TreeItem).contextValue = 'nixUpstreamComment';
            } else if (treeData.isReference) {
                (this as vscode.TreeItem).contextValue = 'nixUpstreamReference';
            } else {
                (this as vscode.TreeItem).contextValue = 'nixUpstreamNode';
            }
            // Set checkbox state using the proper VSCode API (not for comments)
            if (!treeData.isComment) {
                (this as vscode.TreeItem).checkboxState = checked
                    ? vscode.TreeItemCheckboxState.Checked
                    : vscode.TreeItemCheckboxState.Unchecked;
            }
        } else {
            // Informational nodes - no context menu or checkbox
            (this as vscode.TreeItem).contextValue = 'nixUpstreamInfo';
        }
    }
}
