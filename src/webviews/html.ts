import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/** Webview document with a strict CSP: only bundled scripts (nonce) and styles/fonts from the extension. */
export const webviewHtml = (webview: vscode.Webview, extensionUri: vscode.Uri, entry: 'settings' | 'sync', title: string): string => {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', file));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('codicon.css')}">
<link rel="stylesheet" href="${asset(`${entry}.css`)}">
<title>${title}</title>
</head>
<body>
<div id="app" role="application"></div>
<script nonce="${nonce}" src="${asset(`${entry}.js`)}"></script>
</body>
</html>`;
};
