# Parquetly — build specification

This is the original `prompt.md` the extension was built from, transcribed verbatim from
photos of the source file (line numbers were not preserved). It remains the source of truth,
**except** where a section is marked `[SUPERSEDED]` — those parts were changed with the
owner's explicit approval, and the replacement behaviour is recorded under
[Approved deviations](#approved-deviations) at the end. Read that section before acting on
anything marked superseded.

---

Build a VS Code extension "Parquetly" that opens .parquet/.pq/.parq files in a custom
read-only-document webview table editor.

MANIFEST (package.json):
- activationEvents: ["onCustomEditor:parquetly.parquetEditor"]
- contributes.customEditors: viewType "parquetly.parquetEditor", selector on
  *.parquet/*.pq/*.parq, priority "default"
- contributes.commands: "parquetly.openFile" -> "Parquetly: Open Parquet File"
- No settings, no keybindings contributed.
- dependency: hyparquet ^1.7.0 (pure-JS parquet reader, zero deps)
  `[SUPERSEDED in part — hyparquet-writer is also a dependency, see deviation 1]`
- devDeps: typescript, webpack+webpack-cli+ts-loader, @types/node, @types/vscode, @vscode/vsce
  `[SUPERSEDED in part — jsdom is also a devDependency, see deviation 5]`
- webpack bundles only src/*.ts (target node, externals: vscode) to dist/extension.js;
  media/ (main.js, styles.css) ships unbundled.

EXTENSION HOST (src/extension.ts + src/parquetEditorProvider.ts):
- activate(): register CustomReadonlyEditorProvider for "parquetly.parquetEditor"
  (webviewOptions.retainContextWhenHidden: true), register "parquetly.openFile" command
  that shows an open-file dialog filtered to parquet extensions then runs
  vscode.commands.executeCommand('vscode.openWith', uri, 'parquetly.parquetEditor').
- resolveCustomEditor: build webview HTML (CSP with nonce, links media/styles.css + main.js).
  Handle webview messages:
    'ready' -> stream-read the file: vscode.workspace.fs.readFile, then hyparquet's
      parquetMetadata(arrayBuffer) for schema/columns/row count, then parquetRead in
      batches of 10,000 rows, normalizing bigint->Number, Uint8Array->UTF8 string,
      Date->ISOString. Post back 'load-start' (columns+metadata+totalRows), 'load-chunk'
      (compact row arrays + offset) per batch, 'load-done' at the end, 'status' for
      progress, 'error' on failure.
    'exportCsv' -> showSaveDialog then fs.writeFileSync the given CSV text.
    'saveParquet' -> NOTE: does NOT write real parquet; writes edited rows as CSV to
      "<name>_edited.csv" next to the original and tells the user to convert via pandas.
      `[SUPERSEDED — Save writes real Parquet, see deviation 1]`
    'copyToClipboard' -> vscode.env.clipboard.writeText.
    'info' -> showInformationMessage.
    'requestDiffFile' -> open picker for a 2nd parquet file, read it fully (same batched
      hyparquet logic), reply with 'diff-data' { columns, rows, fileName }.

WEBVIEW (media/main.js, vanilla JS, no frameworks/libraries):
- Virtual-scrolled table (fixed row height ~28px, absolute-positioned rows, buffered
  render window) built from streamed row chunks.
- Toolbar: file info, Read/Edit mode toggle (edit-only buttons disabled while read-only),
  search box (live substring filter across all columns; Ctrl+Click a cell filters by that
  value), Go To Row (Ctrl+G), Columns visibility panel, Quick Plot, SQL query bar (Ctrl+Q),
  Diff button, Add Row/Delete/Undo/Redo (edit mode only), Export CSV (all/filtered/selected),
  Save.
  `[Ctrl+Click conflicts with row selection below — resolved in deviation 2]`
- Click header to sort asc/desc; right-click header for menu (sort, filter-by-unique-values
  panel, column stats popup, plot column, copy column, hide column); drag column edge to
  resize.
- Double-click cell (edit mode) to edit inline; Enter commits, Escape cancels, Tab
  commits+moves next; auto type-detect (number/bool/null/string).
- Row selection: click=select, Ctrl+click=toggle, Shift+click=range; right-click row for
  context menu (copy, filter by value, duplicate, delete).
- Undo/redo: up to 50 JSON snapshots, Ctrl+Z/Ctrl+Y; skip initial snapshot for >50k rows.
- Ctrl+C copies selected rows as TSV.
- Quick Plot: modal with column+chart-type(histogram/pie) selectors; render pure inline
  SVG (no chart lib) — histogram with bins slider, mean line, mouse-wheel zoom + drag pan,
  live stats (count/min/max/mean/median/stddev); pie chart with top-N slices slider + legend.
  Export chart as SVG file.
- SQL bar: simple regex parser supporting WHERE (=, !=, >, <, >=, <=, LIKE, IS NULL, IN,
  AND/OR - no parentheses), ORDER BY, LIMIT — filters the in-memory rows, not real SQL.
- Diff view: compare current data against a second parquet file by common column names,
  report added/removed columns, added/removed row counts, and list first ~100 changed
  cells in a table.
- Style via VS Code theme CSS variables (--vscode-editor-background etc.) so it follows
  the active theme automatically.

Keep everything single-file per concern (one extension.ts, one provider.ts, one main.js,
one styles.css) — no external UI/chart/grid libraries besides hyparquet.
`[Still holds for UI/chart/grid libraries. hyparquet-writer is a host-side I/O library, see deviation 1]`

EXACT MESSAGE PROTOCOL (use these literal type strings so both sides agree):
Webview -> Extension: 'ready', 'exportCsv' {csv}, 'saveParquet' {data:{columns,rows}},
  'info' {text}, 'copyToClipboard' {text}, 'requestDiffFile'.
Extension -> Webview: 'load' {data} (legacy single-shot path, keep for completeness),
  'load-start' {data:{columns, metadata:{fileName,filePath,totalRows,totalColumns}, totalRows}},
  'load-chunk' {data:{rows, offset}} (rows are arrays-of-arrays, not objects — webview
  converts each to {__idx, col1:v1, ...} on receipt), 'load-done', 'status' {message},
  'error' {message}, 'diff-data' {data:{columns, rows, fileName}}.

TOOLBAR DOM/ELEMENT IDS (match these exactly so behavior wiring is unambiguous):
app-title, file-info, mode-label, read-mode-toggle (checkbox), search-input,
btn-clear-filter, btn-goto, goto-container, goto-input, btn-columns, btn-plot, btn-sql,
btn-diff, btn-add-row, btn-delete-row, btn-undo, btn-redo, btn-export-csv, btn-save,
loading, error-message, data-table, table-head, table-body, status-rows, status-cols,
status-selected, status-position. Buttons that mutate data get class "edit-only" and are
visually disabled (opacity 0.4, pointer-events none) while read-only mode is on.

CSS THEME VARIABLES (define these custom properties mapped to VS Code theme tokens, then
use only these throughout styles.css so the UI auto-adapts to light/dark/high-contrast):
--bg-primary: var(--vscode-editor-background); --bg-secondary: var(--vscode-sideBar-background);
--fg-primary: var(--vscode-editor-foreground); --fg-secondary: var(--vscode-descriptionForeground);
--border-color: var(--vscode-panel-border); --accent: var(--vscode-button-background);
--accent-fg: var(--vscode-button-foreground); --hover-bg: var(--vscode-list-hoverBackground);
--selected-bg: var(--vscode-list-activeSelectionBackground);
--selected-fg: var(--vscode-list-activeSelectionForeground);
--input-bg: var(--vscode-input-background); --input-fg: var(--vscode-input-foreground);
--input-border: var(--vscode-input-border);
--table-header-bg: var(--vscode-editorGroupHeader-tabsBackground).
Use a reusable overlay+panel system (classes: overlay, panel, panel-header, panel-close,
panel-body, panel-controls, panel-list, panel-item, panel-apply) for every modal (Columns,
Filter-by-Values, Column Stats, Quick Plot, Diff results). Context menus use classes:
context-menu, context-menu-item (+ .disabled variant), context-menu-separator. Cell value
styling classes: null-value (italic, dimmed "null" text), bool-true (green), bool-false
(red), number-value (tinted). SQL bar uses class sql-bar inserted directly above
#table-container. Mode toggle uses a checkbox-driven CSS switch (classes: toggle-switch,
toggle-slider).

SQL BAR PARSING DETAILS (implement this exact mini-grammar, not real SQL):
1) Strip 'LIMIT (\d+)' via regex first (case-insensitive).
2) Strip 'ORDER BY (\w+)(?:\s+(ASC|DESC))?' via regex next.
3) Whatever follows 'WHERE' is the condition clause; split on /\s+(AND|OR)\s+/i (single
   level, no parentheses/precedence).
4) Each condition token matches regex:
   ^(\w+)\s*(=|!=|<>|>=|<=|>|<|LIKE|NOT\s+LIKE|IS\s+NULL|IS\s+NOT\s+NULL|IN)\s*(.*)$
   Strip surrounding quotes from the value portion.
5) Operator semantics: '=' compares String equality OR Number equality; '!='/'<>' negation
   of the same; >,<,>=,<= compare Number(cell) vs Number(value); LIKE/NOT LIKE translate SQL
   wildcards (% -> .*, _ -> .) into an anchored case-insensitive RegExp; IS NULL / IS NOT
   NULL check null/undefined; IN (a,b,c) splits on commas, strips quotes, exact string match.
6) Combine condition results left-to-right using each token's preceding AND/OR join word.
7) On any parse/eval exception, postMessage {type:'info', text:'SQL Error: ' + err.message}
   back to the extension host so it shows as a VS Code notification.

QUICK PLOT RENDERING DETAILS:
- Render everything as hand-built inline <svg> strings (no canvas, no chart library).
- Histogram: compute bin edges over the current zoom range [zMin,zMax] (defaults to
  global min/max), bucket the visible values, draw gridlines + Y-axis count labels, one
  <rect> per bin with a <title> tooltip (bin range + count), a dashed orange mean line with
  a 'μ = value' label, X-axis tick labels, axis lines, and a title/subtitle line showing the
  column name + visible value count. Support mouse-wheel zoom (zoom toward cursor X,
  factor ~1.3 to zoom out / ~0.77 to zoom in, clamped to global bounds, snap back to
  unzoomed when the range becomes negligibly small) and click-drag panning. Show a live
  stats bar (Count/Min/Max/Mean/Median/StdDev) computed over the currently visible/zoomed
  subset, recalculated on every zoom/pan. Provide +/-/Reset zoom buttons and an 'Export SVG'
  button that serializes the <svg> via XMLSerializer to a data:image/svg+xml URI and
  triggers a programmatic download.
- Pie: count frequency of values, keep only the top N (per the max-slices slider), render
  each as an SVG arc <path> (with <title> tooltip: label, count, percentage), label slices
  covering >=4% of the total with a percentage, and render a 3-column legend grid below the
  pie with color swatches, truncated labels, counts, and percentages, cycling through the
  fixed color palette listed above.
  `[The palette was not legible in the source photos — see deviation 3]`
- 'Plot Column' from the header context menu should auto-pick histogram if the majority of
  the column's values are numeric, otherwise pie.
- All plotting operates on the currently filtered row subset, not necessarily all rows.

KEYBOARD SHORTCUTS (webview-scoped only — do NOT add contributes.keybindings to package.json;
these only work while the webview has focus and won't appear in the Keyboard Shortcuts UI):
Ctrl+Z undo, Ctrl+Y redo (not Ctrl+Shift+Z), Ctrl+C copy selected rows as TSV, Ctrl+F focus
search box, Ctrl+G toggle Go To Row, Ctrl+Q toggle SQL bar, Delete key deletes selected rows,
Escape closes any open context menu/overlay panel or cancels an in-progress cell edit. While
editing a cell: Enter commits, Escape cancels, Tab commits and moves editing to the next
visible column in the same row.

DIFF VIEW DETAILS:
- Compare only up to min(currentRows.length, diffRows.length, 10000) rows.
- Match columns by name (not position): commonCols = intersection, addedCols = in diff file
  only, removedCols = in current file only.
- For each row within the compare limit, for each common column, compare
  String(val1 ?? '') !== String(val2 ?? '') to count changed cells; collect the first 100
  {row, col, from, to} diffs for display (1-based row numbers).
- addedRows = max(0, diffRowCount - currentRowCount); removedRows = max(0, currentRowCount -
  diffRowCount) (simple size-delta, not a keyed reconciliation).
- Results panel: summary stat cards (current rows, compare rows, changed cells, +added rows,
  -removed rows), any added/removed column name lists, then a table of the first 100 changed
  cells with columns Row | Column | Current (styled red) | Compare (styled green).

DO NOT implement real Parquet writing. 'Save' must intentionally just export the edited grid
as CSV to '<original-name>_edited.csv' next to the source file and notify the user to convert
it back via pandas if needed — this mirrors the original tool's known limitation exactly.
`[SUPERSEDED — see deviation 1]`

---

## Approved deviations

Each of these changes or fills in the spec above. Every entry was either approved by the
owner or forced by an ambiguity in the source. **Do not revert one without asking.** When a
new deviation is approved, add it here with the date and what it supersedes.

### 1. Save writes real Parquet — approved 2026-09-15

Supersedes: the `'saveParquet'` host bullet, the closing "DO NOT implement real Parquet
writing" paragraph, and the hyparquet-only dependency rule (for the host side only).

- The `'saveParquet'` message type and its `{data:{columns,rows}}` payload are unchanged.
- The host opens a save dialog pre-filled with `<original-name>_edited.parquet`, filtered to
  `.parquet/.pq/.parq`. Cancelling writes nothing. The source file is never overwritten
  unless the user picks it in the dialog.
- The file is written with `hyparquet-writer` (`parquetWriteBuffer`), a runtime dependency.
- **Column types are preserved from the source file's schema**, which the host caches on the
  document when the file is first read. The webview's normalization is lossy, so values are
  converted back on write: INT64 needs `bigint`, TIMESTAMP needs `Date`.
- If an edited value no longer fits its column's original type, only that column widens
  (numbers → DOUBLE, booleans → BOOLEAN, anything mixed → STRING), and the success
  notification names every widened column and its new type.
- A column stays REQUIRED only if the source had it REQUIRED and it contains no nulls.
- Export CSV is unchanged and remains the way to get CSV.

### 2. Ctrl+Click on a cell vs on a row — resolved 2026-09-15

The spec gives Ctrl+Click two meanings: "filters by that value" (toolbar section) and
"toggle" selection (row selection section). Resolution:

- Ctrl+Click on a **data cell** filters by that cell's value.
- Ctrl+Click on the **row-number cell** toggles that row's selection.

### 3. Pie chart palette — filled in 2026-09-15

"The fixed color palette listed above" is not legible in the source photos. The palette used
is Tableau 10, cycled in order: `#4e79a7 #f28e2c #e15759 #76b7b2 #59a14f #edc949 #af7aa1
#ff9da7 #9c755f #bab0ab`. Replace it if the original list is recovered.

### 4. Header sort runs before the SQL bar — decided 2026-09-15

The spec does not order the two. The header sort is applied first, so an explicit
`ORDER BY` in the SQL bar always wins, and `LIMIT` takes the first N rows of whatever order is
showing. Applying the sort afterwards silently reordered `ORDER BY ... LIMIT` results.

### 5. Automated verification suites — added 2026-09-15

Supersedes: the devDependency list (adds `jsdom`).

- `test/` holds the suites; `npm test` builds the production bundle and runs them all.
- `test/`, `docs/`, `.claude/`, `inputs/` and `reference/` are excluded from the VSIX by
  `.vscodeignore`. The packaged extension contains only `dist/extension.js`, `media/`,
  `package.json`, `README.md` and `LICENSE`.
- `inputs/titanic.parquet` and `inputs/sample-large.parquet` are required fixtures. The suites
  assert on their exact contents.
