# Nix Upstream Check - Method Caller Tracker

A Visual Studio Code extension for C# developers to visualize upstream callers in an interactive tree view.

## tl;dr

Finds upstream references to C# members. 

Results are shown in a tree with

- category indicators (Interface, Contoller, Orchestrator, Test ...)
- informational tooltips
- link to location or where referenced 📍 (double-click to navigate)
- checkboxes for marking to-do or done ☑️
- load and save as upstream.json files
- manual additions and comments
- additional tools for pruning, copying as markdown, etc.

## Features

- **Multi-strategy search**: Can use VS Code's Call Hierarchy API, CodeLens API, Reference Provider API, and optional file scanning (see settings)
- **Navigation**: double-click to navigate in the codebase
- **Checkboxes**: Mark items as done or to-do
- **Category indicators**: Tags methods as Interface, Controller, Orchestrator, Test, etc. based on naming conventions and attributes
- **Tree functions**: Expand, Collapse, Selective prune, move with arrows
- **Persistence**: Save and load the tree as *.upstream.json files
- **Markdown export**: Copy the tree as markdown to clipboard for documentation or sharing
- **Manual additions**: Add arbitrary lines or comments to the tree
- **Sticky Comments**: comments stick to the line when it is moved
- **Restorable**: the tree can be rebuilt from the root to update

## Usage

- **Build your C# project** (`dotnet build`) to ensure the language server has indexed your code
- Ensure that the solution is fully loaded (references are shown in the codelens tips)
- **Place your cursor** on any C# method definition
- **Right-click** and select **"Check Upstream"**
- A messagebar will show the progress
- The call tree will be shown in the sidebar
- Double-clicking on a node will navigate to the item in your solution
- Right-click for context menu options
- click to select, with shift for range, ctrl for multi-select
- Use the arrow keys to move selected items up or down
- Use the toolbar icons to
  - Add a link to the current selection
  - Expand the tree
  - Load from a file
  - Save to a file
  - Copy to the clipboard as markdown
  - Prune unchecked items
  - Clear the tree

## Persistence

If you save the treeview as xxx.upstream.json you can load it directly from the explorer by right-click `Load as Upstream Json` or double-clicking the file.
The default folder for loading and saving is the workspace root, unless there is a `.data` folder there, in which case that will be used. Once a path has been chosen in a session it sticks.

## Requirements

- Visual Studio Code 1.70.0 or higher
- C# extension (ms-dotnettools.csharp)
- .NET project built and indexed
