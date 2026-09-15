# Parquetly

Open `.parquet` / `.pq` / `.parq` files in VS Code as a fast, searchable, plottable table.

Parquet files open in a custom read-only-document editor. Rows are streamed out of the
file in batches of 10,000 and rendered through a virtual-scrolled grid, so a half-million
row file opens without freezing the window.

## Features

- **Virtual-scrolled grid** — fixed 28px rows, only the visible window is in the DOM.
- **Read / Edit mode toggle** — every data-mutating control is disabled while read-only.
- **Search** — live substring filter across all visible columns. Ctrl+Click a cell to
  filter by that exact value.
- **Sort** — click a header to sort ascending, click again for descending. Nulls sort last.
- **Column tools** — right-click a header to sort, filter by unique values, view column
  stats, plot the column, copy it, or hide it. Drag a header's right edge to resize.
- **Columns panel** — show/hide any column.
- **Quick Plot** — histograms and pie charts drawn as hand-built inline SVG (no chart
  library). Histograms support a bins slider, a dashed mean line, mouse-wheel zoom,
  click-drag panning, and a live Count/Min/Max/Mean/Median/StdDev bar recomputed over the
  visible range. Pie charts support a top-N slices slider and a legend. Either can be
  exported as an SVG file. Plots always run over the currently filtered rows.
- **SQL bar** — a deliberately small `WHERE` / `ORDER BY` / `LIMIT` grammar that filters
  the rows already in memory. Not real SQL (see below).
- **Diff** — compare the open file against a second parquet file by column name.
- **Editing** — double-click a cell to edit inline with automatic type detection, add /
  duplicate / delete rows, and undo/redo up to 50 steps.
- **Save as Parquet** — writes a real Parquet file back out, preserving the source
  column types.
- **Export CSV** — all rows, the filtered rows, or just the selected rows.
- **Theming** — all styling comes from VS Code theme tokens, so the grid follows the
  active light, dark, or high-contrast theme automatically.

## Usage

Open any `.parquet`, `.pq`, or `.parq` file, or run **Parquetly: Open Parquet File** from
the Command Palette.

## Keyboard shortcuts

These are scoped to the webview — they work while the table has focus and intentionally do
not appear in the VS Code Keyboard Shortcuts UI.

| Shortcut | Action |
| --- | --- |
| `Ctrl+F` | Focus the search box |
| `Ctrl+G` | Toggle Go To Row |
| `Ctrl+Q` | Toggle the SQL bar |
| `Ctrl+C` | Copy selected rows as TSV |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Delete` | Delete selected rows |
| `Escape` | Close a menu or panel, or cancel a cell edit |
| `Enter` / `Escape` / `Tab` | While editing a cell: commit / cancel / commit and move right |

Row selection: click to select, Ctrl+Click the row number to toggle, Shift+Click to select
a range. Ctrl+Click on a *data* cell filters by that cell's value instead.

## The SQL bar is not SQL

It is a small regex grammar over the rows already loaded in the webview:

```
WHERE Age > 30 AND Sex = 'female' ORDER BY Fare DESC LIMIT 100
```

`LIMIT` is stripped first, then `ORDER BY`, and whatever follows `WHERE` is split on a
single level of `AND` / `OR` — there are no parentheses and no operator precedence.
Supported comparisons are `=`, `!=`, `<>`, `>`, `<`, `>=`, `<=`, `LIKE`, `NOT LIKE`,
`IS NULL`, `IS NOT NULL`, and `IN (a,b,c)`. Parse errors surface as a VS Code notification.

## Saving

**Save** writes a real Parquet file. It opens a save dialog pre-filled with
`<original-name>_edited.parquet`, so the file you opened is never overwritten unless you
choose to.

Column types are taken from the source file, so a round trip is lossless — an `INT64`
column comes back as `INT64`, not widened to a double. If an edit no longer fits its
original type (say you type text into an integer column), only that column widens, and the
notification tells you which ones and to what.

`Export CSV` remains separate, and can export all rows, the filtered rows, or just the
selected rows.

## Development

```bash
npm install
npm run watch     # or: npm run compile
```

Press <kbd>F5</kbd> to launch an Extension Development Host, then open a parquet file.

```bash
npm test              # production build, then every verification suite
npm run package       # production webpack bundle
npm run vsce:package  # build the .vsix
```

`npm test` runs the real webview in jsdom and the bundled extension host against the
fixtures in `inputs/`. It then writes Parquet files and checks they round-trip exactly. If
Python with `pyarrow` is installed, an independent reader also validates those files;
otherwise that step is reported as skipped.

- [docs/prompt.md](docs/prompt.md) is the build spec, including every approved deviation
  from the original.
- [.claude/agents/parquetly-engineer.md](.claude/agents/parquetly-engineer.md) is a Claude
  Code subagent for changing and debugging the extension.
- [.claude/skills/parquetly-verify/SKILL.md](.claude/skills/parquetly-verify/SKILL.md) is the
  build → test → package gate that agent follows.

Only `src/*.ts` is bundled (webpack, target node, `vscode` external) into
`dist/extension.js`. `media/main.js` and `media/styles.css` ship unbundled and use no
external UI, chart, or grid libraries. The only runtime dependencies are
[hyparquet](https://github.com/hyparam/hyparquet) for reading and
[hyparquet-writer](https://github.com/hyparam/hyparquet-writer) for writing.
