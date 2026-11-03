import * as vscode from 'vscode';
import { basename, relative } from 'node:path';
import type { Services } from '../services';
import type { ResolvedServer } from '../config/ConfigStore';
import type { SyncItem } from '../core/SyncEngine';
import { errorMessage, isRemoteError } from '../protocol/types';
import { remoteUri } from '../fs/uri';
import { log } from '../util/log';
import { webviewHtml } from './html';
import type { SyncAction, SyncToHost, SyncToWebview, UiSyncItem } from '../../webview/shared/protocol';

const MAX_DOWNLOAD_COMPARE = 2 * 1024 * 1024;

/** PhpStorm "Sync with Deployed to…": side-by-side comparison with per-file direction and a Synchronize action. */
export class SyncPanel {
  private static readonly open = new Map<string, SyncPanel>();
  private items: SyncItem[] = [];
  private running = false;
  private readonly disposables: vscode.Disposable[] = [];

  static show(s: Services, server: ResolvedServer, localRoots: string[]): void {
    const key = `${server.id}|${localRoots.join('|')}`;
    const existing = SyncPanel.open.get(key);
    if (existing) {
      existing.panel.reveal();
      void existing.compare(false);
      return;
    }
    const scope = localRoots.map((r) => relative(server.project.root, r) || basename(r) || r).join(', ');
    const panel = vscode.window.createWebviewPanel('iremote.sync', `Sync: ${server.name} — ${scope}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(s.context.extensionUri, 'dist', 'webview')],
    });
    SyncPanel.open.set(key, new SyncPanel(s, panel, server, localRoots, key, scope));
  }

  private constructor(
    private readonly s: Services,
    private readonly panel: vscode.WebviewPanel,
    private readonly server: ResolvedServer,
    private readonly localRoots: string[],
    private readonly key: string,
    private readonly scope: string,
  ) {
    panel.iconPath = {
      light: vscode.Uri.joinPath(s.context.extensionUri, 'media', 'sync-light.svg'),
      dark: vscode.Uri.joinPath(s.context.extensionUri, 'media', 'sync-dark.svg'),
    };
    panel.webview.html = webviewHtml(panel.webview, s.context.extensionUri, 'sync', 'Sync');
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: SyncToHost) => void this.onMessage(m)),
    );
  }

  private post(msg: SyncToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  private toUi(i: SyncItem): UiSyncItem {
    return {
      id: i.id,
      rel: relative(this.server.project.root, i.localPath).split('\\').join('/'),
      remotePath: i.remotePath,
      localPath: i.localPath,
      localSize: i.local?.size,
      localMtime: i.local?.mtime,
      remoteSize: i.remote?.size,
      remoteMtime: i.remote?.mtime,
      state: i.state,
      action: i.action,
      wasSynced: i.wasSynced,
    };
  }

  private async onMessage(m: SyncToHost): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'init', serverName: this.server.name, scope: this.scope, canCompareContents: true });
        return this.compare(false);
      case 'refresh':
        return this.compare(m.compareContents);
      case 'diff': {
        const item = this.items.find((i) => i.id === m.id);
        if (!item) return;
        if (item.local && item.remote) {
          await vscode.commands.executeCommand(
            'vscode.diff',
            remoteUri(this.server.id, item.remotePath),
            vscode.Uri.file(item.localPath),
            `${basename(item.localPath)} (${this.server.name} ↔ Local)`,
            { viewColumn: vscode.ViewColumn.Beside, preview: true },
          );
        } else {
          await this.openSide(item, item.local ? 'local' : 'remote');
        }
        return;
      }
      case 'open': {
        const item = this.items.find((i) => i.id === m.id);
        if (item) await this.openSide(item, m.side);
        return;
      }
      case 'run':
        return this.run(m.items);
    }
  }

  private async openSide(item: SyncItem, side: 'local' | 'remote'): Promise<void> {
    const uri = side === 'local' ? vscode.Uri.file(item.localPath) : remoteUri(this.server.id, item.remotePath);
    await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  }

  private async compare(compareContents: boolean): Promise<void> {
    if (this.running) return;
    this.post({ type: 'loading', message: `Comparing with ${this.server.name}…` });
    const target = this.s.config.target(this.server);
    try {
      this.items = await this.s.deployer.withClient(target, (c) =>
        this.s.sync.compare(c, target, this.localRoots, { compareContents, maxDownloadCompareBytes: MAX_DOWNLOAD_COMPARE }),
      );
      this.post({ type: 'items', items: this.items.map((i) => this.toUi(i)) });
    } catch (e) {
      if (isRemoteError(e, 'Cancelled')) return;
      log.error(`Sync comparison with ${this.server.name}`, e);
      this.post({ type: 'error', message: errorMessage(e) });
    }
  }

  private async run(requested: { id: number; action: SyncAction }[]): Promise<void> {
    if (this.running) return;
    const work = requested
      .map((r) => ({ item: this.items.find((i) => i.id === r.id), action: r.action }))
      .filter((w): w is { item: SyncItem; action: SyncAction } => !!w.item && w.action !== 'skip');
    if (work.length === 0) return;

    const deletesRemote = work.filter((w) => w.action === 'deleteRemote').length;
    const deletesLocal = work.filter((w) => w.action === 'deleteLocal').length;
    if (deletesRemote || deletesLocal) {
      const parts = [deletesRemote ? `${deletesRemote} file(s) on ${this.server.name}` : '', deletesLocal ? `${deletesLocal} local file(s) (moved to trash)` : '']
        .filter(Boolean)
        .join(' and ');
      const ok = await vscode.window.showWarningMessage(`Synchronization will delete ${parts}.`, { modal: true }, 'Synchronize');
      if (!ok) return;
    }

    this.running = true;
    const target = this.s.config.target(this.server);
    const { deployer, queue } = this.s;
    let transferred = 0;
    let failed = 0;
    const one = async ({ item, action }: { item: SyncItem; action: SyncAction }) => {
      this.post({ type: 'itemStatus', id: item.id, status: 'running' });
      try {
        switch (action) {
          case 'upload': {
            const r = await deployer.uploadFile(target, item.localPath, false);
            if (r.failed.length) throw r.failed[0].error;
            break;
          }
          case 'download': {
            const r = await deployer.downloadFile(target, item.remotePath, item.localPath);
            if (r.failed.length) throw r.failed[0].error;
            break;
          }
          case 'deleteRemote':
            await deployer.deleteRemote(target, item.remotePath, false);
            break;
          case 'deleteLocal':
            await vscode.workspace.fs.delete(vscode.Uri.file(item.localPath), { useTrash: true });
            this.s.cache.delete(this.server.id, item.remotePath);
            break;
          case 'skip':
            break;
        }
        transferred++;
        this.post({ type: 'itemStatus', id: item.id, status: 'done' });
      } catch (e) {
        failed++;
        log.error(`Sync ${action} ${item.remotePath}`, e);
        this.post({ type: 'itemStatus', id: item.id, status: 'failed', error: errorMessage(e) });
        if (isRemoteError(e, 'Cancelled')) throw e;
      }
    };
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Synchronizing with ${this.server.name}`, cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => void queue.cancel(this.server.id));
          let done = 0;
          await Promise.all(
            work.map((w) =>
              one(w).finally(() => {
                done++;
                progress.report({ message: `${done}/${work.length}`, increment: 100 / work.length });
              }),
            ),
          );
        },
      );
    } catch (e) {
      if (!isRemoteError(e, 'Cancelled')) log.error('Synchronization', e);
    } finally {
      this.running = false;
      this.post({ type: 'finished', transferred, failed });
      this.s.tree.refresh();
    }
  }

  private dispose(): void {
    SyncPanel.open.delete(this.key);
    this.disposables.forEach((d) => d.dispose());
  }
}
