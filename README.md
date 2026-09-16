# Parquetly

Open `.parquet` / `.pq` / `.parq` files in VS Code as a fast, searchable, editable,
plottable table — no Python, no notebook, no conversion step.

![Viewing a parquet file in VS Code](https://raw.githubusercontent.com/barathjk/parquetly/main/media/assets/gifs/view_parquet_file.gif)

## What makes it different

**It opens files that other viewers choke on.** Rows are streamed out of the file in
batches of 10,000 and rendered through a virtual-scrolled grid, so only the rows you can
actually see exist in the DOM. A half-million-row file opens without freezing the window.

![Opening a large parquet file](https://raw.githubusercontent.com/barathjk/parquetly/main/media/assets/gifs/opening_large_parquet_file.gif)

**You can plot a column without leaving the editor.** Right-click any column header →
**Plot**. Histograms and pie charts are drawn as hand-built inline SVG — there is no chart
library in the bundle — with a bins slider, a dashed mean line, mouse-wheel zoom,
click-drag panning, and a live Count / Min / Max / Mean / Median / StdDev bar that
recomputes over whatever range you have zoomed into. Plots always run over the rows
currently visible after your filters, so filtering the table re-plots the chart.

![Plotting a column](https://raw.githubusercontent.com/barathjk/parquetly/main/media/assets/gifs/Plotting.gif)

**It writes real Parquet back out.** Edit cells inline, then **Save** — column types are
taken from the source file, so an `INT64` column comes back as `INT64` rather than widened
to a double.

**It has no dependencies you can see.** The whole UI is vanilla JS and VS Code theme
tokens: no grid library, no chart library, no web fonts. It follows your active light,
dark, or high-contrast theme automatically.

## Features

- **Virtual-scrolled grid** — fixed 28px rows, only the visible window is in the DOM.
- **Read / Edit mode toggle** — every data-mutating control is disabled while read-only,
  so you cannot change a file you only meant to look at.
- **Search** — live substring filter across all visible columns. Ctrl+Click a cell to
  filter by that exact value.
- **Sort** — click a header to sort ascending, click again for descending. Nulls sort last.
- **Column tools** — right-click a header to sort, filter by unique values, view column
  stats, plot the column, copy it, or hide it. Drag a header's right edge to resize.
- **Columns panel** — show/hide any column.
- **Quick Plot** — histograms and pie charts as inline SVG, exportable as `.svg`.
- **SQL bar** — a deliberately small `WHERE` / `ORDER BY` / `LIMIT` grammar that filters
  the rows already in memory. Not real SQL (see below).
- **Diff** — compare the open file against a second parquet file by column name.
- **Editing** — double-click a cell to edit inline with automatic type detection, add /
  duplicate / delete rows, and undo/redo up to 50 steps.
- **Save as Parquet** — writes a real Parquet file, preserving the source column types.
- **Export CSV** — all rows, the filtered rows, or just the selected rows.

## Usage

Open any `.parquet`, `.pq`, or `.parq` file the way you would open any other file —
double-click it in the Explorer. Parquetly is the default editor for those extensions.

Or run **Parquetly: Open Parquet File** from the Command Palette
(<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) to pick a file from anywhere on disk.

The file opens read-only. Flip the **Read / Edit** toggle in the toolbar to enable
editing — double-click a cell to change it, and use the row buttons to add, duplicate, or
delete rows.

To go back to plain text or another viewer for one file: right-click it in the Explorer →
**Open With…**.

## Keyboard shortcuts

These are scoped to the webview — they work while the table has focus and intentionally do
not appear in the VS Code Keyboard Shortcuts UI, so they never collide with your own
bindings.

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

A header sort is applied *before* the SQL bar, so `ORDER BY` wins and `LIMIT` takes the
top N of the visible order.

## Saving

**Save** writes a real Parquet file. It opens a save dialog pre-filled with
`<original-name>_edited.parquet`, so the file you opened is never overwritten unless you
explicitly choose to.

Column types are taken from the source file, so a round trip is lossless — an `INT64`
column comes back as `INT64`, not widened to a double. If an edit no longer fits its
original type (say you type text into an integer column), only that column widens, and the
notification tells you which ones and to what.

`Export CSV` remains separate, and can export all rows, the filtered rows, or just the
selected rows.

## Issues and source

[github.com/barathjk/parquetly](https://github.com/barathjk/parquetly) — build and test
instructions are in [CONTRIBUTING.md](CONTRIBUTING.md).

MIT licensed.
