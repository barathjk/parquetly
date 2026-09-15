import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parquetMetadata, parquetSchema, parquetRead } from 'hyparquet';
import type { SchemaElement } from 'hyparquet';
import { parquetWriteBuffer } from 'hyparquet-writer';

/** Rows are streamed to the webview in batches of this many. */
const BATCH_SIZE = 10000;

/**
 * The custom document for a parquet file. Parquet files are never modified in
 * place, so the document itself carries no state beyond its uri.
 */
class ParquetDocument implements vscode.CustomDocument {
  /** Source schema, kept so that Save can write the original column types back. */
  public sourceSchema: Map<string, SchemaElement> = new Map();
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {
    /* nothing to dispose */
  }
}

/** Writer types we can target, mirroring hyparquet-writer's BasicType. */
type WriterType = 'BOOLEAN' | 'INT32' | 'INT64' | 'FLOAT' | 'DOUBLE' | 'STRING' | 'JSON' | 'TIMESTAMP';

/** Map a source column's parquet type onto the closest writer type. */
function writerTypeFor(element: SchemaElement): WriterType {
  const logical = element.logical_type?.type;
  const converted = element.converted_type;
  switch (element.type) {
    case 'BOOLEAN':
      return 'BOOLEAN';
    case 'INT32':
      return 'INT32';
    case 'INT64':
      if (logical === 'TIMESTAMP' || converted === 'TIMESTAMP_MILLIS' || converted === 'TIMESTAMP_MICROS') {
        return 'TIMESTAMP';
      }
      return 'INT64';
    case 'INT96':
      return 'TIMESTAMP';
    case 'FLOAT':
      return 'FLOAT';
    case 'DOUBLE':
      return 'DOUBLE';
    case 'BYTE_ARRAY':
    case 'FIXED_LEN_BYTE_ARRAY':
      return logical === 'JSON' || converted === 'JSON' ? 'JSON' : 'STRING';
    default:
      return 'STRING';
  }
}

/**
 * Convert one webview value into what the writer needs for `type`. The webview
 * normalizes bigint to Number and Date to ISO string on the way in, so those
 * have to be rebuilt here. Returns null when the value cannot be represented.
 */
function coerceForType(value: unknown, type: WriterType): { ok: boolean; value?: unknown } {
  if (value === null || value === undefined || value === '') {
    return { ok: true, value: null };
  }
  switch (type) {
    case 'BOOLEAN': {
      if (typeof value === 'boolean') {
        return { ok: true, value };
      }
      const text = String(value).toLowerCase();
      if (text === 'true') {
        return { ok: true, value: true };
      }
      if (text === 'false') {
        return { ok: true, value: false };
      }
      return { ok: false };
    }
    case 'INT32': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) {
        return { ok: false };
      }
      return { ok: true, value: n };
    }
    case 'INT64': {
      if (typeof value === 'bigint') {
        return { ok: true, value };
      }
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isSafeInteger(n)) {
        return { ok: false };
      }
      return { ok: true, value: BigInt(n) };
    }
    case 'FLOAT':
    case 'DOUBLE': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!isFinite(n)) {
        return { ok: false };
      }
      return { ok: true, value: n };
    }
    case 'TIMESTAMP': {
      const date = value instanceof Date ? value : new Date(String(value));
      if (isNaN(date.getTime())) {
        return { ok: false };
      }
      return { ok: true, value: date };
    }
    default:
      return { ok: true, value: String(value) };
  }
}

/** Widest type that holds every value in a column, used when the original no longer fits. */
function inferType(values: unknown[]): WriterType {
  let sawNumber = false;
  let sawBool = false;
  let sawOther = false;
  for (const value of values) {
    if (value === null || value === undefined || value === '') {
      continue;
    }
    if (typeof value === 'number') {
      sawNumber = true;
    } else if (typeof value === 'boolean') {
      sawBool = true;
    } else {
      sawOther = true;
    }
  }
  if (sawOther || (sawNumber && sawBool)) {
    return 'STRING';
  }
  if (sawBool) {
    return 'BOOLEAN';
  }
  if (sawNumber) {
    return 'DOUBLE';
  }
  return 'STRING';
}

interface BuiltColumn {
  name: string;
  data: unknown[];
  type: WriterType;
  nullable: boolean;
}

/**
 * Build writer column sources from the edited grid, preferring each column's
 * original parquet type and widening only where an edit no longer fits.
 */
function buildColumnData(
  columns: string[],
  rows: Array<Record<string, unknown>>,
  sourceSchema: Map<string, SchemaElement>
): { columnData: BuiltColumn[]; widened: string[] } {
  const columnData: BuiltColumn[] = [];
  const widened: string[] = [];

  for (const name of columns) {
    const values = rows.map(row => (row[name] === undefined ? null : row[name]));
    const element = sourceSchema.get(name);
    const originalType = element ? writerTypeFor(element) : undefined;

    let chosen: WriterType | undefined;
    let data: unknown[] | undefined;

    if (originalType) {
      const converted: unknown[] = new Array(values.length);
      let fits = true;
      for (let i = 0; i < values.length; i++) {
        const result = coerceForType(values[i], originalType);
        if (!result.ok) {
          fits = false;
          break;
        }
        converted[i] = result.value;
      }
      if (fits) {
        chosen = originalType;
        data = converted;
      }
    }

    if (!data) {
      const fallback = inferType(values);
      chosen = fallback;
      data = values.map(value => {
        const result = coerceForType(value, fallback);
        return result.ok ? result.value : String(value);
      });
      if (originalType && originalType !== fallback) {
        widened.push(`${name}: ${originalType} → ${fallback}`);
      }
    }

    const optional = !element || element.repetition_type !== 'REQUIRED';
    columnData.push({
      name,
      data: data!,
      type: chosen!,
      nullable: optional || data!.some(v => v === null),
    });
  }

  return { columnData, widened };
}

/** Minimal AsyncBuffer over an in-memory ArrayBuffer, as hyparquet expects. */
function asyncBufferFromArrayBuffer(ab: ArrayBuffer) {
  return {
    byteLength: ab.byteLength,
    slice: (start: number, end?: number) => ab.slice(start, end === undefined ? ab.byteLength : end),
  };
}

/**
 * Normalize a decoded parquet value into something structured-cloneable and
 * JSON friendly: bigint -> Number, Uint8Array -> utf8 string, Date -> ISO string.
 */
function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder('utf-8').decode(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (typeof value === 'object') {
    // Nested group / map / list -> render as JSON text so the grid stays flat.
    try {
      return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
    } catch {
      return String(value);
    }
  }
  return value;
}

function normalizeRow(row: unknown[]): unknown[] {
  const out = new Array(row.length);
  for (let i = 0; i < row.length; i++) {
    out[i] = normalizeValue(row[i]);
  }
  return out;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export class ParquetEditorProvider implements vscode.CustomReadonlyEditorProvider<ParquetDocument> {
  public static readonly viewType = 'parquetly.parquetEditor';

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      ParquetEditorProvider.viewType,
      new ParquetEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  openCustomDocument(uri: vscode.Uri): ParquetDocument {
    return new ParquetDocument(uri);
  }

  async resolveCustomEditor(
    document: ParquetDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webview.html = this.getHtml(webview);

    const post = (message: unknown) => {
      try {
        void webview.postMessage(message);
      } catch {
        /* panel disposed mid-stream */
      }
    };

    webviewPanel.webview.onDidReceiveMessage(async (message: any) => {
      if (!message || typeof message.type !== 'string') {
        return;
      }
      switch (message.type) {
        case 'ready':
          await this.streamFile(document, post);
          return;

        case 'exportCsv':
          await this.handleExportCsv(document.uri, String(message.csv ?? ''));
          return;

        case 'saveParquet':
          await this.handleSaveParquet(document, message.data);
          return;

        case 'copyToClipboard':
          await vscode.env.clipboard.writeText(String(message.text ?? ''));
          vscode.window.setStatusBarMessage('Parquetly: copied to clipboard', 2000);
          return;

        case 'info':
          vscode.window.showInformationMessage(String(message.text ?? ''));
          return;

        case 'requestDiffFile':
          await this.handleRequestDiffFile(post);
          return;
      }
    });
  }

  /** Read the parquet file and stream it to the webview in batches. */
  private async streamFile(document: ParquetDocument, post: (m: unknown) => void): Promise<void> {
    const uri = document.uri;
    try {
      post({ type: 'status', message: 'Reading file…' });
      const bytes = await vscode.workspace.fs.readFile(uri);
      const arrayBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;

      const metadata = parquetMetadata(arrayBuffer);
      const schema = parquetSchema(metadata);
      const columns = schema.children.map(child => child.element.name);
      const totalRows = Number(metadata.num_rows);
      const fileName = path.basename(uri.fsPath);

      // Remember the source types so Save can write them back unchanged.
      document.sourceSchema = new Map(schema.children.map(child => [child.element.name, child.element]));

      post({
        type: 'load-start',
        data: {
          columns,
          metadata: {
            fileName,
            filePath: uri.fsPath,
            totalRows,
            totalColumns: columns.length,
          },
          totalRows,
        },
      });

      const file = asyncBufferFromArrayBuffer(arrayBuffer);

      for (let offset = 0; offset < totalRows; offset += BATCH_SIZE) {
        const rowEnd = Math.min(offset + BATCH_SIZE, totalRows);
        const batch = await new Promise<unknown[][]>((resolve, reject) => {
          parquetRead({
            file,
            metadata,
            rowStart: offset,
            rowEnd,
            rowFormat: 'array',
            onComplete: rows => resolve(rows as unknown[][]),
          }).catch(reject);
        });

        post({ type: 'load-chunk', data: { rows: batch.map(normalizeRow), offset } });
        post({
          type: 'status',
          message: `Loaded ${rowEnd.toLocaleString()} of ${totalRows.toLocaleString()} rows…`,
        });
      }

      post({ type: 'load-done' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      post({ type: 'error', message: `Failed to read parquet file: ${msg}` });
    }
  }

  private async handleExportCsv(sourceUri: vscode.Uri, csv: string): Promise<void> {
    const base = path.basename(sourceUri.fsPath).replace(/\.(parquet|pq|parq)$/i, '');
    const defaultUri = vscode.Uri.file(path.join(path.dirname(sourceUri.fsPath), `${base}.csv`));
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'CSV Files': ['csv'] },
      saveLabel: 'Export CSV',
    });
    if (!target) {
      return;
    }
    try {
      fs.writeFileSync(target.fsPath, csv, 'utf8');
      vscode.window.showInformationMessage(`Parquetly: exported to ${path.basename(target.fsPath)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Parquetly: export failed — ${msg}`);
    }
  }

  /**
   * Write the edited grid back out as a real parquet file, preserving the
   * source column types wherever the edited values still fit them.
   */
  private async handleSaveParquet(document: ParquetDocument, data: any): Promise<void> {
    const columns: string[] = Array.isArray(data?.columns) ? data.columns : [];
    const rows: Array<Record<string, unknown>> = Array.isArray(data?.rows) ? data.rows : [];
    if (!columns.length) {
      vscode.window.showErrorMessage('Parquetly: nothing to save.');
      return;
    }

    const sourceUri = document.uri;
    const dir = path.dirname(sourceUri.fsPath);
    const base = path.basename(sourceUri.fsPath).replace(/\.(parquet|pq|parq)$/i, '');
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(dir, `${base}_edited.parquet`)),
      filters: { 'Parquet Files': ['parquet', 'pq', 'parq'] },
      saveLabel: 'Save Parquet',
    });
    if (!target) {
      return;
    }

    try {
      const { columnData, widened } = buildColumnData(columns, rows, document.sourceSchema);
      const arrayBuffer = parquetWriteBuffer({ columnData: columnData as never });
      fs.writeFileSync(target.fsPath, Buffer.from(new Uint8Array(arrayBuffer)));

      const size = (arrayBuffer.byteLength / 1024 / 1024).toFixed(2);
      let message =
        `Parquetly: saved ${rows.length.toLocaleString()} rows × ${columns.length} columns ` +
        `to ${path.basename(target.fsPath)} (${size} MB).`;
      if (widened.length) {
        message += ` Column types widened to fit edited values — ${widened.join(', ')}.`;
      }
      vscode.window.showInformationMessage(message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Parquetly: save failed — ${msg}`);
    }
  }

  /** Pick a second parquet file, read it fully, and hand it to the webview. */
  private async handleRequestDiffFile(post: (m: unknown) => void): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFolders: false,
      openLabel: 'Compare With',
      filters: { 'Parquet Files': ['parquet', 'pq', 'parq'] },
    });
    if (!uris || uris.length === 0) {
      return;
    }
    const uri = uris[0];
    try {
      post({ type: 'status', message: `Reading ${path.basename(uri.fsPath)}…` });
      const bytes = await vscode.workspace.fs.readFile(uri);
      const arrayBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;

      const metadata = parquetMetadata(arrayBuffer);
      const schema = parquetSchema(metadata);
      const columns = schema.children.map(child => child.element.name);
      const totalRows = Number(metadata.num_rows);
      const file = asyncBufferFromArrayBuffer(arrayBuffer);

      const rows: unknown[][] = [];
      for (let offset = 0; offset < totalRows; offset += BATCH_SIZE) {
        const rowEnd = Math.min(offset + BATCH_SIZE, totalRows);
        const batch = await new Promise<unknown[][]>((resolve, reject) => {
          parquetRead({
            file,
            metadata,
            rowStart: offset,
            rowEnd,
            rowFormat: 'array',
            onComplete: r => resolve(r as unknown[][]),
          }).catch(reject);
        });
        for (const row of batch) {
          rows.push(normalizeRow(row));
        }
      }

      post({
        type: 'diff-data',
        data: { columns, rows, fileName: path.basename(uri.fsPath) },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      post({ type: 'error', message: `Failed to read compare file: ${msg}` });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'styles.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js')
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Parquetly</title>
</head>
<body>
<div id="toolbar">
  <div class="toolbar-row">
    <span id="app-title">Parquetly</span>
    <span id="file-info">No file loaded</span>
    <span class="toolbar-spacer"></span>
    <label class="toggle-switch" title="Toggle read-only / edit mode">
      <input type="checkbox" id="read-mode-toggle" checked>
      <span class="toggle-slider"></span>
    </label>
    <span id="mode-label">Read-only</span>
  </div>
  <div class="toolbar-row">
    <input type="text" id="search-input" placeholder="Search all columns… (Ctrl+F)">
    <button id="btn-clear-filter" title="Clear search and filters">Clear</button>
    <button id="btn-goto" title="Go to row (Ctrl+G)">Go To Row</button>
    <span id="goto-container" class="hidden">
      <input type="number" id="goto-input" min="1" placeholder="Row #">
    </span>
    <button id="btn-columns" title="Show / hide columns">Columns</button>
    <button id="btn-plot" title="Quick plot">Quick Plot</button>
    <button id="btn-sql" title="SQL query bar (Ctrl+Q)">SQL</button>
    <button id="btn-diff" title="Compare with another parquet file">Diff</button>
    <button id="btn-add-row" class="edit-only" title="Add a new row">Add Row</button>
    <button id="btn-delete-row" class="edit-only" title="Delete selected rows">Delete Row</button>
    <button id="btn-undo" class="edit-only" title="Undo (Ctrl+Z)">Undo</button>
    <button id="btn-redo" class="edit-only" title="Redo (Ctrl+Y)">Redo</button>
    <button id="btn-export-csv" title="Export CSV">Export CSV</button>
    <button id="btn-save" class="edit-only" title="Save edited rows as a Parquet file">Save</button>
  </div>
</div>

<div id="loading">Waiting for data…</div>
<div id="error-message" class="hidden"></div>

<div id="table-container">
  <table id="data-table">
    <thead id="table-head"></thead>
    <tbody id="table-body"></tbody>
  </table>
</div>

<div id="status-bar">
  <span id="status-rows"></span>
  <span id="status-cols"></span>
  <span id="status-selected"></span>
  <span class="toolbar-spacer"></span>
  <span id="status-position"></span>
</div>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
