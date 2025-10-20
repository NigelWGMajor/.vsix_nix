# Nix Upstream Check - Method Caller Tracker

A Visual Studio Code extension for C# developers that traces and visualizes all upstream method callers in an interactive tree view.

## Features

### 🔍 Smart Reference Detection
- **Multi-strategy search**: Uses VS Code's Call Hierarchy API, CodeLens API, Reference Provider API, and optional file scanning
- **Accurate results**: Finds exact call locations with line and character positions
- **Auto-expands**: Automatically opens the tree view when you run a search
- **Recursive traversal**: Traces the entire call chain from your method up to HTTP controllers

### 📊 Interactive Tree View
- **Reference locations**: See exact file locations (📍) where each method is called
- **Clickable nodes**: Jump directly to any method definition or reference location
- **Checkboxes**: Mark items as reviewed/handled
- **Multiple searches**: Accumulate results from multiple searches in the same tree
- **Auto-expand**: Tree automatically expands to show your results

### 🛠️ Powerful Tools
- **Expand All**: Recursively expand the entire tree
- **Prune Unchecked**: Remove all unchecked items to focus on what matters
- **Export as JSON**: Save the complete tree with checkbox states
- **Export as Markdown**: Generate a formatted report with clickable links
- **Exhaustive Search**: Right-click any node to force a deep file scan
- **Clear Tree**: Start fresh with a new search

## Usage

1. **Build your C# project** (`dotnet build`) to ensure the language server has indexed your code
2. **Place your cursor** on any C# method definition
3. **Right-click** and select **"Check Method Callers"**
4. The sidebar will open automatically showing the call tree

### Tree Structure

```
MethodA
├─ 📍 FileX.cs:42:10      ← Exact call location (clickable)
├─ 📍 FileY.cs:158:5      ← Another call location
├─ MethodB                ← Calling method
│  ├─ 📍 FileZ.cs:89:12
│  └─ MethodC             ← Further upstream
└─ MethodD [HttpGet]      ← Stops at controllers
   └─ 📍 FileW.cs:201:8
```

### Toolbar Buttons
- 🔍 **Expand All** - Recursively expand all tree nodes
- 💾 **Export as JSON** - Save tree data with checkbox states
- 📝 **Export as Markdown** - Generate a formatted report
- 🔽 **Prune Unchecked** - Remove unchecked items
- ❌ **Clear Tree** - Remove all results

### Settings
- `nixUpstreamCheck.enableFileScanFallback` - Enable slow file scan when language server returns no results (default: false)

## Requirements
- Visual Studio Code 1.70.0 or higher
- C# extension (ms-dotnettools.csharp)
- .NET project built and indexed

## Development
- All code is in the `.vsix_nix` folder
- Run `npm install` and `npm run compile` to build
- Run `npx @vscode/vsce package` to create the VSIX file
- Press F5 in VS Code to launch the extension in debug mode
