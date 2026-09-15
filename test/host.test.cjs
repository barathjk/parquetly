/* Drive the bundled extension host (dist/extension.js) with a stubbed vscode module. */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJ = path.resolve(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'parquetly-host-test');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(`${PROJ}/inputs/titanic.parquet`, path.join(OUT, 'titanic.parquet'));
fs.copyFileSync(`${PROJ}/inputs/titanic.parquet`, path.join(OUT, 'other.parquet'));

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

// ---------------------------------------------------------------- vscode stub
const notifications = [];
let openDialogResult = null;
let saveDialogResult = null;
let lastSaveOptions = null;
let clipboard = '';

class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.path = fsPath.replace(/\\/g, '/'); this.scheme = 'file'; }
  static file(p) { return new Uri(p); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return 'file://' + this.path; }
}

const registered = { editors: {}, commands: {} };

const vscode = {
  Uri,
  Disposable: class { constructor(fn) { this.dispose = fn || (() => {}); } },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
  window: {
    registerCustomEditorProvider: (viewType, provider, opts) => {
      registered.editors[viewType] = { provider, opts };
      return { dispose() {} };
    },
    showOpenDialog: async () => openDialogResult,
    showSaveDialog: async opts => { lastSaveOptions = opts; return saveDialogResult; },
    showInformationMessage: msg => { notifications.push(['info', msg]); },
    showErrorMessage: msg => { notifications.push(['error', msg]); },
    setStatusBarMessage: msg => { notifications.push(['status', msg]); },
  },
  commands: {
    registerCommand: (id, fn) => { registered.commands[id] = fn; return { dispose() {} }; },
    executeCommand: async (...args) => { registered.lastExecute = args; },
  },
  workspace: {
    fs: { readFile: async uri => new Uint8Array(fs.readFileSync(uri.fsPath)) },
  },
  env: { clipboard: { writeText: async text => { clipboard = text; } } },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return origLoad.apply(this, arguments);
};

// ---------------------------------------------------------------- activate
const ext = require(`${PROJ}/dist/extension.js`);
const context = { subscriptions: [], extensionUri: Uri.file(PROJ) };
ext.activate(context);

check('activate registers the custom editor viewType',
  !!registered.editors['parquetly.parquetEditor']);
check('custom editor sets retainContextWhenHidden',
  registered.editors['parquetly.parquetEditor'].opts.webviewOptions.retainContextWhenHidden === true);
check('activate registers parquetly.openFile', typeof registered.commands['parquetly.openFile'] === 'function');

// openFile command -> open dialog -> vscode.openWith
openDialogResult = [Uri.file(path.join(OUT, 'titanic.parquet'))];
(async () => {
  await registered.commands['parquetly.openFile']();
  check('openFile runs vscode.openWith with the parquet viewType',
    registered.lastExecute && registered.lastExecute[0] === 'vscode.openWith' && registered.lastExecute[2] === 'parquetly.parquetEditor',
    registered.lastExecute ? registered.lastExecute.join(', ') : 'not called');

  // ------------------------------------------------------------ resolve editor
  const provider = registered.editors['parquetly.parquetEditor'].provider;
  const docUri = Uri.file(path.join(OUT, 'titanic.parquet'));
  const doc = provider.openCustomDocument(docUri);
  check('openCustomDocument returns a document for the uri', doc.uri.fsPath === docUri.fsPath);

  const sent = [];
  let onMessage = null;
  const panel = {
    webview: {
      options: null,
      html: '',
      cspSource: 'vscode-webview://test',
      asWebviewUri: uri => ({ toString: () => 'vscode-resource:' + uri.path }),
      postMessage: async m => { sent.push(m); return true; },
      onDidReceiveMessage: fn => { onMessage = fn; return { dispose() {} }; },
    },
  };

  await provider.resolveCustomEditor(doc, panel, {});
  const html = panel.webview.html;

  check('webview scripts are enabled', panel.webview.options.enableScripts === true);
  check('localResourceRoots is limited to media/', panel.webview.options.localResourceRoots.length === 1 &&
    panel.webview.options.localResourceRoots[0].fsPath.endsWith('media'));

  const nonce = (html.match(/nonce-([A-Za-z0-9]+)/) || [])[1];
  check('CSP includes a nonce and default-src none', !!nonce && html.includes("default-src 'none'"), nonce);
  check('script tag carries the same nonce', html.includes(`<script nonce="${nonce}"`));
  check('HTML links media/styles.css and media/main.js',
    html.includes('vscode-resource:') && html.includes('styles.css') && html.includes('main.js'));

  const requiredIds = ['app-title', 'file-info', 'mode-label', 'read-mode-toggle', 'search-input',
    'btn-clear-filter', 'btn-goto', 'goto-container', 'goto-input', 'btn-columns', 'btn-plot',
    'btn-sql', 'btn-diff', 'btn-add-row', 'btn-delete-row', 'btn-undo', 'btn-redo',
    'btn-export-csv', 'btn-save', 'loading', 'error-message', 'data-table', 'table-head',
    'table-body', 'status-rows', 'status-cols', 'status-selected', 'status-position'];
  const missing = requiredIds.filter(id => !html.includes(`id="${id}"`));
  check(`all ${requiredIds.length} required toolbar/DOM ids are present`, missing.length === 0, missing.join(', '));

  const editOnly = ['btn-add-row', 'btn-delete-row', 'btn-undo', 'btn-redo', 'btn-save'];
  const notEditOnly = editOnly.filter(id => {
    const m = html.match(new RegExp(`<button id="${id}"[^>]*>`));
    return !m || !m[0].includes('class="edit-only"');
  });
  check('data-mutating buttons carry class "edit-only"', notEditOnly.length === 0, notEditOnly.join(', '));

  // ------------------------------------------------------------ 'ready' stream
  await onMessage({ type: 'ready' });

  const types = sent.map(m => m.type);
  check("'ready' streams load-start -> load-chunk -> load-done",
    types.indexOf('load-start') !== -1 && types.indexOf('load-chunk') > types.indexOf('load-start') &&
    types.indexOf('load-done') === types.length - 1, types.join(' '));

  const start = sent.find(m => m.type === 'load-start');
  check('load-start carries columns + metadata + totalRows',
    start.data.columns.length === 12 && start.data.totalRows === 891 &&
    start.data.metadata.fileName === 'titanic.parquet' && start.data.metadata.totalColumns === 12 &&
    typeof start.data.metadata.filePath === 'string',
    `${start.data.columns.length} cols, ${start.data.totalRows} rows`);

  const chunks = sent.filter(m => m.type === 'load-chunk');
  check('load-chunk batches are arrays-of-arrays with an offset',
    chunks.length === 1 && chunks[0].data.offset === 0 && Array.isArray(chunks[0].data.rows[0]) &&
    chunks[0].data.rows.length === 891, `${chunks.length} chunk(s), ${chunks[0].data.rows.length} rows`);
  check("'status' progress messages are posted", sent.some(m => m.type === 'status'));

  const flat = chunks[0].data.rows.flat();
  check('bigint values are normalized to Number', chunks[0].data.rows[0].every(v => typeof v !== 'bigint'),
    JSON.stringify(chunks[0].data.rows[0].slice(0, 4)));
  check('byte arrays are normalized to strings', chunks[0].data.rows[0][3] === 'Braund, Mr. Owen Harris',
    String(chunks[0].data.rows[0][3]));
  check('missing values are normalized to null', chunks[0].data.rows[0][10] === null);
  check('no value is a Uint8Array or Date object', !flat.some(v => v instanceof Uint8Array || v instanceof Date));

  // batching boundary: 10,000 rows per chunk
  check('BATCH_SIZE is 10,000 (891-row file fits in one chunk)', chunks.length === Math.ceil(891 / 10000));

  // ------------------------------------------------------------ exportCsv
  const csvTarget = path.join(OUT, 'exported.csv');
  saveDialogResult = Uri.file(csvTarget);
  await onMessage({ type: 'exportCsv', csv: 'a,b\n1,2\n' });
  check('exportCsv writes the chosen file', fs.existsSync(csvTarget) && fs.readFileSync(csvTarget, 'utf8') === 'a,b\n1,2\n');
  check('exportCsv notifies the user', notifications.some(n => n[1].includes('exported to')));

  saveDialogResult = undefined;
  const beforeCancel = fs.readdirSync(OUT).length;
  await onMessage({ type: 'exportCsv', csv: 'x' });
  check('cancelling the save dialog writes nothing', fs.readdirSync(OUT).length === beforeCancel);

  // ------------------------------------------------------------ saveParquet
  notifications.length = 0;
  const savedPath = path.join(OUT, 'titanic_edited.parquet');
  saveDialogResult = Uri.file(savedPath);
  await onMessage({
    type: 'saveParquet',
    data: { columns: ['id', 'name'], rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: null }] },
  });
  check('saveParquet prompts with a save dialog defaulting to <name>_edited.parquet',
    lastSaveOptions && lastSaveOptions.defaultUri.fsPath.endsWith('titanic_edited.parquet'),
    lastSaveOptions ? path.basename(lastSaveOptions.defaultUri.fsPath) : 'no dialog');
  check('the save dialog filters to parquet extensions',
    lastSaveOptions.filters['Parquet Files'].join(',') === 'parquet,pq,parq');
  check('saveParquet writes a real parquet file (PAR1 magic)', fs.existsSync(savedPath) &&
    fs.readFileSync(savedPath).subarray(0, 4).toString() === 'PAR1');
  check('saveParquet no longer writes a CSV', !fs.existsSync(path.join(OUT, 'titanic_edited.csv')));
  check('saveParquet no longer mentions the pandas workaround',
    !notifications.some(n => /pandas|cannot write Parquet/i.test(n[1])),
    notifications.map(n => n[1]).join(' | '));
  check('saveParquet reports what it wrote',
    notifications.some(n => n[0] === 'info' && n[1].includes('3 rows') && n[1].includes('2 columns')),
    notifications.map(n => n[1]).join(' | '));

  saveDialogResult = undefined;
  const beforeSaveCancel = fs.readdirSync(OUT).length;
  await onMessage({ type: 'saveParquet', data: { columns: ['id'], rows: [{ id: 1 }] } });
  check('cancelling the parquet save dialog writes nothing', fs.readdirSync(OUT).length === beforeSaveCancel);

  // ------------------------------------------------------------ clipboard / info
  await onMessage({ type: 'copyToClipboard', text: 'a\tb\n1\t2' });
  check('copyToClipboard writes to the VS Code clipboard', clipboard === 'a\tb\n1\t2');
  notifications.length = 0;
  await onMessage({ type: 'info', text: 'SQL Error: nope' });
  check("'info' shows a VS Code information message",
    notifications.some(n => n[0] === 'info' && n[1] === 'SQL Error: nope'));

  // ------------------------------------------------------------ requestDiffFile
  sent.length = 0;
  openDialogResult = [Uri.file(path.join(OUT, 'other.parquet'))];
  await onMessage({ type: 'requestDiffFile' });
  const diff = sent.find(m => m.type === 'diff-data');
  check("requestDiffFile replies with 'diff-data' {columns, rows, fileName}",
    !!diff && diff.data.columns.length === 12 && diff.data.rows.length === 891 && diff.data.fileName === 'other.parquet',
    diff ? `${diff.data.rows.length} rows from ${diff.data.fileName}` : 'no reply');
  check('diff rows are fully read and normalized', diff.data.rows[0][3] === 'Braund, Mr. Owen Harris');

  sent.length = 0;
  openDialogResult = undefined;
  await onMessage({ type: 'requestDiffFile' });
  check('cancelling the diff picker sends nothing', sent.length === 0);

  // ------------------------------------------------------------ error path
  const badPath = path.join(OUT, 'broken.parquet');
  fs.writeFileSync(badPath, 'this is not a parquet file');
  const badDoc = provider.openCustomDocument(Uri.file(badPath));
  const badSent = [];
  let badOnMessage = null;
  await provider.resolveCustomEditor(badDoc, {
    webview: {
      options: null, html: '', cspSource: 'x',
      asWebviewUri: u => ({ toString: () => u.path }),
      postMessage: async m => { badSent.push(m); return true; },
      onDidReceiveMessage: fn => { badOnMessage = fn; return { dispose() {} }; },
    },
  }, {});
  await badOnMessage({ type: 'ready' });
  const err = badSent.find(m => m.type === 'error');
  check("a corrupt file posts 'error' instead of throwing", !!err && err.message.startsWith('Failed to read parquet file:'),
    err ? err.message.slice(0, 70) : 'no error posted');

  // ------------------------------------------------------------ large file
  const bigDoc = provider.openCustomDocument(Uri.file(`${PROJ}/inputs/sample-large.parquet`));
  const bigSent = [];
  let bigOnMessage = null;
  await provider.resolveCustomEditor(bigDoc, {
    webview: {
      options: null, html: '', cspSource: 'x',
      asWebviewUri: u => ({ toString: () => u.path }),
      postMessage: async m => { bigSent.push(m); return true; },
      onDidReceiveMessage: fn => { bigOnMessage = fn; return { dispose() {} }; },
    },
  }, {});
  const t0 = Date.now();
  await bigOnMessage({ type: 'ready' });
  const bigStart = bigSent.find(m => m.type === 'load-start');
  const bigChunks = bigSent.filter(m => m.type === 'load-chunk');
  check(`large file streams in ${bigChunks.length} chunks of 10,000`,
    bigChunks.length === Math.ceil(bigStart.data.totalRows / 10000) &&
    bigChunks[0].data.rows.length === 10000 &&
    bigChunks[1].data.offset === 10000,
    `${bigStart.data.totalRows.toLocaleString()} rows in ${Date.now() - t0}ms`);
  check('every chunk offset is contiguous',
    bigChunks.every((c, i) => c.data.offset === i * 10000));

  fs.rmSync(OUT, { recursive: true, force: true });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} host checks passed`);
  if (failed.length) {
    console.log('FAILED:\n' + failed.map(f => ' - ' + f.name + (f.detail ? ' -> ' + f.detail : '')).join('\n'));
    process.exitCode = 1;
  }
})();
