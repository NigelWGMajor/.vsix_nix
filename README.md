# Nix Upstream Check VS Code Extension

This extension allows you to find all upstream references to a C# function and display the call tree in a sidebar.

## Features
- Right-click a C# method and select "Nix Upstream Check" to trace upstream calls.
- View the call tree in the sidebar, with checkboxes for each node.
- Click nodes to open the file at the relevant line.
- Refresh line numbers if files change.
- Persist the tree and checkbox state to a text file.

## Development
- All code is in the `.vsix_nix` folder.
- Run `npm install` and `npm run compile` in `.vsix_nix` to build.
- Press F5 in VS Code to launch the extension in a new Extension Development Host window.
