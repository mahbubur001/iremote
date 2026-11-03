import * as vscode from 'vscode';
import type { TaskInfo, TransferQueue } from '../core/TransferQueue';

const ICONS: Record<TaskInfo['status'], [string, string?]> = {
  queued: ['clock'],
  running: ['sync~spin'],
  done: ['pass', 'testing.iconPassed'],
  failed: ['error', 'testing.iconFailed'],
  cancelled: ['circle-slash', 'disabledForeground'],
};

const ARROWS: Record<TaskInfo['kind'], string> = {
  upload: '↑',
  download: '↓',
  delete: '✕',
  mkdir: '+',
  rename: '→',
  chmod: '⚙',
};

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

const shortPath = (p: string): string => {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : p;
};

/** PhpStorm "File Transfer" tool window: every operation with direction, status, progress and error. */
export class TransferView implements vscode.TreeDataProvider<TaskInfo>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TaskInfo | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly view: vscode.TreeView<TaskInfo>;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer?: NodeJS.Timeout;

  constructor(private readonly queue: TransferQueue) {
    this.view = vscode.window.createTreeView('iremote.transfers', { treeDataProvider: this });
    this.disposables.push(this.view, this.emitter);
    const schedule = () => {
      if (this.refreshTimer) return;
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = undefined;
        this.emitter.fire(undefined);
        this.updateBadge();
      }, 150);
    };
    queue.on('changed', schedule);
    queue.on('idle', schedule);
    this.disposables.push(new vscode.Disposable(() => {
      queue.off('changed', schedule);
      queue.off('idle', schedule);
    }));
  }

  private updateBadge(): void {
    const pending = this.queue.pendingCount;
    this.view.badge = pending ? { value: pending, tooltip: `${pending} transfer(s) in progress` } : undefined;
  }

  getTreeItem(t: TaskInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(`${ARROWS[t.kind]} ${shortPath(t.target)}`);
    const [icon, color] = ICONS[t.status];
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    const time = new Date(t.finishedAt ?? t.startedAt ?? t.queuedAt).toLocaleTimeString();
    const progress = t.status === 'running' && t.total ? ` ${Math.round((t.bytes / t.total) * 100)}%` : '';
    item.description = `${t.serverName} · ${time}${progress}${t.error ? ` · ${t.error}` : ''}`;
    const duration = t.startedAt && t.finishedAt ? `${((t.finishedAt - t.startedAt) / 1000).toFixed(2)} s` : '';
    item.tooltip = new vscode.MarkdownString(
      [
        `**${t.kind}** — ${t.status}`,
        `From: \`${t.source}\``,
        `To: \`${t.target}\``,
        `Server: ${t.serverName}`,
        t.total ? `Size: ${formatBytes(t.total)}` : '',
        duration ? `Duration: ${duration}` : '',
        t.error ? `Error: ${t.error}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    if (t.kind === 'upload' && t.status !== 'failed') {
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(t.source)] };
    } else if (t.kind === 'download' && t.status === 'done') {
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(t.target)] };
    }
    return item;
  }

  getChildren(parent?: TaskInfo): TaskInfo[] {
    return parent ? [] : [...this.queue.tasks];
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}
