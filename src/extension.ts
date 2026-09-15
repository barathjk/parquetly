import * as vscode from 'vscode';
import { ParquetEditorProvider } from './parquetEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(ParquetEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('parquetly.openFile', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFolders: false,
        openLabel: 'Open in Parquetly',
        filters: { 'Parquet Files': ['parquet', 'pq', 'parq'] },
      });
      if (!uris || uris.length === 0) {
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', uris[0], ParquetEditorProvider.viewType);
    })
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}
