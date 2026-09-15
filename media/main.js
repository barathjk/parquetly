/* ------------------------------------------------------------------ *
 * Parquetly webview - vanilla JS, no frameworks, no libraries.
 *
 * Owns: virtual-scrolled table, search / filters / sort, column panel,
 * inline cell editing, undo/redo, quick plot (hand-built SVG), the
 * mini-SQL bar, and the diff view.
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /* ---------------------------------------------------------- constants */

  const ROW_HEIGHT = 28;
  const RENDER_BUFFER = 8;
  const DEFAULT_COL_WIDTH = 150;
  const ROW_NUM_WIDTH = 70;
  const MIN_COL_WIDTH = 50;
  const MAX_UNDO = 50;
  const INITIAL_SNAPSHOT_ROW_LIMIT = 50000;
  const DIFF_ROW_LIMIT = 10000;
  const DIFF_CELL_LIMIT = 100;

  /* Fixed palette for pie slices / legend swatches, cycled as needed. */
  const PLOT_COLORS = [
    '#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f',
    '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab',
  ];

  /* -------------------------------------------------------------- state */

  const state = {
    columns: [],
    allRows: [],
    filteredRows: [],
    hiddenColumns: new Set(),
    colWidths: Object.create(null),
    sortColumn: null,
    sortDirection: 'asc',
    searchTerm: '',
    valueFilters: Object.create(null), // column -> Set of allowed string values
    sqlQuery: '',
    selectedRows: new Set(),
    lastClickedPos: -1,
    readOnly: true,
    fileMeta: null,
    totalRows: 0,
    loaded: false,
    undoStack: [],
    redoStack: [],
    editing: null, // { row, col }
    diffData: null,
  };

  /* ----------------------------------------------------------- elements */

  const el = {};
  [
    'app-title', 'file-info', 'mode-label', 'read-mode-toggle', 'search-input',
    'btn-clear-filter', 'btn-goto', 'goto-container', 'goto-input', 'btn-columns',
    'btn-plot', 'btn-sql', 'btn-diff', 'btn-add-row', 'btn-delete-row', 'btn-undo',
    'btn-redo', 'btn-export-csv', 'btn-save', 'loading', 'error-message',
    'data-table', 'table-head', 'table-body', 'status-rows', 'status-cols',
    'status-selected', 'status-position', 'toolbar', 'table-container',
  ].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  /* ------------------------------------------------------------ helpers */

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function visibleColumns() {
    return state.columns.filter(function (c) {
      return !state.hiddenColumns.has(c);
    });
  }

  function colWidth(col) {
    return state.colWidths[col] || DEFAULT_COL_WIDTH;
  }

  function totalGridWidth() {
    return visibleColumns().reduce(function (sum, c) {
      return sum + colWidth(c);
    }, ROW_NUM_WIDTH);
  }

  function isNullish(v) {
    return v === null || v === undefined || v === '';
  }

  function cellText(value) {
    if (value === null || value === undefined) {
      return 'null';
    }
    return String(value);
  }

  /** Raw text used for search / export, where null becomes empty. */
  function rawText(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value);
  }

  /** Shared cell presentation, used by both the full render and in-place repaints. */
  function cellRender(value, needle) {
    let cls = 'editable-cell';
    if (value === null || value === undefined) {
      cls += ' null-value';
    } else if (typeof value === 'boolean') {
      cls += value ? ' bool-true' : ' bool-false';
    } else if (typeof value === 'number') {
      cls += ' number-value';
    }
    const text = cellText(value);
    if (needle && text.toLowerCase().indexOf(needle) !== -1) {
      cls += ' search-hit';
    }
    return { cls: cls, text: text };
  }

  function isNumericValue(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function formatNumber(n) {
    if (!isFinite(n)) {
      return String(n);
    }
    if (Number.isInteger(n)) {
      return n.toLocaleString();
    }
    return Number(n.toFixed(4)).toLocaleString();
  }

  /* Infer a display type for a column from the first non-null values. */
  function columnType(col) {
    for (let i = 0, seen = 0; i < state.allRows.length && seen < 20; i++) {
      const v = state.allRows[i][col];
      if (v === null || v === undefined) {
        continue;
      }
      seen++;
      if (typeof v === 'number') {
        return 'num';
      }
      if (typeof v === 'boolean') {
        return 'bool';
      }
      return 'str';
    }
    return 'str';
  }

  /* ------------------------------------------------ message from the host */

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || !message.type) {
      return;
    }
    switch (message.type) {
      case 'load':
        // Legacy single-shot path, kept for completeness.
        handleLoadStart({
          columns: message.data.columns,
          metadata: message.data.metadata || {},
          totalRows: (message.data.rows || []).length,
        });
        handleLoadChunk({ rows: message.data.rows || [], offset: 0 });
        handleLoadDone();
        break;
      case 'load-start':
        handleLoadStart(message.data);
        break;
      case 'load-chunk':
        handleLoadChunk(message.data);
        break;
      case 'load-done':
        handleLoadDone();
        break;
      case 'status':
        if (!state.loaded) {
          el.loading.classList.remove('hidden');
          el.loading.textContent = message.message;
        }
        break;
      case 'error':
        el.loading.classList.add('hidden');
        el['error-message'].classList.remove('hidden');
        el['error-message'].textContent = message.message;
        break;
      case 'diff-data':
        showDiffResults(message.data);
        break;
    }
  });

  function handleLoadStart(data) {
    state.columns = data.columns || [];
    state.fileMeta = data.metadata || {};
    state.totalRows = data.totalRows || 0;
    state.allRows = [];
    state.filteredRows = [];
    state.selectedRows.clear();
    state.hiddenColumns.clear();
    state.undoStack = [];
    state.redoStack = [];
    state.loaded = false;

    el['error-message'].classList.add('hidden');
    el.loading.classList.remove('hidden');
    el.loading.textContent = 'Loading rows\u2026';
    el['file-info'].textContent =
      (state.fileMeta.fileName || '') +
      '  \u2014  ' +
      (state.totalRows || 0).toLocaleString() +
      ' rows \u00d7 ' +
      (state.fileMeta.totalColumns || state.columns.length) +
      ' columns';
    el['file-info'].title = state.fileMeta.filePath || '';

    buildHeader();
    updateStatusBar();
  }

  /** Rows arrive as arrays-of-arrays; convert each to an object on receipt. */
  function handleLoadChunk(data) {
    const rows = data.rows || [];
    const offset = data.offset || 0;
    const cols = state.columns;
    for (let i = 0; i < rows.length; i++) {
      const src = rows[i];
      const row = { __idx: offset + i };
      for (let c = 0; c < cols.length; c++) {
        row[cols[c]] = src[c] === undefined ? null : src[c];
      }
      state.allRows.push(row);
    }
    applyFiltersAndRender();
  }

  function handleLoadDone() {
    state.loaded = true;
    el.loading.classList.add('hidden');
    // Skip the baseline undo snapshot on very large files - it is expensive
    // and rarely useful.
    if (state.allRows.length <= INITIAL_SNAPSHOT_ROW_LIMIT) {
      state.undoStack = [snapshot()];
    }
    applyFiltersAndRender();
    updateUndoRedoButtons();
  }

  /* --------------------------------------------------- filtering / sort */

  function applyFilters() {
    let rows = state.allRows;

    // Column value filters (from the filter-by-values panel / cell ctrl+click)
    const filterCols = Object.keys(state.valueFilters);
    if (filterCols.length) {
      rows = rows.filter(function (row) {
        for (let i = 0; i < filterCols.length; i++) {
          const col = filterCols[i];
          if (!state.valueFilters[col].has(rawText(row[col]))) {
            return false;
          }
        }
        return true;
      });
    }

    // Live substring search across all (visible) columns
    if (state.searchTerm) {
      const needle = state.searchTerm.toLowerCase();
      const cols = visibleColumns();
      rows = rows.filter(function (row) {
        for (let i = 0; i < cols.length; i++) {
          if (rawText(row[cols[i]]).toLowerCase().indexOf(needle) !== -1) {
            return true;
          }
        }
        return false;
      });
    }

    // Header sort. Applied before the SQL bar so that an explicit ORDER BY
    // wins, and so LIMIT takes the first N rows of whatever order is showing.
    if (state.sortColumn && state.columns.indexOf(state.sortColumn) !== -1) {
      const col = state.sortColumn;
      const dir = state.sortDirection === 'asc' ? 1 : -1;
      rows = rows.slice().sort(function (a, b) {
        const va = a[col];
        const vb = b[col];
        const na = va === null || va === undefined;
        const nb = vb === null || vb === undefined;
        if (na && nb) {
          return 0;
        }
        if (na) {
          return 1; // nulls always last
        }
        if (nb) {
          return -1;
        }
        if (typeof va === 'number' && typeof vb === 'number') {
          return (va - vb) * dir;
        }
        return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
      });
    }

    // Mini-SQL bar
    if (state.sqlQuery) {
      rows = runSqlQuery(rows, state.sqlQuery);
    }

    state.filteredRows = rows;
  }

  function applyFiltersAndRender() {
    applyFilters();
    render();
    updateStatusBar();
  }

  /* ------------------------------------------------------------- header */

  function buildHeader() {
    const cols = visibleColumns();
    let html = '<tr><th class="row-num-head" style="width:' + ROW_NUM_WIDTH + 'px">#</th>';
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      const isSorted = state.sortColumn === col;
      const arrow = isSorted ? (state.sortDirection === 'asc' ? '\u25b2' : '\u25bc') : '';
      const filtered = state.valueFilters[col] ? ' \u2691' : '';
      html +=
        '<th data-col="' + escapeHtml(col) + '" style="width:' + colWidth(col) + 'px" title="' +
        escapeHtml(col) + '">' +
        '<span class="th-label">' + escapeHtml(col) + escapeHtml(filtered) + '</span>' +
        (arrow ? '<span class="sort-indicator">' + arrow + '</span>' : '') +
        '<div class="col-resizer" data-col="' + escapeHtml(col) + '"></div>' +
        '</th>';
    }
    html += '</tr>';
    el['table-head'].innerHTML = html;
    el['data-table'].style.width = totalGridWidth() + 'px';
  }

  /* ------------------------------------------------- virtual-scroll body */

  function render() {
    const cols = visibleColumns();
    const rows = state.filteredRows;
    const body = el['table-body'];
    const container = el['table-container'];

    body.style.height = rows.length * ROW_HEIGHT + 'px';
    const gridWidth = totalGridWidth();
    el['data-table'].style.width = gridWidth + 'px';

    const viewportHeight = container.clientHeight || 400;
    const scrollTop = container.scrollTop;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - RENDER_BUFFER);
    const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + RENDER_BUFFER * 2;
    const last = Math.min(rows.length, first + visibleCount);

    const needle = state.searchTerm ? state.searchTerm.toLowerCase() : '';
    const parts = [];

    for (let i = first; i < last; i++) {
      const row = rows[i];
      const selected = state.selectedRows.has(row) ? ' selected' : '';
      parts.push(
        '<tr class="data-row' + selected + '" data-pos="' + i +
        '" style="transform:translateY(' + i * ROW_HEIGHT + 'px);width:' + gridWidth + 'px">'
      );
      parts.push(
        '<td class="row-num" style="width:' + ROW_NUM_WIDTH + 'px">' + (row.__idx + 1) + '</td>'
      );
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        const info = cellRender(row[col], needle);
        parts.push(
          '<td class="' + info.cls + '" data-col="' + escapeHtml(col) + '" style="width:' +
          colWidth(col) + 'px" title="' + escapeHtml(info.text) + '">' +
          escapeHtml(info.text) + '</td>'
        );
      }
      parts.push('</tr>');
    }

    body.innerHTML = parts.join('');
    updatePositionStatus(first, last);
  }

  // Focusing a cell editor can nudge the container's scrollTop; ignore scroll
  // events that did not actually move the view, otherwise the editor commits
  // and closes the instant it opens.
  let lastScrollTop = 0;
  el['table-container'].addEventListener('scroll', function () {
    const top = el['table-container'].scrollTop;
    if (top === lastScrollTop) {
      return;
    }
    lastScrollTop = top;
    if (state.editing) {
      commitEdit();
    }
    render();
  });

  window.addEventListener('resize', render);

  /* --------------------------------------------------------- status bar */

  /**
   * Repaint selection by toggling classes on the rows already in the DOM.
   * Selection must never rebuild the body: a double-click arrives as
   * click, click, dblclick, so replacing the rows on the click would detach
   * the cell before the dblclick could reach the delegated listener.
   */
  function updateSelectionUi() {
    const trs = el['table-body'].querySelectorAll('tr.data-row');
    for (let i = 0; i < trs.length; i++) {
      const row = state.filteredRows[parseInt(trs[i].dataset.pos, 10)];
      trs[i].classList.toggle('selected', state.selectedRows.has(row));
    }
    updateStatusBar();
  }

  function updateStatusBar() {
    const total = state.allRows.length;
    const shown = state.filteredRows.length;
    el['status-rows'].textContent =
      shown === total
        ? 'Rows: ' + total.toLocaleString()
        : 'Rows: ' + shown.toLocaleString() + ' of ' + total.toLocaleString();
    el['status-cols'].textContent =
      'Cols: ' + visibleColumns().length +
      (state.hiddenColumns.size ? ' (' + state.hiddenColumns.size + ' hidden)' : '');
    el['status-selected'].textContent = state.selectedRows.size
      ? 'Selected: ' + state.selectedRows.size.toLocaleString()
      : '';
  }

  function updatePositionStatus(first, last) {
    const shown = state.filteredRows.length;
    el['status-position'].textContent = shown
      ? 'Showing ' + (first + 1).toLocaleString() + '\u2013' + last.toLocaleString() +
        ' of ' + shown.toLocaleString()
      : 'No rows';
  }

  /* ------------------------------------------------------- undo / redo */

  function snapshot() {
    return JSON.stringify(state.allRows);
  }

  function pushUndo() {
    state.undoStack.push(snapshot());
    if (state.undoStack.length > MAX_UNDO) {
      state.undoStack.shift();
    }
    state.redoStack = [];
    updateUndoRedoButtons();
  }

  function restore(json) {
    state.allRows = JSON.parse(json);
    state.selectedRows.clear();
    applyFiltersAndRender();
  }

  function undo() {
    if (state.readOnly || state.undoStack.length < 2) {
      return;
    }
    const current = state.undoStack.pop();
    state.redoStack.push(current);
    restore(state.undoStack[state.undoStack.length - 1]);
    updateUndoRedoButtons();
  }

  function redo() {
    if (state.readOnly || !state.redoStack.length) {
      return;
    }
    const next = state.redoStack.pop();
    state.undoStack.push(next);
    restore(next);
    updateUndoRedoButtons();
  }

  function updateUndoRedoButtons() {
    el['btn-undo'].classList.toggle('disabled', state.undoStack.length < 2);
    el['btn-redo'].classList.toggle('disabled', state.redoStack.length === 0);
  }

  /* Mutations always keep the top of the undo stack equal to current data. */
  function commitMutation(mutator) {
    if (state.readOnly) {
      return;
    }
    if (!state.undoStack.length) {
      state.undoStack.push(snapshot());
    }
    mutator();
    pushUndo();
    applyFiltersAndRender();
  }

  /* ------------------------------------------------------ mode toggling */

  function setReadOnly(readOnly) {
    state.readOnly = readOnly;
    document.body.classList.toggle('read-only', readOnly);
    el['mode-label'].textContent = readOnly ? 'Read-only' : 'Edit';
    if (readOnly && state.editing) {
      cancelEdit();
    }
  }

  el['read-mode-toggle'].addEventListener('change', function () {
    setReadOnly(el['read-mode-toggle'].checked);
  });

  /* --------------------------------------------------------- toolbar UI */

  let searchTimer = null;
  el['search-input'].addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.searchTerm = el['search-input'].value.trim();
      el['table-container'].scrollTop = 0;
      applyFiltersAndRender();
    }, 120);
  });

  el['btn-clear-filter'].addEventListener('click', function () {
    el['search-input'].value = '';
    state.searchTerm = '';
    state.valueFilters = Object.create(null);
    state.sqlQuery = '';
    const sqlInput = document.getElementById('sql-input');
    if (sqlInput) {
      sqlInput.value = '';
    }
    buildHeader();
    applyFiltersAndRender();
  });

  el['btn-goto'].addEventListener('click', toggleGoto);

  function toggleGoto() {
    el['goto-container'].classList.toggle('hidden');
    if (!el['goto-container'].classList.contains('hidden')) {
      el['goto-input'].focus();
      el['goto-input'].select();
    }
  }

  el['goto-input'].addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      gotoRow(parseInt(el['goto-input'].value, 10));
    } else if (event.key === 'Escape') {
      el['goto-container'].classList.add('hidden');
    }
  });

  function gotoRow(displayNumber) {
    if (!displayNumber || displayNumber < 1) {
      return;
    }
    let pos = -1;
    for (let i = 0; i < state.filteredRows.length; i++) {
      if (state.filteredRows[i].__idx === displayNumber - 1) {
        pos = i;
        break;
      }
    }
    if (pos === -1) {
      pos = Math.min(displayNumber - 1, state.filteredRows.length - 1);
    }
    if (pos < 0) {
      return;
    }
    el['table-container'].scrollTop = Math.max(0, pos * ROW_HEIGHT - ROW_HEIGHT * 3);
    state.selectedRows.clear();
    state.selectedRows.add(state.filteredRows[pos]);
    state.lastClickedPos = pos;
    render();
    updateStatusBar();
  }

  el['btn-columns'].addEventListener('click', openColumnsPanel);
  el['btn-plot'].addEventListener('click', function () {
    openPlotPanel(null);
  });
  el['btn-sql'].addEventListener('click', toggleSqlBar);
  el['btn-diff'].addEventListener('click', function () {
    vscode.postMessage({ type: 'requestDiffFile' });
  });

  el['btn-add-row'].addEventListener('click', function () {
    commitMutation(function () {
      const row = { __idx: state.allRows.length };
      state.columns.forEach(function (c) {
        row[c] = null;
      });
      state.allRows.push(row);
    });
    el['table-container'].scrollTop = el['table-body'].scrollHeight;
  });

  el['btn-delete-row'].addEventListener('click', deleteSelectedRows);

  function deleteSelectedRows() {
    if (state.readOnly || !state.selectedRows.size) {
      return;
    }
    const doomed = state.selectedRows;
    commitMutation(function () {
      state.allRows = state.allRows.filter(function (row) {
        return !doomed.has(row);
      });
      state.selectedRows = new Set();
    });
  }

  el['btn-undo'].addEventListener('click', undo);
  el['btn-redo'].addEventListener('click', redo);

  el['btn-export-csv'].addEventListener('click', function (event) {
    const rect = el['btn-export-csv'].getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom + 2, [
      { label: 'Export all rows (' + state.allRows.length.toLocaleString() + ')', action: function () { exportCsv(state.allRows); } },
      { label: 'Export filtered rows (' + state.filteredRows.length.toLocaleString() + ')', action: function () { exportCsv(state.filteredRows); } },
      {
        label: 'Export selected rows (' + state.selectedRows.size.toLocaleString() + ')',
        disabled: state.selectedRows.size === 0,
        action: function () {
          exportCsv(state.filteredRows.filter(function (r) { return state.selectedRows.has(r); }));
        },
      },
    ]);
    event.stopPropagation();
  });

  el['btn-save'].addEventListener('click', function () {
    if (state.readOnly) {
      return;
    }
    vscode.postMessage({
      type: 'saveParquet',
      data: { columns: state.columns, rows: stripRows(state.allRows) },
    });
  });

  function stripRows(rows) {
    return rows.map(function (row) {
      const out = {};
      state.columns.forEach(function (c) {
        out[c] = row[c];
      });
      return out;
    });
  }

  /* ------------------------------------------------------------- export */

  function csvEscape(value) {
    const str = rawText(value);
    if (/[",\n\r]/.test(str)) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function exportCsv(rows) {
    const cols = visibleColumns();
    const lines = [cols.map(csvEscape).join(',')];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      lines.push(cols.map(function (c) { return csvEscape(row[c]); }).join(','));
    }
    vscode.postMessage({ type: 'exportCsv', csv: lines.join('\n') });
  }

  function copySelectedAsTsv() {
    if (!state.selectedRows.size) {
      return;
    }
    const cols = visibleColumns();
    const lines = [cols.join('\t')];
    for (let i = 0; i < state.filteredRows.length; i++) {
      const row = state.filteredRows[i];
      if (!state.selectedRows.has(row)) {
        continue;
      }
      lines.push(cols.map(function (c) { return rawText(row[c]); }).join('\t'));
    }
    vscode.postMessage({ type: 'copyToClipboard', text: lines.join('\n') });
  }

  /* ---------------------------------------------- header interactions */

  el['table-head'].addEventListener('click', function (event) {
    if (event.target.classList.contains('col-resizer')) {
      return;
    }
    const th = event.target.closest('th[data-col]');
    if (!th) {
      return;
    }
    const col = th.dataset.col;
    if (state.sortColumn === col) {
      state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortColumn = col;
      state.sortDirection = 'asc';
    }
    buildHeader();
    el['table-container'].scrollTop = 0;
    applyFiltersAndRender();
  });

  el['table-head'].addEventListener('contextmenu', function (event) {
    const th = event.target.closest('th[data-col]');
    if (!th) {
      return;
    }
    event.preventDefault();
    const col = th.dataset.col;
    showContextMenu(event.clientX, event.clientY, [
      { label: 'Sort Ascending', action: function () { sortBy(col, 'asc'); } },
      { label: 'Sort Descending', action: function () { sortBy(col, 'desc'); } },
      { separator: true },
      { label: 'Filter by Values\u2026', action: function () { openFilterPanel(col); } },
      { label: 'Column Stats\u2026', action: function () { openStatsPanel(col); } },
      { label: 'Plot Column', action: function () { openPlotPanel(col); } },
      { separator: true },
      { label: 'Copy Column', action: function () { copyColumn(col); } },
      { label: 'Hide Column', action: function () { hideColumn(col); } },
    ]);
  });

  function sortBy(col, dir) {
    state.sortColumn = col;
    state.sortDirection = dir;
    buildHeader();
    el['table-container'].scrollTop = 0;
    applyFiltersAndRender();
  }

  function copyColumn(col) {
    const text = state.filteredRows.map(function (r) { return rawText(r[col]); }).join('\n');
    vscode.postMessage({ type: 'copyToClipboard', text: col + '\n' + text });
  }

  function hideColumn(col) {
    state.hiddenColumns.add(col);
    buildHeader();
    applyFiltersAndRender();
  }

  /* Column resizing by dragging the right edge of a header cell. */
  let resizing = null;

  el['table-head'].addEventListener('mousedown', function (event) {
    if (!event.target.classList.contains('col-resizer')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const col = event.target.dataset.col;
    resizing = { col: col, startX: event.clientX, startWidth: colWidth(col) };
    document.body.style.cursor = 'col-resize';
  });

  document.addEventListener('mousemove', function (event) {
    if (!resizing) {
      return;
    }
    const width = Math.max(MIN_COL_WIDTH, resizing.startWidth + (event.clientX - resizing.startX));
    state.colWidths[resizing.col] = width;
    buildHeader();
    render();
  });

  document.addEventListener('mouseup', function () {
    if (resizing) {
      resizing = null;
      document.body.style.cursor = '';
    }
  });

  /* ------------------------------------------------ row / cell handling */

  el['table-body'].addEventListener('click', function (event) {
    // Clicks inside an open cell editor belong to the editor, not the grid.
    if (event.target.closest('td.editing')) {
      return;
    }
    const td = event.target.closest('td');
    const tr = event.target.closest('tr.data-row');
    if (!tr) {
      return;
    }
    const pos = parseInt(tr.dataset.pos, 10);
    const row = state.filteredRows[pos];
    if (!row) {
      return;
    }

    // Ctrl+Click on a data cell filters by that value; Ctrl+Click on the row
    // number toggles selection instead.
    if ((event.ctrlKey || event.metaKey) && td && td.dataset.col) {
      filterByValue(td.dataset.col, row[td.dataset.col]);
      return;
    }

    if (event.shiftKey && state.lastClickedPos >= 0) {
      const from = Math.min(state.lastClickedPos, pos);
      const to = Math.max(state.lastClickedPos, pos);
      state.selectedRows.clear();
      for (let i = from; i <= to; i++) {
        state.selectedRows.add(state.filteredRows[i]);
      }
    } else if (event.ctrlKey || event.metaKey) {
      if (state.selectedRows.has(row)) {
        state.selectedRows.delete(row);
      } else {
        state.selectedRows.add(row);
      }
      state.lastClickedPos = pos;
    } else {
      state.selectedRows.clear();
      state.selectedRows.add(row);
      state.lastClickedPos = pos;
    }
    updateSelectionUi();
  });

  el['table-body'].addEventListener('dblclick', function (event) {
    if (state.readOnly) {
      return;
    }
    const td = event.target.closest('td[data-col]');
    const tr = event.target.closest('tr.data-row');
    if (!td || !tr) {
      return;
    }
    startEdit(parseInt(tr.dataset.pos, 10), td.dataset.col);
  });

  el['table-body'].addEventListener('contextmenu', function (event) {
    const td = event.target.closest('td');
    const tr = event.target.closest('tr.data-row');
    if (!tr) {
      return;
    }
    event.preventDefault();
    const pos = parseInt(tr.dataset.pos, 10);
    const row = state.filteredRows[pos];
    if (!state.selectedRows.has(row)) {
      state.selectedRows.clear();
      state.selectedRows.add(row);
      state.lastClickedPos = pos;
      updateSelectionUi();
    }
    const col = td && td.dataset.col;
    showContextMenu(event.clientX, event.clientY, [
      { label: 'Copy Row(s) as TSV', action: copySelectedAsTsv },
      {
        label: col ? 'Filter by "' + truncate(cellText(row[col]), 22) + '"' : 'Filter by value',
        disabled: !col,
        action: function () { filterByValue(col, row[col]); },
      },
      { separator: true },
      { label: 'Duplicate Row(s)', disabled: state.readOnly, action: duplicateSelectedRows },
      { label: 'Delete Row(s)', disabled: state.readOnly, action: deleteSelectedRows },
    ]);
  });

  function truncate(text, max) {
    return text.length > max ? text.slice(0, max - 1) + '\u2026' : text;
  }

  function filterByValue(col, value) {
    state.valueFilters[col] = new Set([rawText(value)]);
    el['table-container'].scrollTop = 0;
    buildHeader();
    applyFiltersAndRender();
  }

  function duplicateSelectedRows() {
    if (state.readOnly || !state.selectedRows.size) {
      return;
    }
    const doomed = state.selectedRows;
    commitMutation(function () {
      const out = [];
      state.allRows.forEach(function (row) {
        out.push(row);
        if (doomed.has(row)) {
          const copy = { __idx: row.__idx };
          state.columns.forEach(function (c) { copy[c] = row[c]; });
          out.push(copy);
        }
      });
      state.allRows = out;
      state.selectedRows = new Set();
    });
  }

  /* --------------------------------------------------- inline cell edit */

  function startEdit(pos, col) {
    if (state.editing) {
      commitEdit();
    }
    const row = state.filteredRows[pos];
    if (!row) {
      return;
    }
    const tr = el['table-body'].querySelector('tr[data-pos="' + pos + '"]');
    if (!tr) {
      return;
    }
    const td = tr.querySelector('td[data-col="' + cssEscape(col) + '"]');
    if (!td) {
      return;
    }

    state.editing = { row: row, col: col, pos: pos };
    const original = row[col];
    td.classList.add('editing');
    td.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = original === null || original === undefined ? '' : String(original);
    td.appendChild(input);
    try {
      input.focus({ preventScroll: true });
    } catch (err) {
      input.focus();
    }
    input.select();

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitEdit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelEdit();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const cols = visibleColumns();
        const next = cols.indexOf(col) + 1;
        commitEdit();
        if (next < cols.length) {
          startEdit(pos, cols[next]);
        }
      }
    });
    input.addEventListener('blur', function () {
      if (state.editing && state.editing.row === row && state.editing.col === col) {
        commitEdit();
      }
    });
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  /** Auto type-detect: number / bool / null / string. */
  function coerceValue(text) {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') {
      return null;
    }
    if (trimmed.toLowerCase() === 'true') {
      return true;
    }
    if (trimmed.toLowerCase() === 'false') {
      return false;
    }
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
      return Number(trimmed);
    }
    return text;
  }

  /** Restore a cell to its normal rendering without rebuilding the body. */
  function paintCell(td, row, col) {
    const info = cellRender(row[col], state.searchTerm ? state.searchTerm.toLowerCase() : '');
    td.className = info.cls;
    td.textContent = info.text;
    td.title = info.text;
    td.style.width = colWidth(col) + 'px';
  }

  /**
   * True when writing to `col` could move the row or change which rows are
   * showing. When it cannot, the commit repaints one cell instead of the whole
   * body - which also keeps the next double-click's target attached.
   */
  function editAffectsLayout(col) {
    return Boolean(
      state.searchTerm || state.sqlQuery || state.valueFilters[col] || state.sortColumn === col
    );
  }

  function commitEdit() {
    const editing = state.editing;
    if (!editing) {
      return;
    }
    const td = el['table-body'].querySelector('td.editing');
    const input = td && td.querySelector('input');
    state.editing = null;
    if (!td || !input) {
      render();
      return;
    }

    const next = coerceValue(input.value);
    const prev = editing.row[editing.col];
    if (next === prev) {
      paintCell(td, editing.row, editing.col);
      return;
    }

    if (!state.undoStack.length) {
      state.undoStack.push(snapshot());
    }
    editing.row[editing.col] = next;
    pushUndo();

    if (editAffectsLayout(editing.col)) {
      applyFiltersAndRender();
    } else {
      paintCell(td, editing.row, editing.col);
      updateStatusBar();
    }
  }

  function cancelEdit() {
    const editing = state.editing;
    state.editing = null;
    const td = el['table-body'].querySelector('td.editing');
    if (td && editing) {
      paintCell(td, editing.row, editing.col);
    } else {
      render();
    }
  }

  /* ------------------------------------------------ overlay/panel system */

  function closeOverlays() {
    document.querySelectorAll('.overlay').forEach(function (node) {
      node.remove();
    });
  }

  function closeContextMenus() {
    document.querySelectorAll('.context-menu').forEach(function (node) {
      node.remove();
    });
  }

  /**
   * Build a modal overlay+panel. `options.controls` and `options.footer` are
   * optional arrays of elements.
   */
  function createPanel(title, options) {
    closeOverlays();
    const opts = options || {};
    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    const panel = document.createElement('div');
    panel.className = 'panel';
    if (opts.width) {
      panel.style.width = opts.width;
    }

    const header = document.createElement('div');
    header.className = 'panel-header';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = title;
    const close = document.createElement('button');
    close.className = 'panel-close';
    close.textContent = '\u00d7';
    close.title = 'Close';
    close.addEventListener('click', closeOverlays);
    header.appendChild(titleSpan);
    header.appendChild(close);
    panel.appendChild(header);

    let controls = null;
    if (opts.controls) {
      controls = document.createElement('div');
      controls.className = 'panel-controls';
      panel.appendChild(controls);
    }

    const body = document.createElement('div');
    body.className = 'panel-body';
    panel.appendChild(body);

    let footer = null;
    if (opts.footer) {
      footer = document.createElement('div');
      footer.className = 'panel-apply';
      panel.appendChild(footer);
    }

    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', function (event) {
      if (event.target === overlay) {
        closeOverlays();
      }
    });
    document.body.appendChild(overlay);

    return { overlay: overlay, panel: panel, controls: controls, body: body, footer: footer };
  }

  function makeButton(label, onClick, className) {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (className) {
      btn.className = className;
    }
    btn.addEventListener('click', onClick);
    return btn;
  }

  /* ------------------------------------------------------ context menus */

  function showContextMenu(x, y, items) {
    closeContextMenus();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    items.forEach(function (item) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'context-menu-separator';
        menu.appendChild(sep);
        return;
      }
      const node = document.createElement('div');
      node.className = 'context-menu-item' + (item.disabled ? ' disabled' : '');
      node.textContent = item.label;
      node.addEventListener('click', function () {
        closeContextMenus();
        item.action();
      });
      menu.appendChild(node);
    });
    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 4) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 4) + 'px';
  }

  document.addEventListener('click', function (event) {
    if (!event.target.closest('.context-menu')) {
      closeContextMenus();
    }
  });

  /* -------------------------------------------------- columns visibility */

  function openColumnsPanel() {
    const ui = createPanel('Columns', { controls: true, footer: true, width: '340px' });

    ui.controls.appendChild(makeButton('Show All', function () {
      ui.body.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = true; });
    }));
    ui.controls.appendChild(makeButton('Hide All', function () {
      ui.body.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = false; });
    }));

    const list = document.createElement('div');
    list.className = 'panel-list';
    state.columns.forEach(function (col) {
      const item = document.createElement('label');
      item.className = 'panel-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !state.hiddenColumns.has(col);
      cb.dataset.col = col;
      const span = document.createElement('span');
      span.textContent = col;
      const type = document.createElement('span');
      type.className = 'item-count';
      type.textContent = columnType(col);
      item.appendChild(cb);
      item.appendChild(span);
      item.appendChild(type);
      list.appendChild(item);
    });
    ui.body.appendChild(list);

    ui.footer.appendChild(makeButton('Apply', function () {
      state.hiddenColumns.clear();
      list.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
        if (!cb.checked) {
          state.hiddenColumns.add(cb.dataset.col);
        }
      });
      closeOverlays();
      buildHeader();
      applyFiltersAndRender();
    }, 'panel-apply-btn'));
  }

  /* ---------------------------------------------- filter by unique values */

  function uniqueValueCounts(col, rows) {
    const counts = new Map();
    for (let i = 0; i < rows.length; i++) {
      const key = rawText(rows[i][col]);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  function openFilterPanel(col) {
    const counts = uniqueValueCounts(col, state.allRows);
    const entries = Array.from(counts.entries()).sort(function (a, b) { return b[1] - a[1]; });
    const active = state.valueFilters[col];

    const ui = createPanel('Filter: ' + col, { controls: true, footer: true, width: '420px' });

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Find value\u2026';
    ui.controls.appendChild(search);
    ui.controls.appendChild(makeButton('All', function () {
      ui.body.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
        if (cb.parentElement.style.display !== 'none') { cb.checked = true; }
      });
    }));
    ui.controls.appendChild(makeButton('None', function () {
      ui.body.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
        if (cb.parentElement.style.display !== 'none') { cb.checked = false; }
      });
    }));
    const note = document.createElement('label');
    note.textContent = entries.length.toLocaleString() + ' unique values';
    ui.controls.appendChild(note);

    const list = document.createElement('div');
    list.className = 'panel-list';
    entries.forEach(function (entry) {
      const item = document.createElement('label');
      item.className = 'panel-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !active || active.has(entry[0]);
      cb.dataset.value = entry[0];
      const span = document.createElement('span');
      span.textContent = entry[0] === '' ? '(null / empty)' : entry[0];
      span.title = span.textContent;
      const count = document.createElement('span');
      count.className = 'item-count';
      count.textContent = entry[1].toLocaleString();
      item.appendChild(cb);
      item.appendChild(span);
      item.appendChild(count);
      list.appendChild(item);
    });
    ui.body.appendChild(list);

    search.addEventListener('input', function () {
      const needle = search.value.toLowerCase();
      list.querySelectorAll('.panel-item').forEach(function (item) {
        const text = item.querySelector('span').textContent.toLowerCase();
        item.style.display = text.indexOf(needle) === -1 ? 'none' : '';
      });
    });

    ui.footer.appendChild(makeButton('Clear Filter', function () {
      delete state.valueFilters[col];
      closeOverlays();
      buildHeader();
      applyFiltersAndRender();
    }));
    ui.footer.appendChild(makeButton('Apply', function () {
      const allowed = new Set();
      let total = 0;
      list.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
        total++;
        if (cb.checked) {
          allowed.add(cb.dataset.value);
        }
      });
      if (allowed.size === total) {
        delete state.valueFilters[col];
      } else {
        state.valueFilters[col] = allowed;
      }
      closeOverlays();
      el['table-container'].scrollTop = 0;
      buildHeader();
      applyFiltersAndRender();
    }));
  }

  /* ---------------------------------------------------------- col stats */

  function numericStats(values) {
    const n = values.length;
    if (!n) {
      return null;
    }
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += sorted[i];
    }
    const mean = sum / n;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      sq += (sorted[i] - mean) * (sorted[i] - mean);
    }
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    return {
      count: n,
      min: sorted[0],
      max: sorted[n - 1],
      mean: mean,
      median: median,
      stddev: Math.sqrt(sq / n),
    };
  }

  function columnValues(col, rows) {
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const v = rows[i][col];
      if (v !== null && v !== undefined) {
        out.push(v);
      }
    }
    return out;
  }

  function openStatsPanel(col) {
    const rows = state.filteredRows;
    const values = columnValues(col, rows);
    const nulls = rows.length - values.length;
    const numeric = values.filter(isNumericValue);
    const ui = createPanel('Column Stats: ' + col, { width: '420px' });

    const table = document.createElement('table');
    table.className = 'stats-table';
    const lines = [
      ['Type', columnType(col)],
      ['Rows (filtered)', rows.length.toLocaleString()],
      ['Non-null', values.length.toLocaleString()],
      ['Null', nulls.toLocaleString()],
      ['Unique', new Set(values.map(rawText)).size.toLocaleString()],
    ];

    if (numeric.length) {
      const s = numericStats(numeric);
      lines.push(['Min', formatNumber(s.min)]);
      lines.push(['Max', formatNumber(s.max)]);
      lines.push(['Mean', formatNumber(s.mean)]);
      lines.push(['Median', formatNumber(s.median)]);
      lines.push(['Std Dev', formatNumber(s.stddev)]);
    } else {
      const counts = uniqueValueCounts(col, rows);
      const top = Array.from(counts.entries())
        .sort(function (a, b) { return b[1] - a[1]; })
        .slice(0, 5);
      top.forEach(function (entry, i) {
        lines.push([
          'Top ' + (i + 1),
          (entry[0] === '' ? '(null / empty)' : entry[0]) + ' \u2014 ' + entry[1].toLocaleString(),
        ]);
      });
    }

    table.innerHTML = lines
      .map(function (line) {
        return '<tr><th>' + escapeHtml(line[0]) + '</th><td class="num">' +
          escapeHtml(line[1]) + '</td></tr>';
      })
      .join('');
    ui.body.appendChild(table);
  }

  /* --------------------------------------------------------- Quick Plot */

  const plotState = {
    column: null,
    chartType: 'histogram',
    bins: 30,
    maxSlices: 10,
    zMin: null,
    zMax: null,
    globalMin: null,
    globalMax: null,
    values: [],
    counts: null,
    ui: null,
  };

  function openPlotPanel(preferredColumn) {
    const cols = visibleColumns();
    if (!cols.length) {
      return;
    }
    const col = preferredColumn || plotState.column || cols[0];
    plotState.column = cols.indexOf(col) === -1 ? cols[0] : col;

    // 'Plot Column' auto-picks histogram when the column is mostly numeric.
    const sample = columnValues(plotState.column, state.filteredRows);
    const numericCount = sample.filter(isNumericValue).length;
    plotState.chartType = numericCount > sample.length / 2 ? 'histogram' : 'pie';

    const ui = createPanel('Quick Plot', { controls: true, footer: true, width: '820px' });
    plotState.ui = ui;

    const colSelect = document.createElement('select');
    cols.forEach(function (c) {
      const option = document.createElement('option');
      option.value = c;
      option.textContent = c;
      option.selected = c === plotState.column;
      colSelect.appendChild(option);
    });

    const typeSelect = document.createElement('select');
    [['histogram', 'Histogram'], ['pie', 'Pie']].forEach(function (pair) {
      const option = document.createElement('option');
      option.value = pair[0];
      option.textContent = pair[1];
      option.selected = pair[0] === plotState.chartType;
      typeSelect.appendChild(option);
    });

    const binsLabel = document.createElement('label');
    binsLabel.textContent = 'Bins';
    const binsInput = document.createElement('input');
    binsInput.type = 'range';
    binsInput.min = '5';
    binsInput.max = '100';
    binsInput.value = String(plotState.bins);
    const binsValue = document.createElement('label');
    binsValue.textContent = String(plotState.bins);

    const slicesLabel = document.createElement('label');
    slicesLabel.textContent = 'Max slices';
    const slicesInput = document.createElement('input');
    slicesInput.type = 'range';
    slicesInput.min = '3';
    slicesInput.max = '30';
    slicesInput.value = String(plotState.maxSlices);
    const slicesValue = document.createElement('label');
    slicesValue.textContent = String(plotState.maxSlices);

    ui.controls.appendChild(colSelect);
    ui.controls.appendChild(typeSelect);
    ui.controls.appendChild(binsLabel);
    ui.controls.appendChild(binsInput);
    ui.controls.appendChild(binsValue);
    ui.controls.appendChild(slicesLabel);
    ui.controls.appendChild(slicesInput);
    ui.controls.appendChild(slicesValue);

    const zoomOut = makeButton('\u2212', function () { zoomPlot(1.3, 0.5); });
    const zoomIn = makeButton('+', function () { zoomPlot(0.77, 0.5); });
    const zoomReset = makeButton('Reset', function () {
      plotState.zMin = plotState.globalMin;
      plotState.zMax = plotState.globalMax;
      drawPlot();
    });
    ui.controls.appendChild(zoomOut);
    ui.controls.appendChild(zoomIn);
    ui.controls.appendChild(zoomReset);

    const area = document.createElement('div');
    area.className = 'plot-area';
    ui.body.appendChild(area);

    ui.footer.appendChild(makeButton('Export SVG', exportPlotSvg));
    ui.footer.appendChild(makeButton('Close', closeOverlays));

    function toggleControls() {
      const histogram = plotState.chartType === 'histogram';
      [binsLabel, binsInput, binsValue, zoomOut, zoomIn, zoomReset].forEach(function (node) {
        node.classList.toggle('hidden', !histogram);
      });
      [slicesLabel, slicesInput, slicesValue].forEach(function (node) {
        node.classList.toggle('hidden', histogram);
      });
    }

    colSelect.addEventListener('change', function () {
      plotState.column = colSelect.value;
      resetPlotData();
      drawPlot();
    });
    typeSelect.addEventListener('change', function () {
      plotState.chartType = typeSelect.value;
      toggleControls();
      resetPlotData();
      drawPlot();
    });
    binsInput.addEventListener('input', function () {
      plotState.bins = parseInt(binsInput.value, 10);
      binsValue.textContent = binsInput.value;
      drawPlot();
    });
    slicesInput.addEventListener('input', function () {
      plotState.maxSlices = parseInt(slicesInput.value, 10);
      slicesValue.textContent = slicesInput.value;
      drawPlot();
    });

    toggleControls();
    resetPlotData();
    drawPlot();
  }

  /** All plotting works on the currently filtered rows, not every row. */
  function resetPlotData() {
    const raw = columnValues(plotState.column, state.filteredRows);
    if (plotState.chartType === 'histogram') {
      plotState.values = raw.filter(isNumericValue);
      if (plotState.values.length) {
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < plotState.values.length; i++) {
          const v = plotState.values[i];
          if (v < min) { min = v; }
          if (v > max) { max = v; }
        }
        if (min === max) {
          min -= 0.5;
          max += 0.5;
        }
        plotState.globalMin = min;
        plotState.globalMax = max;
        plotState.zMin = min;
        plotState.zMax = max;
      }
    } else {
      plotState.counts = uniqueValueCounts(plotState.column, state.filteredRows);
    }
  }

  function zoomPlot(factor, anchorRatio) {
    if (plotState.globalMin === null) {
      return;
    }
    const range = plotState.zMax - plotState.zMin;
    const anchor = plotState.zMin + range * anchorRatio;
    let newRange = range * factor;
    const globalRange = plotState.globalMax - plotState.globalMin;

    // Snap back to unzoomed once the window becomes negligibly small.
    if (newRange < globalRange * 1e-4) {
      plotState.zMin = plotState.globalMin;
      plotState.zMax = plotState.globalMax;
      drawPlot();
      return;
    }
    if (newRange > globalRange) {
      newRange = globalRange;
    }
    let min = anchor - (anchor - plotState.zMin) * (newRange / range);
    let max = min + newRange;
    if (min < plotState.globalMin) {
      min = plotState.globalMin;
      max = min + newRange;
    }
    if (max > plotState.globalMax) {
      max = plotState.globalMax;
      min = max - newRange;
    }
    plotState.zMin = min;
    plotState.zMax = max;
    drawPlot();
  }

  function drawPlot() {
    const area = plotState.ui && plotState.ui.body.querySelector('.plot-area');
    if (!area) {
      return;
    }
    area.innerHTML =
      plotState.chartType === 'histogram' ? renderHistogram() : renderPie();
    wirePlotInteractions(area);
  }

  const PLOT_W = 760;
  const PLOT_H = 380;
  const PAD = { top: 38, right: 18, bottom: 46, left: 62 };

  function renderHistogram() {
    const values = plotState.values;
    if (!values.length) {
      return '<div class="diff-empty">No numeric values in this column.</div>';
    }
    const zMin = plotState.zMin;
    const zMax = plotState.zMax;
    const binCount = plotState.bins;
    const binWidth = (zMax - zMin) / binCount;
    const bins = new Array(binCount).fill(0);
    let visible = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v < zMin || v > zMax) {
        continue;
      }
      visible++;
      let index = Math.floor((v - zMin) / binWidth);
      if (index >= binCount) {
        index = binCount - 1;
      }
      if (index < 0) {
        index = 0;
      }
      bins[index]++;
    }

    const maxCount = Math.max.apply(null, bins) || 1;
    const plotW = PLOT_W - PAD.left - PAD.right;
    const plotH = PLOT_H - PAD.top - PAD.bottom;
    const scaleY = function (count) { return PAD.top + plotH - (count / maxCount) * plotH; };
    const scaleX = function (value) { return PAD.left + ((value - zMin) / (zMax - zMin)) * plotW; };

    const visibleValues = values.filter(function (v) { return v >= zMin && v <= zMax; });
    const stats = numericStats(visibleValues) || numericStats(values);

    const parts = [];
    parts.push(
      '<svg id="plot-svg" xmlns="http://www.w3.org/2000/svg" width="' + PLOT_W +
      '" height="' + PLOT_H + '" viewBox="0 0 ' + PLOT_W + ' ' + PLOT_H + '">'
    );
    parts.push(
      '<text class="plot-title" x="' + PAD.left + '" y="18">' +
      escapeHtml(plotState.column) + '</text>'
    );
    parts.push(
      '<text class="plot-subtitle" x="' + PAD.left + '" y="31">' +
      visible.toLocaleString() + ' of ' + values.length.toLocaleString() +
      ' values visible \u00b7 ' + binCount + ' bins \u00b7 scroll to zoom, drag to pan</text>'
    );

    // Horizontal gridlines + Y axis count labels
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const count = (maxCount / yTicks) * i;
      const y = scaleY(count);
      parts.push(
        '<line class="plot-grid-line" x1="' + PAD.left + '" y1="' + y + '" x2="' +
        (PAD.left + plotW) + '" y2="' + y + '"/>'
      );
      parts.push(
        '<text class="plot-tick-label" x="' + (PAD.left - 6) + '" y="' + (y + 3) +
        '" text-anchor="end">' + Math.round(count).toLocaleString() + '</text>'
      );
    }

    // Bars
    const barW = plotW / binCount;
    for (let i = 0; i < binCount; i++) {
      const count = bins[i];
      if (!count) {
        continue;
      }
      const x = PAD.left + i * barW;
      const y = scaleY(count);
      const lo = zMin + i * binWidth;
      const hi = lo + binWidth;
      parts.push(
        '<rect x="' + (x + 0.5) + '" y="' + y + '" width="' + Math.max(1, barW - 1) +
        '" height="' + (PAD.top + plotH - y) + '" fill="' + PLOT_COLORS[0] + '">' +
        '<title>[' + formatNumber(lo) + ', ' + formatNumber(hi) + ') \u2014 ' +
        count.toLocaleString() + '</title></rect>'
      );
    }

    // Mean line
    if (stats && stats.mean >= zMin && stats.mean <= zMax) {
      const mx = scaleX(stats.mean);
      parts.push(
        '<line class="plot-mean-line" x1="' + mx + '" y1="' + PAD.top + '" x2="' + mx +
        '" y2="' + (PAD.top + plotH) + '"/>'
      );
      parts.push(
        '<text class="plot-mean-label" x="' + (mx + 4) + '" y="' + (PAD.top + 10) +
        '">\u03bc = ' + formatNumber(stats.mean) + '</text>'
      );
    }

    // Axis lines
    parts.push(
      '<line class="plot-axis-line" x1="' + PAD.left + '" y1="' + (PAD.top + plotH) +
      '" x2="' + (PAD.left + plotW) + '" y2="' + (PAD.top + plotH) + '"/>'
    );
    parts.push(
      '<line class="plot-axis-line" x1="' + PAD.left + '" y1="' + PAD.top + '" x2="' +
      PAD.left + '" y2="' + (PAD.top + plotH) + '"/>'
    );

    // X axis tick labels
    const xTicks = 6;
    for (let i = 0; i <= xTicks; i++) {
      const value = zMin + ((zMax - zMin) / xTicks) * i;
      const x = scaleX(value);
      parts.push(
        '<text class="plot-tick-label" x="' + x + '" y="' + (PAD.top + plotH + 14) +
        '" text-anchor="middle">' + escapeHtml(formatNumber(value)) + '</text>'
      );
    }
    parts.push(
      '<text class="plot-axis-label" x="' + (PAD.left + plotW / 2) + '" y="' +
      (PLOT_H - 8) + '" text-anchor="middle">' + escapeHtml(plotState.column) + '</text>'
    );
    parts.push('</svg>');

    if (stats) {
      parts.push(
        '<div class="plot-stats">' +
        '<span>Count <b>' + stats.count.toLocaleString() + '</b></span>' +
        '<span>Min <b>' + formatNumber(stats.min) + '</b></span>' +
        '<span>Max <b>' + formatNumber(stats.max) + '</b></span>' +
        '<span>Mean <b>' + formatNumber(stats.mean) + '</b></span>' +
        '<span>Median <b>' + formatNumber(stats.median) + '</b></span>' +
        '<span>StdDev <b>' + formatNumber(stats.stddev) + '</b></span>' +
        '</div>'
      );
    }
    return parts.join('');
  }

  function renderPie() {
    const counts = plotState.counts || new Map();
    const entries = Array.from(counts.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, plotState.maxSlices);
    if (!entries.length) {
      return '<div class="diff-empty">No values in this column.</div>';
    }
    const total = entries.reduce(function (sum, e) { return sum + e[1]; }, 0);

    const size = 340;
    const cx = size / 2;
    const cy = size / 2 + 14;
    const radius = size / 2 - 26;

    const parts = [];
    parts.push(
      '<svg id="plot-svg" xmlns="http://www.w3.org/2000/svg" width="' + size +
      '" height="' + (size + 18) + '" viewBox="0 0 ' + size + ' ' + (size + 18) + '">'
    );
    parts.push(
      '<text class="plot-title" x="' + cx + '" y="16" text-anchor="middle">' +
      escapeHtml(plotState.column) + '</text>'
    );

    let angle = -Math.PI / 2;
    entries.forEach(function (entry, i) {
      const fraction = entry[1] / total;
      const sweep = fraction * Math.PI * 2;
      const end = angle + sweep;
      const x1 = cx + radius * Math.cos(angle);
      const y1 = cy + radius * Math.sin(angle);
      const x2 = cx + radius * Math.cos(end);
      const y2 = cy + radius * Math.sin(end);
      const largeArc = sweep > Math.PI ? 1 : 0;
      const color = PLOT_COLORS[i % PLOT_COLORS.length];
      const label = entry[0] === '' ? '(null / empty)' : entry[0];
      const pct = (fraction * 100).toFixed(1);

      const d = entries.length === 1
        ? 'M ' + cx + ' ' + (cy - radius) + ' A ' + radius + ' ' + radius +
          ' 0 1 1 ' + (cx - 0.01) + ' ' + (cy - radius) + ' Z'
        : 'M ' + cx + ' ' + cy + ' L ' + x1 + ' ' + y1 + ' A ' + radius + ' ' + radius +
          ' 0 ' + largeArc + ' 1 ' + x2 + ' ' + y2 + ' Z';

      parts.push(
        '<path d="' + d + '" fill="' + color + '" stroke="var(--bg-primary)" stroke-width="1">' +
        '<title>' + escapeHtml(label) + ' \u2014 ' + entry[1].toLocaleString() +
        ' (' + pct + '%)</title></path>'
      );

      // Label slices that are big enough to hold text.
      if (fraction >= 0.04) {
        const mid = angle + sweep / 2;
        const lx = cx + radius * 0.65 * Math.cos(mid);
        const ly = cy + radius * 0.65 * Math.sin(mid);
        parts.push(
          '<text x="' + lx + '" y="' + ly + '" text-anchor="middle" fill="#ffffff" ' +
          'font-size="10" font-weight="600">' + pct + '%</text>'
        );
      }
      angle = end;
    });
    parts.push('</svg>');

    parts.push('<div class="pie-legend">');
    entries.forEach(function (entry, i) {
      const label = entry[0] === '' ? '(null / empty)' : entry[0];
      const pct = ((entry[1] / total) * 100).toFixed(1);
      parts.push(
        '<div class="pie-legend-item" title="' + escapeHtml(label) + '">' +
        '<span class="pie-legend-swatch" style="background:' +
        PLOT_COLORS[i % PLOT_COLORS.length] + '"></span>' +
        '<span class="pie-legend-label">' + escapeHtml(truncate(label, 24)) + '</span>' +
        '<span class="pie-legend-count">' + entry[1].toLocaleString() + ' \u00b7 ' + pct + '%</span>' +
        '</div>'
      );
    });
    parts.push('</div>');
    return parts.join('');
  }

  function wirePlotInteractions(area) {
    const svg = area.querySelector('#plot-svg');
    if (!svg || plotState.chartType !== 'histogram') {
      return;
    }

    svg.addEventListener('wheel', function (event) {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const plotW = PLOT_W - PAD.left - PAD.right;
      const scale = rect.width / PLOT_W;
      const px = (event.clientX - rect.left) / scale - PAD.left;
      const ratio = Math.max(0, Math.min(1, px / plotW));
      zoomPlot(event.deltaY > 0 ? 1.3 : 0.77, ratio);
    }, { passive: false });

    let panning = null;
    svg.addEventListener('mousedown', function (event) {
      panning = { x: event.clientX, zMin: plotState.zMin, zMax: plotState.zMax };
      svg.classList.add('panning');
    });
    window.addEventListener('mousemove', function onMove(event) {
      if (!panning || !svg.isConnected) {
        return;
      }
      const rect = svg.getBoundingClientRect();
      const plotW = PLOT_W - PAD.left - PAD.right;
      const scale = rect.width / PLOT_W;
      const range = panning.zMax - panning.zMin;
      const delta = ((event.clientX - panning.x) / scale / plotW) * range;
      let min = panning.zMin - delta;
      let max = panning.zMax - delta;
      if (min < plotState.globalMin) {
        min = plotState.globalMin;
        max = min + range;
      }
      if (max > plotState.globalMax) {
        max = plotState.globalMax;
        min = max - range;
      }
      plotState.zMin = min;
      plotState.zMax = max;
      drawPlot();
    });
    window.addEventListener('mouseup', function () {
      panning = null;
    });
  }

  function exportPlotSvg() {
    const svg = document.querySelector('#plot-svg');
    if (!svg) {
      return;
    }
    const text = new XMLSerializer().serializeToString(svg);
    const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    const link = document.createElement('a');
    link.href = uri;
    link.download = (plotState.column || 'chart') + '-' + plotState.chartType + '.svg';
    document.body.appendChild(link);
    link.click();
    link.remove();
    vscode.postMessage({
      type: 'info',
      text: 'Parquetly: chart exported as ' + link.download + '.',
    });
  }

  /* ------------------------------------------------------------ SQL bar */

  function toggleSqlBar() {
    let bar = document.querySelector('.sql-bar');
    if (bar) {
      bar.remove();
      if (state.sqlQuery) {
        state.sqlQuery = '';
        applyFiltersAndRender();
      }
      return;
    }
    bar = document.createElement('div');
    bar.className = 'sql-bar';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'sql-input';
    input.placeholder = 'WHERE Age > 30 AND Sex = \'female\' ORDER BY Fare DESC LIMIT 100';
    input.value = state.sqlQuery;

    const run = makeButton('Run', function () {
      state.sqlQuery = input.value.trim();
      el['table-container'].scrollTop = 0;
      applyFiltersAndRender();
    });
    const clear = makeButton('Clear', function () {
      input.value = '';
      state.sqlQuery = '';
      applyFiltersAndRender();
    });

    const hint = document.createElement('span');
    hint.className = 'sql-hint';
    hint.textContent = 'WHERE / ORDER BY / LIMIT \u2014 filters loaded rows, not real SQL';

    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        state.sqlQuery = input.value.trim();
        el['table-container'].scrollTop = 0;
        applyFiltersAndRender();
      }
    });

    bar.appendChild(input);
    bar.appendChild(run);
    bar.appendChild(clear);
    bar.appendChild(hint);
    el['table-container'].parentNode.insertBefore(bar, el['table-container']);
    input.focus();
  }

  const CONDITION_RE =
    /^(\w+)\s*(=|!=|<>|>=|<=|>|<|LIKE|NOT\s+LIKE|IS\s+NULL|IS\s+NOT\s+NULL|IN)\s*(.*)$/i;

  function stripQuotes(text) {
    const trimmed = text.trim();
    if (
      (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1)
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }

  function likeToRegExp(pattern) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
  }

  function evalCondition(row, token) {
    const match = token.trim().match(CONDITION_RE);
    if (!match) {
      throw new Error('Cannot parse condition: ' + token.trim());
    }
    const col = match[1];
    const op = match[2].toUpperCase().replace(/\s+/g, ' ');
    const rhs = match[3];
    const cell = row[col];

    switch (op) {
      case 'IS NULL':
        return cell === null || cell === undefined;
      case 'IS NOT NULL':
        return cell !== null && cell !== undefined;
      case 'LIKE':
        return likeToRegExp(stripQuotes(rhs)).test(rawText(cell));
      case 'NOT LIKE':
        return !likeToRegExp(stripQuotes(rhs)).test(rawText(cell));
      case 'IN': {
        const inner = rhs.trim().replace(/^\(/, '').replace(/\)$/, '');
        const set = inner.split(',').map(stripQuotes);
        return set.indexOf(rawText(cell)) !== -1;
      }
      case '=': {
        const value = stripQuotes(rhs);
        return rawText(cell) === value || Number(cell) === Number(value);
      }
      case '!=':
      case '<>': {
        const value = stripQuotes(rhs);
        return !(rawText(cell) === value || Number(cell) === Number(value));
      }
      case '>':
        return Number(cell) > Number(stripQuotes(rhs));
      case '<':
        return Number(cell) < Number(stripQuotes(rhs));
      case '>=':
        return Number(cell) >= Number(stripQuotes(rhs));
      case '<=':
        return Number(cell) <= Number(stripQuotes(rhs));
      default:
        throw new Error('Unsupported operator: ' + op);
    }
  }

  /**
   * Deliberately a mini-grammar, not real SQL: LIMIT and ORDER BY are stripped
   * first, then everything after WHERE is split on a single level of AND/OR
   * with no parentheses or precedence.
   */
  function runSqlQuery(rows, query) {
    try {
      let q = ' ' + query + ' ';

      let limit = null;
      const limitMatch = q.match(/LIMIT\s+(\d+)/i);
      if (limitMatch) {
        limit = parseInt(limitMatch[1], 10);
        q = q.replace(limitMatch[0], ' ');
      }

      let orderCol = null;
      let orderDir = 'ASC';
      const orderMatch = q.match(/ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
      if (orderMatch) {
        orderCol = orderMatch[1];
        orderDir = (orderMatch[2] || 'ASC').toUpperCase();
        q = q.replace(orderMatch[0], ' ');
      }

      let out = rows;
      const whereMatch = q.match(/WHERE\s+([\s\S]*)$/i);
      if (whereMatch) {
        const clause = whereMatch[1].trim();
        if (clause) {
          const tokens = clause.split(/\s+(AND|OR)\s+/i);
          out = rows.filter(function (row) {
            let result = evalCondition(row, tokens[0]);
            for (let i = 1; i < tokens.length; i += 2) {
              const joiner = tokens[i].toUpperCase();
              const next = evalCondition(row, tokens[i + 1]);
              result = joiner === 'AND' ? result && next : result || next;
            }
            return result;
          });
        }
      }

      if (orderCol) {
        const dir = orderDir === 'DESC' ? -1 : 1;
        out = out.slice().sort(function (a, b) {
          const va = a[orderCol];
          const vb = b[orderCol];
          if (isNullish(va) && isNullish(vb)) { return 0; }
          if (isNullish(va)) { return 1; }
          if (isNullish(vb)) { return -1; }
          if (typeof va === 'number' && typeof vb === 'number') {
            return (va - vb) * dir;
          }
          return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
        });
      }

      if (limit !== null) {
        out = out.slice(0, limit);
      }
      return out;
    } catch (err) {
      vscode.postMessage({ type: 'info', text: 'SQL Error: ' + err.message });
      return rows;
    }
  }

  /* ---------------------------------------------------------- diff view */

  function showDiffResults(data) {
    const diffCols = data.columns || [];
    const diffRows = data.rows || [];
    const cols = state.columns;
    const current = state.allRows;

    const commonCols = cols.filter(function (c) { return diffCols.indexOf(c) !== -1; });
    const addedCols = diffCols.filter(function (c) { return cols.indexOf(c) === -1; });
    const removedCols = cols.filter(function (c) { return diffCols.indexOf(c) === -1; });

    const compareCount = Math.min(current.length, diffRows.length, DIFF_ROW_LIMIT);
    const diffs = [];
    let changedCells = 0;

    for (let r = 0; r < compareCount; r++) {
      const rowA = current[r];
      const rowB = diffRows[r];
      for (let c = 0; c < commonCols.length; c++) {
        const col = commonCols[c];
        const va = rowA[col];
        const vb = rowB[diffCols.indexOf(col)];
        if (String(va ?? '') !== String(vb ?? '')) {
          changedCells++;
          if (diffs.length < DIFF_CELL_LIMIT) {
            diffs.push({ row: r + 1, col: col, from: va, to: vb });
          }
        }
      }
    }

    const addedRows = Math.max(0, diffRows.length - current.length);
    const removedRows = Math.max(0, current.length - diffRows.length);

    const ui = createPanel('Diff vs ' + data.fileName, { width: '880px' });

    const cards = [
      ['Current rows', current.length.toLocaleString()],
      ['Compare rows', diffRows.length.toLocaleString()],
      ['Changed cells', changedCells.toLocaleString()],
      ['Added rows', '+' + addedRows.toLocaleString()],
      ['Removed rows', '-' + removedRows.toLocaleString()],
    ];

    let html = '<div class="diff-cards">';
    cards.forEach(function (card) {
      html +=
        '<div class="diff-card"><span class="card-label">' + escapeHtml(card[0]) +
        '</span><span class="card-value">' + escapeHtml(card[1]) + '</span></div>';
    });
    html += '</div>';

    if (addedCols.length) {
      html +=
        '<div class="diff-section"><h4>Columns only in compare file (' + addedCols.length +
        ')</h4><div class="diff-to">' + escapeHtml(addedCols.join(', ')) + '</div></div>';
    }
    if (removedCols.length) {
      html +=
        '<div class="diff-section"><h4>Columns only in current file (' + removedCols.length +
        ')</h4><div class="diff-from">' + escapeHtml(removedCols.join(', ')) + '</div></div>';
    }

    html +=
      '<div class="diff-section"><h4>Changed cells' +
      (changedCells > diffs.length
        ? ' (first ' + diffs.length + ' of ' + changedCells.toLocaleString() + ')'
        : ' (' + diffs.length + ')') +
      '</h4>';

    if (!diffs.length) {
      html += '<div class="diff-empty">No cell differences within the compared range.</div>';
    } else {
      html +=
        '<table class="stats-table"><tr><th>Row</th><th>Column</th><th>Current</th>' +
        '<th>Compare</th></tr>';
      diffs.forEach(function (d) {
        html +=
          '<tr><td class="num">' + d.row + '</td><td>' + escapeHtml(d.col) +
          '</td><td class="diff-from">' + escapeHtml(cellText(d.from)) +
          '</td><td class="diff-to">' + escapeHtml(cellText(d.to)) + '</td></tr>';
      });
      html += '</table>';
    }
    html += '</div>';

    if (compareCount < Math.min(current.length, diffRows.length)) {
      html +=
        '<div class="diff-empty">Comparison limited to the first ' +
        DIFF_ROW_LIMIT.toLocaleString() + ' rows.</div>';
    }

    ui.body.innerHTML = html;
  }

  /* -------------------------------------------------- keyboard shortcuts */

  document.addEventListener('keydown', function (event) {
    const target = event.target;
    const typing =
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');

    if (event.key === 'Escape') {
      if (state.editing) {
        return; // handled by the cell editor itself
      }
      if (document.querySelector('.context-menu')) {
        closeContextMenus();
        event.preventDefault();
        return;
      }
      if (document.querySelector('.overlay')) {
        closeOverlays();
        event.preventDefault();
        return;
      }
      if (!el['goto-container'].classList.contains('hidden')) {
        el['goto-container'].classList.add('hidden');
      }
      return;
    }

    const ctrl = event.ctrlKey || event.metaKey;

    if (ctrl && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault();
      el['search-input'].focus();
      el['search-input'].select();
      return;
    }
    if (ctrl && (event.key === 'g' || event.key === 'G')) {
      event.preventDefault();
      toggleGoto();
      return;
    }
    if (ctrl && (event.key === 'q' || event.key === 'Q')) {
      event.preventDefault();
      toggleSqlBar();
      return;
    }
    if (ctrl && (event.key === 'c' || event.key === 'C') && !typing) {
      event.preventDefault();
      copySelectedAsTsv();
      return;
    }
    if (ctrl && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault();
      undo();
      return;
    }
    if (ctrl && (event.key === 'y' || event.key === 'Y')) {
      event.preventDefault();
      redo();
      return;
    }
    if (event.key === 'Delete' && !typing) {
      event.preventDefault();
      deleteSelectedRows();
    }
  });

  /* -------------------------------------------------------------- start */

  setReadOnly(true);
  updateUndoRedoButtons();
  vscode.postMessage({ type: 'ready' });
})();
