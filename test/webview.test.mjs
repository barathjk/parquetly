/* Drive media/main.js inside jsdom against real parquet data. */
import fs from 'fs';
import { JSDOM } from 'jsdom';
import { parquetMetadata, parquetSchema, parquetRead } from 'hyparquet';
import path from 'path';
import { fileURLToPath } from 'url';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- Read real parquet rows the same way the extension host does -------
async function readParquet(path) {
  const buf = fs.readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const md = parquetMetadata(ab);
  const columns = parquetSchema(md).children.map(c => c.element.name);
  const totalRows = Number(md.num_rows);
  const file = { byteLength: ab.byteLength, slice: (s, e) => ab.slice(s, e === undefined ? ab.byteLength : e) };
  const norm = v => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'bigint') return Number(v);
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Uint8Array) return new TextDecoder('utf-8').decode(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  };
  const rows = [];
  for (let off = 0; off < totalRows; off += 10000) {
    const end = Math.min(off + 10000, totalRows);
    const batch = await new Promise((res, rej) =>
      parquetRead({ file, metadata: md, rowStart: off, rowEnd: end, rowFormat: 'array', onComplete: res }).catch(rej));
    for (const r of batch) rows.push(r.map(norm));
  }
  return { columns, rows, totalRows };
}

// ---- The exact body markup the provider emits --------------------------
const bodyHtml = fs.readFileSync(`${PROJ}/src/parquetEditorProvider.ts`, 'utf8')
  .split('<body>')[1].split('<script')[0]
  .replace(/\\u2026/g, '…').replace(/\\u00d7/g, '×');

const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>${bodyHtml}</body></html>`, {
  runScripts: 'outside-only', pretendToBeVisual: true,
});
const { window } = dom;

const posted = [];
window.acquireVsCodeApi = () => ({ postMessage: m => posted.push(m) });
// jsdom has no layout: give the scroll container a usable viewport height.
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get() { return 600; }, configurable: true });

window.eval(fs.readFileSync(`${PROJ}/media/main.js`, 'utf8'));

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

const send = msg => window.dispatchEvent(new window.MessageEvent('message', { data: msg }));
const $ = id => window.document.getElementById(id);
const click = node => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

check('webview posts ready on start', posted.some(m => m.type === 'ready'));

const { columns, rows, totalRows } = await readParquet(`${PROJ}/inputs/titanic.parquet`);
console.log(`\n-- titanic.parquet: ${totalRows} rows x ${columns.length} cols --\n`);

send({ type: 'load-start', data: { columns, metadata: { fileName: 'titanic.parquet', filePath: 'x', totalRows, totalColumns: columns.length }, totalRows } });
send({ type: 'load-chunk', data: { rows, offset: 0 } });
send({ type: 'load-done' });

// ---- Load + render -----------------------------------------------------
check('header renders every column + row-num', $('table-head').querySelectorAll('th').length === columns.length + 1,
  `${$('table-head').querySelectorAll('th').length} th`);
check('file-info shows row/col counts', $('file-info').textContent.includes('891') && $('file-info').textContent.includes('12'),
  $('file-info').textContent.trim());
check('status-rows shows total', $('status-rows').textContent.includes('891'), $('status-rows').textContent);
const renderedRows = $('table-body').querySelectorAll('tr').length;
check('virtualizes rows (renders a window, not all 891)', renderedRows > 5 && renderedRows < 200, `${renderedRows} rendered`);
check('tbody height is totalRows * 28px', $('table-body').style.height === `${891 * 28}px`, $('table-body').style.height);
const firstCells = [...$('table-body').querySelector('tr').querySelectorAll('td')].map(td => td.textContent);
check('first row matches file (Braund, Mr. Owen Harris)', firstCells.includes('Braund, Mr. Owen Harris'), firstCells.slice(0, 5).join(' | '));
check('null cells get null-value class', !!$('table-body').querySelector('td.null-value'));
check('numeric cells get number-value class', !!$('table-body').querySelector('td.number-value'));

// ---- Read-only vs edit mode -------------------------------------------
check('starts in read-only mode', window.document.body.classList.contains('read-only') && $('mode-label').textContent === 'Read-only');
$('read-mode-toggle').checked = false;
$('read-mode-toggle').dispatchEvent(new window.Event('change'));
check('toggle switches to edit mode', !window.document.body.classList.contains('read-only') && $('mode-label').textContent === 'Edit');

// ---- Sorting -----------------------------------------------------------
const ageTh = $('table-head').querySelector('th[data-col="Age"]');
click(ageTh);
let firstAge = $('table-body').querySelector('tr').querySelectorAll('td')[columns.indexOf('Age') + 1].textContent;
check('click header sorts ascending', firstAge === '0.42', `first Age = ${firstAge}`);
check('sort indicator shown', $('table-head').querySelector('th[data-col="Age"] .sort-indicator').textContent === '▲');
click($('table-head').querySelector('th[data-col="Age"]'));
firstAge = $('table-body').querySelector('tr').querySelectorAll('td')[columns.indexOf('Age') + 1].textContent;
check('second click sorts descending', firstAge === '80', `first Age = ${firstAge}`);
check('desc indicator shown', $('table-head').querySelector('th[data-col="Age"] .sort-indicator').textContent === '▼');

// ---- Search ------------------------------------------------------------
$('search-input').value = 'Heikkinen';
$('search-input').dispatchEvent(new window.Event('input'));
await new Promise(r => setTimeout(r, 200));
check('live search filters rows', $('status-rows').textContent.includes('1 of 891'), $('status-rows').textContent);
check('search hit is highlighted', !!$('table-body').querySelector('td.search-hit'));
click($('btn-clear-filter'));
check('clear restores all rows', $('status-rows').textContent.includes('891') && !$('status-rows').textContent.includes(' of '), $('status-rows').textContent);

// ---- SQL bar -----------------------------------------------------------
click($('btn-sql'));
const sqlInput = $('sql-input');
check('Ctrl+Q / SQL button inserts sql-bar above table', !!sqlInput && window.document.querySelector('.sql-bar').nextElementSibling.id === 'table-container');

const runSql = q => {
  sqlInput.value = q;
  sqlInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return $('status-rows').textContent;
};
// ground truth computed directly from the parquet rows
const idx = c => columns.indexOf(c);
const truth = f => rows.filter(f).length;

let s = runSql("WHERE Sex = 'female'");
check("SQL: WHERE Sex = 'female'", s.includes(`${truth(r => r[idx('Sex')] === 'female')} of`), s + ` (expected ${truth(r => r[idx('Sex')] === 'female')})`);

s = runSql('WHERE Age > 30 AND Survived = 1');
let exp = truth(r => Number(r[idx('Age')]) > 30 && Number(r[idx('Survived')]) === 1);
check('SQL: AND with numeric compare', s.includes(`${exp} of`), s + ` (expected ${exp})`);

s = runSql("WHERE Pclass = 1 OR Pclass = 2");
exp = truth(r => Number(r[idx('Pclass')]) === 1 || Number(r[idx('Pclass')]) === 2);
check('SQL: OR', s.includes(`${exp} of`), s + ` (expected ${exp})`);

s = runSql("WHERE Name LIKE '%Miss%'");
exp = truth(r => /Miss/i.test(String(r[idx('Name')] ?? '')));
check('SQL: LIKE %…%', s.includes(`${exp} of`), s + ` (expected ${exp})`);

s = runSql('WHERE Cabin IS NULL');
exp = truth(r => r[idx('Cabin')] === null);
check('SQL: IS NULL', s.includes(`${exp} of`), s + ` (expected ${exp})`);

s = runSql('WHERE Cabin IS NOT NULL');
exp = truth(r => r[idx('Cabin')] !== null);
check('SQL: IS NOT NULL', s.includes(`${exp} of`), s + ` (expected ${exp})`);

s = runSql("WHERE Embarked IN (S,Q)");
exp = truth(r => ['S', 'Q'].includes(String(r[idx('Embarked')] ?? '')));
check('SQL: IN (a,b)', s.includes(`${exp} of`), s + ` (expected ${exp})`);

s = runSql("WHERE Sex != 'male'");
exp = truth(r => String(r[idx('Sex')]) !== 'male');
check('SQL: != negation', s.includes(`${exp} of`), s + ` (expected ${exp})`);

s = runSql('WHERE Age >= 18 ORDER BY Fare DESC LIMIT 10');
check('SQL: ORDER BY + LIMIT caps at 10', s.includes('10 of 891'), s);
const topFare = $('table-body').querySelector('tr').querySelectorAll('td')[idx('Fare') + 1].textContent;
check('SQL: ORDER BY Fare DESC puts max fare first', topFare.replace(/,/g, '').startsWith('512.3'), `top fare = ${topFare}`);

const before = posted.length;
runSql('WHERE ((( bogus');
check('SQL parse error posts an info notification', posted.slice(before).some(m => m.type === 'info' && m.text.startsWith('SQL Error:')),
  JSON.stringify(posted[posted.length - 1]));

click($('btn-sql')); // close sql bar
check('closing SQL bar restores full row set', $('status-rows').textContent.includes('891'), $('status-rows').textContent);

// ---- Row selection + TSV copy -----------------------------------------
const bodyRows = () => $('table-body').querySelectorAll('tr');
click(bodyRows()[0].querySelector('td'));
check('click selects a row', $('status-selected').textContent.includes('1'), $('status-selected').textContent);
bodyRows()[4].dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey: true }));
check('shift+click selects a range of 5', $('status-selected').textContent.includes('5'), $('status-selected').textContent);

const beforeCopy = posted.length;
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
const tsv = posted.slice(beforeCopy).find(m => m.type === 'copyToClipboard');
check('Ctrl+C posts copyToClipboard', !!tsv);
check('copied payload is TSV with header + 5 rows', tsv && tsv.text.split('\n').length === 6 && tsv.text.includes('\t'),
  tsv ? `${tsv.text.split('\n').length} lines` : 'none');

// ---- Ctrl+Click a cell filters by that value ---------------------------
const sexCol = idx('Sex') + 1;
bodyRows()[0].querySelectorAll('td')[sexCol].dispatchEvent(new window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
check('Ctrl+Click a cell filters by that value', /of 891/.test($('status-rows').textContent) && !$('status-rows').textContent.includes('891 of'),
  $('status-rows').textContent);
click($('btn-clear-filter'));

// ---- Cell editing + undo/redo -----------------------------------------
const targetRow = bodyRows()[0];
const nameCell = targetRow.querySelectorAll('td')[idx('Name') + 1];
const originalName = nameCell.textContent;
nameCell.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
const editor = $('table-body').querySelector('td.editing input');
check('double-click in edit mode opens an inline input', !!editor);
editor.value = 'EDITED VALUE';
editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
check('Enter commits the edit', $('table-body').querySelectorAll('tr')[0].querySelectorAll('td')[idx('Name') + 1].textContent === 'EDITED VALUE');

window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
check('Ctrl+Z undoes the edit', $('table-body').querySelectorAll('tr')[0].querySelectorAll('td')[idx('Name') + 1].textContent === originalName,
  $('table-body').querySelectorAll('tr')[0].querySelectorAll('td')[idx('Name') + 1].textContent);
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
check('Ctrl+Y redoes the edit', $('table-body').querySelectorAll('tr')[0].querySelectorAll('td')[idx('Name') + 1].textContent === 'EDITED VALUE');
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));

// auto type-detect. Sort by PassengerId first so that editing Age does not
// re-sort the row out from under the assertion.
click($('table-head').querySelector('th[data-col="PassengerId"]'));
const ageCell = $('table-body').querySelectorAll('tr')[0].querySelectorAll('td')[idx('Age') + 1];
ageCell.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
let ed = $('table-body').querySelector('td.editing input');
ed.value = '  41.5 ';
ed.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
const ageTd = $('table-body').querySelectorAll('tr')[0].querySelectorAll('td')[idx('Age') + 1];
check('edit auto-detects number type', ageTd.classList.contains('number-value') && ageTd.textContent === '41.5', ageTd.textContent);
ageTd.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
ed = $('table-body').querySelector('td.editing input');
ed.value = 'null';
ed.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
check('edit auto-detects null', $('table-body').querySelectorAll('tr')[0].querySelectorAll('td')[idx('Age') + 1].classList.contains('null-value'));

// ---- Add / delete rows -------------------------------------------------
const rowsBeforeAdd = Number($('status-rows').textContent.replace(/\D/g, ''));
click($('btn-add-row'));
check('Add Row appends a row', $('status-rows').textContent.includes(String(rowsBeforeAdd + 1)), $('status-rows').textContent);
click($('table-body').querySelectorAll('tr')[0].querySelector('td'));
click($('btn-delete-row'));
check('Delete Row removes the selected row', $('status-rows').textContent.includes(String(rowsBeforeAdd)), $('status-rows').textContent);

// ---- Columns panel -----------------------------------------------------
click($('btn-columns'));
const panel = window.document.querySelector('.overlay .panel');
check('Columns panel opens with one item per column', panel && panel.querySelectorAll('.panel-item').length === columns.length,
  panel ? `${panel.querySelectorAll('.panel-item').length} items` : 'no panel');
panel.querySelector('input[data-col="Ticket"]').checked = false;
click([...panel.querySelectorAll('button')].find(b => b.textContent === 'Apply'));
check('hiding a column removes its header', !$('table-head').querySelector('th[data-col="Ticket"]'));
check('status-cols reports hidden count', $('status-cols').textContent.includes('hidden'), $('status-cols').textContent);
check('panel closed after apply', !window.document.querySelector('.overlay'));

// ---- Header context menu ----------------------------------------------
$('table-head').querySelector('th[data-col="Sex"]').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
let menu = window.document.querySelector('.context-menu');
const menuLabels = menu ? [...menu.querySelectorAll('.context-menu-item')].map(i => i.textContent) : [];
check('header right-click menu has all 7 actions',
  ['Sort Ascending', 'Sort Descending', 'Filter by Values…', 'Column Stats…', 'Plot Column', 'Copy Column', 'Hide Column']
    .every(l => menuLabels.includes(l)), menuLabels.join(' / '));

// Column stats
click([...menu.querySelectorAll('.context-menu-item')].find(i => i.textContent === 'Column Stats…'));
let statsText = window.document.querySelector('.overlay .panel-body').textContent;
check('Column Stats popup shows counts for a string column', statsText.includes('Unique') && statsText.includes('Top 1'), statsText.replace(/\s+/g, ' ').slice(0, 90));
window.document.querySelector('.panel-close').click();

$('table-head').querySelector('th[data-col="Fare"]').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
menu = window.document.querySelector('.context-menu');
click([...menu.querySelectorAll('.context-menu-item')].find(i => i.textContent === 'Column Stats…'));
statsText = window.document.querySelector('.overlay .panel-body').textContent;
check('numeric Column Stats shows min/max/mean/median/stddev',
  ['Min', 'Max', 'Mean', 'Median', 'Std Dev'].every(k => statsText.includes(k)), statsText.replace(/\s+/g, ' ').slice(0, 120));
window.document.querySelector('.panel-close').click();

// Filter by values
$('table-head').querySelector('th[data-col="Embarked"]').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
menu = window.document.querySelector('.context-menu');
click([...menu.querySelectorAll('.context-menu-item')].find(i => i.textContent === 'Filter by Values…'));
const fpanel = window.document.querySelector('.overlay .panel');
check('Filter-by-values lists unique values with counts', fpanel.querySelectorAll('.panel-item').length >= 3 && !!fpanel.querySelector('.item-count'),
  `${fpanel.querySelectorAll('.panel-item').length} unique values`);
[...fpanel.querySelectorAll('input[type=checkbox]')].forEach(cb => { cb.checked = cb.dataset.value === 'Q'; });
click([...fpanel.querySelectorAll('button')].find(b => b.textContent === 'Apply'));
exp = truth(r => String(r[idx('Embarked')] ?? '') === 'Q');
check('applying a value filter filters the grid', $('status-rows').textContent.includes(`${exp} of`), $('status-rows').textContent + ` (expected ${exp})`);
check('filtered column header shows a flag', $('table-head').querySelector('th[data-col="Embarked"]').textContent.includes('⚑'));
click($('btn-clear-filter'));

// ---- Quick Plot --------------------------------------------------------
click($('btn-plot'));
let svg = window.document.querySelector('#plot-svg');
check('Quick Plot opens and renders inline SVG (no canvas/lib)', !!svg && svg.tagName.toLowerCase() === 'svg');
check('plot SVG has histogram bars with tooltips', svg.querySelectorAll('rect > title').length > 3, `${svg.querySelectorAll('rect').length} bars`);
check('plot shows dashed mean line', !!svg.querySelector('.plot-mean-line') && !!svg.querySelector('.plot-mean-label'));
check('plot has gridlines + axis + tick labels', svg.querySelectorAll('.plot-grid-line').length > 0 && svg.querySelectorAll('.plot-axis-line').length === 2 && svg.querySelectorAll('.plot-tick-label').length > 0);
let plotStats = window.document.querySelector('.plot-stats').textContent;
check('live stats bar shows Count/Min/Max/Mean/Median/StdDev',
  ['Count', 'Min', 'Max', 'Mean', 'Median', 'StdDev'].every(k => plotStats.includes(k)), plotStats.replace(/\s+/g, ' ').slice(0, 110));

// zoom via the +/- buttons
const controlsBtns = [...window.document.querySelectorAll('.panel-controls button')];
const statsBefore = window.document.querySelector('.plot-stats').textContent;
controlsBtns.find(b => b.textContent === '+').click();
const statsZoomed = window.document.querySelector('.plot-stats').textContent;
check('zoom in recomputes stats over the visible range', statsBefore !== statsZoomed);
controlsBtns.find(b => b.textContent === 'Reset').click();
check('Reset restores the unzoomed stats', window.document.querySelector('.plot-stats').textContent === statsBefore);

// bins slider
const binsSlider = window.document.querySelector('.panel-controls input[type=range]');
const barsBefore = window.document.querySelector('#plot-svg').querySelectorAll('rect').length;
binsSlider.value = '80';
binsSlider.dispatchEvent(new window.Event('input'));
check('bins slider changes the bin count', window.document.querySelector('#plot-svg').querySelectorAll('rect').length !== barsBefore,
  `${barsBefore} -> ${window.document.querySelector('#plot-svg').querySelectorAll('rect').length} bars`);

// switch to pie
const typeSelect = [...window.document.querySelectorAll('.panel-controls select')][1];
const colSelect = [...window.document.querySelectorAll('.panel-controls select')][0];
colSelect.value = 'Embarked';
colSelect.dispatchEvent(new window.Event('change'));
typeSelect.value = 'pie';
typeSelect.dispatchEvent(new window.Event('change'));
svg = window.document.querySelector('#plot-svg');
check('pie chart renders arc paths with tooltips', svg.querySelectorAll('path > title').length >= 3, `${svg.querySelectorAll('path').length} slices`);
check('pie legend is a 3-column grid with swatches/counts',
  window.document.querySelectorAll('.pie-legend .pie-legend-item').length >= 3 && !!window.document.querySelector('.pie-legend-swatch'));
window.document.querySelector('.panel-close').click();

// ---- Go To Row ---------------------------------------------------------
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }));
check('Ctrl+G reveals Go To Row input', !$('goto-container').classList.contains('hidden'));
$('goto-input').value = '500';
$('goto-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
check('Go To Row selects that row', $('status-selected').textContent.includes('1'), $('status-selected').textContent);

// ---- Export CSV --------------------------------------------------------
const beforeExport = posted.length;
click($('btn-export-csv'));
menu = window.document.querySelector('.context-menu');
const exportLabels = [...menu.querySelectorAll('.context-menu-item')].map(i => i.textContent);
check('Export CSV offers all / filtered / selected',
  exportLabels.length === 3 && exportLabels[0].startsWith('Export all') && exportLabels[1].startsWith('Export filtered') && exportLabels[2].startsWith('Export selected'),
  exportLabels.join(' / '));
click(menu.querySelectorAll('.context-menu-item')[0]);
const csvMsg = posted.slice(beforeExport).find(m => m.type === 'exportCsv');
check('exportCsv message carries CSV text', !!csvMsg && csvMsg.csv.split('\n').length > 800, csvMsg ? `${csvMsg.csv.split('\n').length} lines` : 'none');
check('CSV quotes values containing commas', csvMsg.csv.includes('"Cumings, Mrs. John Bradley (Florence Briggs Thayer)"'));
check('CSV omits hidden columns', !csvMsg.csv.split('\n')[0].includes('Ticket'), csvMsg.csv.split('\n')[0]);

// ---- Save (CSV-not-parquet path) --------------------------------------
const beforeSave = posted.length;
click($('btn-save'));
const saveMsg = posted.slice(beforeSave).find(m => m.type === 'saveParquet');
check('Save posts saveParquet with columns+rows', !!saveMsg && saveMsg.data.columns.length === columns.length && saveMsg.data.rows.length > 800,
  saveMsg ? `${saveMsg.data.rows.length} rows` : 'none');

// ---- Diff --------------------------------------------------------------
const beforeDiff = posted.length;
click($('btn-diff'));
check('Diff button requests a second file', posted.slice(beforeDiff).some(m => m.type === 'requestDiffFile'));

// craft a compare dataset: 1 changed cell, a dropped column, an extra column, 2 extra rows
const diffCols = columns.filter(c => c !== 'Cabin').concat(['NewCol']);
const diffRows = rows.slice(0, 891).map(r => {
  const o = diffCols.map(c => (c === 'NewCol' ? 1 : r[idx(c)]));
  return o;
});
diffRows[0][diffCols.indexOf('Sex')] = 'CHANGED';
diffRows.push(diffRows[0].slice(), diffRows[0].slice());
send({ type: 'diff-data', data: { columns: diffCols, rows: diffRows, fileName: 'other.parquet' } });
const diffBody = window.document.querySelector('.overlay .panel-body');
const diffText = diffBody.textContent;
check('diff panel shows 5 summary stat cards', diffBody.querySelectorAll('.diff-card').length === 5);
check('diff reports added column', diffText.includes('NewCol'));
check('diff reports removed column', diffText.includes('Cabin'));
check('diff counts +2 added rows', diffText.includes('+2'), diffText.replace(/\s+/g, ' ').slice(0, 160));
check('diff lists the changed cell with current/compare styling',
  !!diffBody.querySelector('td.diff-from') && diffBody.textContent.includes('CHANGED'));
window.document.querySelector('.panel-close').click();

// ---- Escape handling ---------------------------------------------------
click($('btn-columns'));
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
check('Escape closes an open overlay panel', !window.document.querySelector('.overlay'));

// ---- Big file smoke test ----------------------------------------------
console.log('\n-- sample-large.parquet --\n');
const big = await readParquet(`${PROJ}/inputs/sample-large.parquet`);
const t0 = Date.now();
send({ type: 'load-start', data: { columns: big.columns, metadata: { fileName: 'sample-large.parquet', filePath: 'y', totalRows: big.totalRows, totalColumns: big.columns.length }, totalRows: big.totalRows } });
for (let off = 0; off < big.rows.length; off += 10000) {
  send({ type: 'load-chunk', data: { rows: big.rows.slice(off, off + 10000), offset: off } });
}
send({ type: 'load-done' });
const loadMs = Date.now() - t0;
check(`large file (${big.totalRows.toLocaleString()} rows x ${big.columns.length} cols) loads`, $('status-rows').textContent.includes(big.totalRows.toLocaleString()), $('status-rows').textContent);
check('large file still virtualizes the DOM', $('table-body').querySelectorAll('tr').length < 200, `${$('table-body').querySelectorAll('tr').length} rows in DOM, chunked render ${loadMs}ms`);
const t1 = Date.now();
$('search-input').value = 'a';
$('search-input').dispatchEvent(new window.Event('input'));
await new Promise(r => setTimeout(r, 250));
check('search over the large file stays responsive', Date.now() - t1 < 3000, `${Date.now() - t1}ms`);

// ---- Error path --------------------------------------------------------
send({ type: 'error', message: 'Failed to read parquet file: boom' });
check('error message is surfaced in the webview', !$('error-message').classList.contains('hidden') && $('error-message').textContent.includes('boom'));

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:\n' + failed.map(f => ' - ' + f.name + (f.detail ? ' -> ' + f.detail : '')).join('\n'));
  process.exitCode = 1;
}
