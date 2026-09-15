/* Reproduce the real-browser double-click sequence: click, click, dblclick. */
import fs from 'fs';
import { JSDOM } from 'jsdom';
import { parquetMetadata, parquetSchema, parquetRead } from 'hyparquet';
import path from 'path';
import { fileURLToPath } from 'url';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const buf = fs.readFileSync(`${PROJ}/inputs/titanic.parquet`);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const md = parquetMetadata(ab);
const columns = parquetSchema(md).children.map(c => c.element.name);
const file = { byteLength: ab.byteLength, slice: (s, e) => ab.slice(s, e === undefined ? ab.byteLength : e) };
const norm = v => (v === null || v === undefined ? null : typeof v === 'bigint' ? Number(v) : v);
const rows = await new Promise((res, rej) =>
  parquetRead({ file, metadata: md, rowStart: 0, rowEnd: 891, rowFormat: 'array', onComplete: r => res(r.map(x => x.map(norm))) }).catch(rej));

const bodyHtml = fs.readFileSync(`${PROJ}/src/parquetEditorProvider.ts`, 'utf8')
  .split('<body>')[1].split('<script')[0].replace(/\\u2026/g, '…').replace(/\\u00d7/g, '×');

const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>${bodyHtml}</body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.acquireVsCodeApi = () => ({ postMessage: () => {} });
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get() { return 600; }, configurable: true });
window.eval(fs.readFileSync(`${PROJ}/media/main.js`, 'utf8'));

const $ = id => window.document.getElementById(id);
const send = m => window.dispatchEvent(new window.MessageEvent('message', { data: m }));
send({ type: 'load-start', data: { columns, metadata: { fileName: 't.parquet', filePath: 'x', totalRows: 891, totalColumns: 12 }, totalRows: 891 } });
send({ type: 'load-chunk', data: { rows, offset: 0 } });
send({ type: 'load-done' });

// enter edit mode
$('read-mode-toggle').checked = false;
$('read-mode-toggle').dispatchEvent(new window.Event('change'));

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

const mouse = (node, type, init = {}) =>
  node.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...init }));

// --- Scenario 1: the exact real-browser sequence on one cell ------------
const nameIdx = columns.indexOf('Name') + 1;
let td = $('table-body').querySelectorAll('tr')[0].querySelectorAll('td')[nameIdx];
const originalText = td.textContent;

mouse(td, 'click', { detail: 1 });                    // first click -> selects the row
const survivedRender = td.isConnected;
mouse(td, 'click', { detail: 2 });                    // second click
mouse(td, 'dblclick', { detail: 2 });                 // dblclick lands on the ORIGINAL node

check('cell node survives the selection click (not rebuilt)', survivedRender,
  survivedRender ? 'still in DOM' : 'DETACHED by render() - dblclick can never bubble');
check('double-click opens the inline editor', !!$('table-body').querySelector('td.editing input'));

let editor = $('table-body').querySelector('td.editing input');
if (editor) {
  // --- Scenario 2: clicking inside the editor must not destroy it ------
  mouse(editor, 'click', { detail: 1 });
  check('clicking inside the open editor keeps it open', !!$('table-body').querySelector('td.editing input'));

  editor = $('table-body').querySelector('td.editing input');
  editor.value = 'TYPED IN EDIT MODE';
  editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const after = $('table-body').querySelectorAll('tr')[0].querySelectorAll('td')[nameIdx].textContent;
  check('Enter commits the typed value', after === 'TYPED IN EDIT MODE', `${originalText} -> ${after}`);
}

// --- Scenario 3: selection still works ---------------------------------
const rowsNow = () => $('table-body').querySelectorAll('tr');
mouse(rowsNow()[2].querySelectorAll('td')[1], 'click');
check('single click still selects a row', $('status-selected').textContent.includes('1'), $('status-selected').textContent);
mouse(rowsNow()[6].querySelectorAll('td')[1], 'click', { shiftKey: true });
check('shift+click still selects a range', $('status-selected').textContent.includes('5'), $('status-selected').textContent);
mouse(rowsNow()[8].querySelectorAll('td')[0], 'click', { ctrlKey: true });
check('ctrl+click the row number still toggles selection', $('status-selected').textContent.includes('6'), $('status-selected').textContent);

// --- Scenario 4: Tab moves to the next cell ----------------------------
td = rowsNow()[0].querySelectorAll('td')[nameIdx];
mouse(td, 'click', { detail: 1 });
mouse(td, 'click', { detail: 2 });
mouse(td, 'dblclick', { detail: 2 });
editor = $('table-body').querySelector('td.editing input');
if (editor) {
  editor.value = 'TAB COMMIT';
  editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  const editingCol = $('table-body').querySelector('td.editing');
  check('Tab commits and moves to the next visible column',
    !!editingCol && editingCol.dataset.col === columns[columns.indexOf('Name') + 1],
    editingCol ? editingCol.dataset.col : 'no cell editing');
  check('Tab committed the previous value',
    rowsNow()[0].querySelectorAll('td')[nameIdx].textContent === 'TAB COMMIT');
} else {
  check('Tab commits and moves to the next visible column', false, 'editor never opened');
}

// --- Scenario 4b: edit a second cell right after committing a first -----
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const dblclick = node => { mouse(node, 'click', { detail: 1 }); mouse(node, 'click', { detail: 2 }); mouse(node, 'dblclick', { detail: 2 }); };
const editCell = (rowIdx, colName, value) => {
  const cell = rowsNow()[rowIdx].querySelectorAll('td')[columns.indexOf(colName) + 1];
  dblclick(cell);
  const input = $('table-body').querySelector('td.editing input');
  if (!input) return null;
  input.value = value;
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return rowsNow()[rowIdx].querySelectorAll('td')[columns.indexOf(colName) + 1].textContent;
};
check('edit a 2nd cell after committing a 1st', editCell(3, 'Sex', 'second') === 'second');
check('edit a 3rd cell after committing a 2nd', editCell(5, 'Cabin', 'third') === 'third');
check('consecutive edits are all retained',
  rowsNow()[3].querySelectorAll('td')[columns.indexOf('Sex') + 1].textContent === 'second' &&
  rowsNow()[5].querySelectorAll('td')[columns.indexOf('Cabin') + 1].textContent === 'third');
const numCell = editCell(4, 'Age', ' 41.5 ');
check('edit still auto-detects number type', numCell === '41.5' &&
  rowsNow()[4].querySelectorAll('td')[columns.indexOf('Age') + 1].classList.contains('number-value'), String(numCell));
const nullCell = rowsNow()[4].querySelectorAll('td')[columns.indexOf('Age') + 1];
dblclick(nullCell);
const ed2 = $('table-body').querySelector('td.editing input');
if (ed2) {
  ed2.value = 'null';
  ed2.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}
check('edit still auto-detects null', !!ed2 &&
  rowsNow()[4].querySelectorAll('td')[columns.indexOf('Age') + 1].classList.contains('null-value'),
  ed2 ? '' : 'editor never opened');
check('Ctrl+Z still undoes an edit made this way', (() => {
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  return rowsNow()[4].querySelectorAll('td')[columns.indexOf('Age') + 1].textContent === '41.5';
})(), rowsNow()[4].querySelectorAll('td')[columns.indexOf('Age') + 1].textContent);

// Escape must revert, not commit
const escCell = rowsNow()[7].querySelectorAll('td')[columns.indexOf('Sex') + 1];
const escBefore = escCell.textContent;
dblclick(escCell);
const escInput = $('table-body').querySelector('td.editing input');
if (escInput) {
  escInput.value = 'SHOULD NOT STICK';
  escInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}
check('Escape cancels the edit and restores the cell', !!escInput &&
  rowsNow()[7].querySelectorAll('td')[columns.indexOf('Sex') + 1].textContent === escBefore,
  escInput ? rowsNow()[7].querySelectorAll('td')[columns.indexOf('Sex') + 1].textContent : 'editor never opened');
check('no cell is left stuck in editing state', !$('table-body').querySelector('td.editing'));

// --- Scenario 5: read-only mode must still block editing ---------------
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
$('read-mode-toggle').checked = true;
$('read-mode-toggle').dispatchEvent(new window.Event('change'));
td = rowsNow()[1].querySelectorAll('td')[nameIdx];
mouse(td, 'click', { detail: 1 });
mouse(td, 'click', { detail: 2 });
mouse(td, 'dblclick', { detail: 2 });
check('read-only mode still blocks editing', !$('table-body').querySelector('td.editing input'));

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
