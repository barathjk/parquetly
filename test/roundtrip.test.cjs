/* Save a real .parquet through the extension host, then read it back and compare. */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJ = path.resolve(__dirname, '..');
const OUT = process.env.PARQUETLY_TEST_OUT || path.join(os.tmpdir(), 'parquetly-roundtrip');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

// ---------------------------------------------------------------- vscode stub
const notifications = [];
let saveDialogResult = null;
class Uri {
  constructor(p) { this.fsPath = p; this.path = p.replace(/\\/g, '/'); this.scheme = 'file'; }
  static file(p) { return new Uri(p); }
  static joinPath(b, ...r) { return new Uri(path.join(b.fsPath, ...r)); }
  toString() { return 'file://' + this.path; }
}
const registered = { editors: {}, commands: {} };
const vscode = {
  Uri,
  Disposable: class { constructor(f) { this.dispose = f || (() => {}); } },
  window: {
    registerCustomEditorProvider: (vt, p, o) => { registered.editors[vt] = { provider: p, opts: o }; return { dispose() {} }; },
    showOpenDialog: async () => null,
    showSaveDialog: async () => saveDialogResult,
    showInformationMessage: m => notifications.push(['info', m]),
    showErrorMessage: m => notifications.push(['error', m]),
    setStatusBarMessage: m => notifications.push(['status', m]),
  },
  commands: { registerCommand: (i, f) => { registered.commands[i] = f; return { dispose() {} }; }, executeCommand: async () => {} },
  workspace: { fs: { readFile: async u => new Uint8Array(fs.readFileSync(u.fsPath)) } },
  env: { clipboard: { writeText: async () => {} } },
};
const origLoad = Module._load;
Module._load = function (request) { if (request === 'vscode') return vscode; return origLoad.apply(this, arguments); };

const ext = require(`${PROJ}/dist/extension.js`);
ext.activate({ subscriptions: [], extensionUri: Uri.file(PROJ) });
const provider = registered.editors['parquetly.parquetEditor'].provider;

/** Open a file through the provider and collect the streamed rows. */
async function openFile(filePath) {
  const doc = provider.openCustomDocument(Uri.file(filePath));
  const sent = [];
  let onMessage = null;
  await provider.resolveCustomEditor(doc, {
    webview: {
      options: null, html: '', cspSource: 'x',
      asWebviewUri: u => ({ toString: () => u.path }),
      postMessage: async m => { sent.push(m); return true; },
      onDidReceiveMessage: fn => { onMessage = fn; return { dispose() {} }; },
    },
  }, {});
  await onMessage({ type: 'ready' });
  const start = sent.find(m => m.type === 'load-start');
  const rows = [];
  for (const c of sent.filter(m => m.type === 'load-chunk')) rows.push(...c.data.rows);
  // webview converts array rows to objects, and stripRows sends them back that way
  const objects = rows.map(r => Object.fromEntries(start.data.columns.map((c, i) => [c, r[i]])));
  return { doc, onMessage, columns: start.data.columns, rows, objects };
}

/** Read a parquet file's schema + rows directly, as ground truth. */
async function readDirect(filePath) {
  const h = await import('hyparquet');
  const b = fs.readFileSync(filePath);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const md = h.parquetMetadata(ab);
  const sc = h.parquetSchema(md);
  const file = { byteLength: ab.byteLength, slice: (s, e) => ab.slice(s, e === undefined ? ab.byteLength : e) };
  const rows = await new Promise((res, rej) =>
    h.parquetRead({ file, metadata: md, rowFormat: 'array', onComplete: res }).catch(rej));
  return {
    numRows: Number(md.num_rows),
    types: Object.fromEntries(sc.children.map(c => [c.element.name, c.element.type])),
    repetition: Object.fromEntries(sc.children.map(c => [c.element.name, c.element.repetition_type])),
    columns: sc.children.map(c => c.element.name),
    rows,
  };
}

(async () => {
  // ======================= 1. unedited round trip =======================
  const src = `${PROJ}/inputs/titanic.parquet`;
  const before = await readDirect(src);
  const opened = await openFile(src);

  const outPath = path.join(OUT, 'titanic_edited.parquet');
  saveDialogResult = Uri.file(outPath);
  notifications.length = 0;
  await opened.onMessage({ type: 'saveParquet', data: { columns: opened.columns, rows: opened.objects } });

  check('Save writes a real .parquet file', fs.existsSync(outPath),
    fs.existsSync(outPath) ? `${(fs.statSync(outPath).size / 1024).toFixed(0)} KB` : 'missing');
  check('Save no longer writes a CSV', !fs.existsSync(path.join(OUT, 'titanic_edited.csv')));
  check('Save reports rows/columns written',
    notifications.some(n => n[0] === 'info' && n[1].includes('891') && n[1].includes('12 columns')),
    notifications.map(n => n[1]).join(' | '));
  check('Save no longer mentions pandas or the CSV limitation',
    !notifications.some(n => /pandas|cannot write Parquet/i.test(n[1])));

  const after = await readDirect(outPath);
  check('written file has the same row count', after.numRows === before.numRows, `${before.numRows} -> ${after.numRows}`);
  check('written file has the same columns in order',
    after.columns.join(',') === before.columns.join(','), after.columns.join(','));

  const typeDiffs = before.columns.filter(c => before.types[c] !== after.types[c])
    .map(c => `${c}: ${before.types[c]} -> ${after.types[c]}`);
  check('every column keeps its original parquet type', typeDiffs.length === 0,
    typeDiffs.length ? typeDiffs.join(', ') : Object.entries(after.types).map(([k, v]) => `${k}:${v}`).join(', '));

  const norm = v => (v === null || v === undefined ? null : typeof v === 'bigint' ? Number(v) : v);
  let mismatches = 0;
  let firstMismatch = '';
  for (let r = 0; r < before.numRows; r++) {
    for (let c = 0; c < before.columns.length; c++) {
      const a = norm(before.rows[r][c]);
      const b = norm(after.rows[r][c]);
      if (a !== b) {
        mismatches++;
        if (!firstMismatch) firstMismatch = `row ${r} col ${before.columns[c]}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
      }
    }
  }
  check(`all ${(before.numRows * before.columns.length).toLocaleString()} cell values survive the round trip`,
    mismatches === 0, mismatches ? `${mismatches} mismatches, first: ${firstMismatch}` : 'exact match');

  check('nulls are preserved as nulls',
    after.rows.filter(r => r[before.columns.indexOf('Cabin')] === null).length ===
    before.rows.filter(r => r[before.columns.indexOf('Cabin')] === null).length,
    `${after.rows.filter(r => r[before.columns.indexOf('Cabin')] === null).length} null Cabins`);

  // the written file must reopen in Parquetly itself
  const reopened = await openFile(outPath);
  check('the saved file reopens in Parquetly', reopened.rows.length === 891 && reopened.columns.length === 12,
    `${reopened.rows.length} rows x ${reopened.columns.length} cols`);

  // ======================= 2. edited values =============================
  const edited = opened.objects.map(o => ({ ...o }));
  edited[0].Name = 'Edited, Mr. Test';   // string edit
  edited[1].Age = 41.5;                   // double edit
  edited[2].Survived = 1;                 // int64 edit stays int64
  edited.push(Object.fromEntries(opened.columns.map(c => [c, null])));  // added row, all null

  const editedPath = path.join(OUT, 'edited-values.parquet');
  saveDialogResult = Uri.file(editedPath);
  notifications.length = 0;
  await opened.onMessage({ type: 'saveParquet', data: { columns: opened.columns, rows: edited } });
  const ev = await readDirect(editedPath);
  check('edited file has the added row', ev.numRows === 892, String(ev.numRows));
  check('edited string value is written', ev.rows[0][ev.columns.indexOf('Name')] === 'Edited, Mr. Test');
  check('edited double value is written', Number(ev.rows[1][ev.columns.indexOf('Age')]) === 41.5);
  check('INT64 column stays INT64 after an int edit', ev.types.Survived === 'INT64', ev.types.Survived);
  check('all-null added row round-trips as nulls',
    ev.rows[891].every(v => v === null), JSON.stringify(ev.rows[891]));
  check('no type widening was needed for in-range edits',
    !notifications.some(n => n[1].includes('widened')), notifications.map(n => n[1]).join(' | '));

  // ======================= 3. type that no longer fits ==================
  const widened = opened.objects.map(o => ({ ...o }));
  widened[0].Survived = 'not-a-number';   // text into an INT64 column
  const widePath = path.join(OUT, 'widened.parquet');
  saveDialogResult = Uri.file(widePath);
  notifications.length = 0;
  await opened.onMessage({ type: 'saveParquet', data: { columns: opened.columns, rows: widened } });
  const wv = await readDirect(widePath);
  check('a value that no longer fits widens only that column',
    wv.types.Survived === 'BYTE_ARRAY' && wv.types.Pclass === 'INT64',
    `Survived:${wv.types.Survived}, Pclass:${wv.types.Pclass}`);
  check('the widening is reported to the user',
    notifications.some(n => n[1].includes('widened') && n[1].includes('Survived')),
    notifications.map(n => n[1]).join(' | '));
  check('the offending value is preserved as text',
    wv.rows[0][wv.columns.indexOf('Survived')] === 'not-a-number');

  // ======================= 4. booleans + large file =====================
  const bigOpened = await openFile(`${PROJ}/inputs/sample-large.parquet`);
  const bigBefore = await readDirect(`${PROJ}/inputs/sample-large.parquet`);
  const bigPath = path.join(OUT, 'big.parquet');
  saveDialogResult = Uri.file(bigPath);
  notifications.length = 0;
  const t0 = Date.now();
  await bigOpened.onMessage({ type: 'saveParquet', data: { columns: bigOpened.columns, rows: bigOpened.objects } });
  const writeMs = Date.now() - t0;
  const bigAfter = await readDirect(bigPath);
  check(`500k rows write in ${writeMs}ms`, fs.existsSync(bigPath),
    `${(fs.statSync(bigPath).size / 1024 / 1024).toFixed(2)} MB vs source ${(fs.statSync(`${PROJ}/inputs/sample-large.parquet`).size / 1024 / 1024).toFixed(2)} MB`);
  check('large file keeps all 500,000 rows', bigAfter.numRows === 500000, String(bigAfter.numRows));
  check('BOOLEAN column stays BOOLEAN', bigAfter.types.flag === 'BOOLEAN', bigAfter.types.flag);
  check('large file types all preserved',
    JSON.stringify(bigAfter.types) === JSON.stringify(bigBefore.types),
    JSON.stringify(bigAfter.types));
  let bigMismatch = 0;
  for (let r = 0; r < 500000; r += 997) {
    for (let c = 0; c < 4; c++) if (norm(bigBefore.rows[r][c]) !== norm(bigAfter.rows[r][c])) bigMismatch++;
  }
  check('sampled large-file values match exactly', bigMismatch === 0, `${bigMismatch} mismatches over 502 sampled rows`);

  // ======================= 5. cancel + failure paths ====================
  saveDialogResult = undefined;
  const countBefore = fs.readdirSync(OUT).length;
  await opened.onMessage({ type: 'saveParquet', data: { columns: opened.columns, rows: opened.objects } });
  check('cancelling the save dialog writes nothing', fs.readdirSync(OUT).length === countBefore);

  notifications.length = 0;
  saveDialogResult = Uri.file(path.join(OUT, 'empty.parquet'));
  await opened.onMessage({ type: 'saveParquet', data: { columns: [], rows: [] } });
  check('saving with no columns reports an error, does not crash',
    notifications.some(n => n[0] === 'error'), notifications.map(n => n[1]).join(' | '));

  if (process.env.PARQUETLY_KEEP_OUTPUT) console.log("Kept output in " + OUT);
  else fs.rmSync(OUT, { recursive: true, force: true });
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} round-trip checks passed`);
  if (failed.length) {
    console.log('FAILED:\n' + failed.map(f => ' - ' + f.name).join('\n'));
    process.exitCode = 1;
  }
})();
