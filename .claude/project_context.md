# Nix Upstream Check - Webview Tree Implementation Notes

## Goal
Replace native VS Code TreeDataProvider with custom webview-based tree to enable:
1. **Colored indent lines** - Each indentation level uses resistor color code: Brown(0), Red(1), Orange(2), Yellow(3), Green(4), Blue(5), Violet(6), Gray(7), White(8), Pink(9), Cyan(10)
2. **Multi-selection** - Click, Ctrl+Click, Shift+Click, Ctrl+A
3. **Multi-checkbox toggle** - Checking/unchecking applies to all selected rows
4. **Alt+Up/Down** - Reorder sibling nodes (replaces drag-and-drop)

## Current Architecture
- **Tree Provider**: `NixUpstreamTreeProvider` class (line ~1636)
- **Tree Node**: `NixUpstreamNode` extends `vscode.TreeItem` (line ~2672)
- **View Registration**: package.json views section (line ~199)
- **Data Structure**: `callTrees` array holds tree data, `nodeParentMap` tracks hierarchy

## Key Features to Preserve
- Checkboxes with state tracking (`checkedStates` Map)
- Expand/collapse nodes
- Click to navigate to file location
- Add/remove nodes
- Comments with 👇 icon and auto-increment
- Export/Import JSON
- Prune unchecked items
- Drag and drop for reordering (REPLACE with Alt+Up/Down)

## Implementation Plan

### Phase 1: Webview Setup
1. Create new webview panel in sidebar viewsContainer
2. Set up HTML template with CSS for tree rendering
3. Implement message passing between extension and webview

### Phase 2: Tree Rendering
1. Convert tree data to HTML structure
2. Implement colored indent guides using CSS borders/backgrounds
3. Add checkbox and expand/collapse UI elements
4. Style selected rows

### Phase 3: Selection Logic
1. Track selected row IDs in webview state
2. Single click = select one, clear others
3. Ctrl+Click = toggle selection
4. Shift+Click = range select from last anchor
5. Ctrl+A = select all visible rows

### Phase 4: Interactions
1. Checkbox click = toggle all selected rows
2. Row click (on label) = navigate to location
3. Expand/collapse arrow clicks
4. Alt+Up/Down = reorder within same parent

### Phase 5: Integration
1. Hook up all commands (export, import, prune, etc)
2. Ensure checkbox state sync with tree data
3. Test all existing features work

## Color Scheme (Resistor Code)
```css
Level 0: #8B4513 (Brown)
Level 1: #FF0000 (Red)
Level 2: #FFA500 (Orange)
Level 3: #FFFF00 (Yellow)
Level 4: #00FF00 (Green)
Level 5: #0000FF (Blue)
Level 6: #8B00FF (Violet)
Level 7: #808080 (Gray)
Level 8: #FFFFFF (White)
Level 9: #FF00FF (Pink/Magenta)
Level 10: #00FFFF (Cyan)
```

## Issues Found
- Interface detection not working - needs debugging in `interfaceRegex` pattern
- Comment icon and auto-increment need re-implementation after rollback
- .data folder support needs re-implementation after rollback

## Files to Modify
- `src/extension.ts` - Main extension logic
- `package.json` - View configuration
- New files needed:
  - `src/treeWebview.ts` - Webview provider class
  - `media/tree.html` - HTML template
  - `media/tree.css` - Styling
  - `media/tree.js` - Client-side logic
