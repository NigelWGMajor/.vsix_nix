# Claude.Local.MD

This file is used to store local configuration and settings for Claude. It is not intended to be shared or committed to version control.

This is intended to provide context for the current work session.

This project is an extension for VSCode, specifically to discover upstream methods that could be affected by code changes. It uses several methods, relying on the C# extensions already installed.

As currently implemented, the extension successfully identifies methods or interfaces at the current cursor position, and builds a tree of upstream methods that could be affected by changes to the selected method.

These are presented to the user in a tree view, allowing for easy navigation and exploration of the codebase.

Each line in this tree view has a checkbox, which the user can check to mark that line for further action, satisfying one ofthe use cases, i.e. to triage where action is needed in the code.

The extension also provides a command to export the selected lines to a markdown file, allowing for easy sharing and collaboration with other developers.

Problem 1:

Claude spent considerable time trying to get the ability to purge the tree of non-checked items, but was unable to do so within the current timebox. The intent is that when the user purges the tree, the checked lines should remain. Unfortunately Claude seems to have difficulty with recursive data structures, and was unsuccessful in keeping the checked lines if they had ancestors that were unchecked, because the tree is traversed in such a way that the ancestors are processed first. The logic is simple:

- Every node in the tree must be traversed!
- If a node is checked, its parent node becomes essential, so it should become checked.
- If a node has any children that are checked, it should also be considered checked.
- In any case, the next sibling node must be examined: because even if unchecked, it could have a descendant that is checked. This is where Claude has been making some dumb assumptions and optimizing the traversal, which breaks the functionality.

- The way to solve this recursively is:
  - Make a function that is called recursively from each root (we can have multiple roots because the tool can be run multiple times)
  - The function FIRST AND ALWAYS calls itself with each of the node's children!
  - The function sets checked to true and returns true if the node is checked, or if ANY of its children returned true.
  - Once the entire tree has been traversed, the essential nodes will have been identified and the next root node can be processed.  When ALL roots have been processed, the tree can be rebuilt with only the checked nodes.

Problem 2:

The need to triage for upstream changes can also be triggered by a change to a class. I need to add the ability to detect when a class is selected, in which case we need to identify references to that class, and then identify all methods that call those references, recursively, building the same kind of tree as for a method. 

This is a more complex problem because classes can be referenced in many ways: as method parameters, as return types, as local variables, as fields, etc. The extension will need to be able to identify all these references and then build the upstream call tree accordingly.
