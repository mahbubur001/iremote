import * as vscode from 'vscode';

export const SCHEME = 'iremote';

/** iremote://<serverId>/<absolute remote path> */
export const remoteUri = (serverId: string, remotePath: string): vscode.Uri =>
  vscode.Uri.from({ scheme: SCHEME, authority: serverId, path: remotePath.startsWith('/') ? remotePath : `/${remotePath}` });

export const parseRemoteUri = (uri: vscode.Uri): { serverId: string; path: string } => ({
  serverId: uri.authority,
  path: uri.path || '/',
});
