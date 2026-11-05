import * as vscode from 'vscode';
import { posix } from 'node:path';
import type { ConfigStore } from '../config/ConfigStore';
import type { ServerManager } from '../core/ServerManager';
import type { RemoteFileSystemProvider } from '../fs/RemoteFileSystemProvider';
import { parseRemoteUri, SCHEME } from '../fs/uri';
import { log } from '../util/log';

const MIN_INTERVAL_MS = 5000;

/**
 * PhpStorm "Notify about remote changes": when VS Code regains focus or a remote editor becomes active,
 * open remote files are re-checked. Clean editors reload silently; dirty ones get a warning.
 */
export class RemoteChangeMonitor implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lastCheck = new Map<string, number>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly config: ConfigStore,
    private readonly servers: ServerManager,
    private readonly provider: RemoteFileSystemProvider,
  ) {
    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => s.focused && void this.checkVisible()),
      vscode.window.onDidChangeActiveTextEditor((e) => e && void this.check([e.document])),
      vscode.workspace.onDidCloseTextDocument((d) => {
        this.lastCheck.delete(d.uri.toString());
        this.warned.delete(d.uri.toString());
      }),
    );
  }

  private enabledFor(serverId: string): boolean {
    const server = this.config.findServer(serverId);
    return !!server && server.project.config.options.notifyRemoteChanges && this.servers.isConnected(serverId);
  }

  private checkVisible(): Promise<void> {
    return this.check(vscode.window.visibleTextEditors.map((e) => e.document));
  }

  private async check(docs: readonly vscode.TextDocument[]): Promise<void> {
    const now = Date.now();
    for (const doc of docs) {
      if (doc.uri.scheme !== SCHEME) continue;
      const key = doc.uri.toString();
      const { serverId, path } = parseRemoteUri(doc.uri);
      if (!this.enabledFor(serverId) || now - (this.lastCheck.get(key) ?? 0) < MIN_INTERVAL_MS) continue;
      this.lastCheck.set(key, now);
      const known = this.provider.knownVersion(doc.uri);
      if (!known) continue;
      try {
        const st = await this.servers.poolById(serverId).use((c) => c.stat(path));
        if (!st) continue;
        if (!(await this.provider.changedSince(doc.uri, st))) {
          this.warned.delete(key);
          continue;
        }
        if (!doc.isDirty) {
          this.provider.notifyChanged([doc.uri]);
          continue;
        }
        if (this.warned.has(key)) continue;
        this.warned.add(key);
        const choice = await vscode.window.showWarningMessage(
          `"${posix.basename(path)}" was modified on the server while you have unsaved changes.`,
          'Reload from Server',
          'Keep Mine',
        );
        if (choice === 'Reload from Server') {
          await vscode.window.showTextDocument(doc);
          await vscode.commands.executeCommand('workbench.action.files.revert');
          this.warned.delete(key);
        }
      } catch (e) {
        log.detail(`Remote change check failed for ${key}: ${e}`);
      }
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
