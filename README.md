# Nix Upstream Check - Method Caller Tracker

A Visual Studio Code extension for C# developers that traces and visualizes all upstream method callers in an interactive tree view.

## tl;dr

Finds upstream references to C# members. 

Results are shown in a tree with

- category indicators (Interface, Contoller, Orchestrator, Test ...)
- informational tooltips
- clickable link to location
- clickable link to where referenced 📍
- checkboxes for marking to-do or done ☑️
- load and save as upstream.json files
- manual additions and comments
- additional tools for pruning, copying as markdown, etc.

## Features

- **Multi-strategy search**: Uses VS Code's Call Hierarchy API, CodeLens API, Reference Provider API, and optional file scanning
- **Accurate results**: Finds exact call locations with line and character positions
- **Auto-expands**: Automatically opens the tree view when you run a search
- **Category indicators**: Tags methods as Interface, Controller, Orchestrator, Test, etc. based on naming conventions and attributes

## Usage

- **Build your C# project** (`dotnet build`) to ensure the language server has indexed your code
- Ensure that the solution is fully loaded (and references are shown in the codelens tips)
- **Place your cursor** on any C# method definition
- **Right-click** and select **"Check Upstream"**
- A messagebar will show the progress
- The call tree will be shown in the sidebar
- Clicking on a node will locate the item in your solution
- Right-click for context menu options
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
the default folder is the workspace root, unless there is a.data folder there, in which case that will be preferred.

## Requirements

- Visual Studio Code 1.70.0 or higher
- C# extension (ms-dotnettools.csharp)
- .NET project built and indexed
