import * as vscode from 'vscode';
import { posix } from 'node:path';
import type { ConfigStore, ResolvedServer } from '../config/ConfigStore';
import type { ServerManager } from '../core/ServerManager';
import { SERVER_TYPE_LABELS } from '../config/schema';
import { errorMessage, type RemoteEntry, type RemoteStat } from '../protocol/types';
import { remoteUri } from '../fs/uri';

export type RemoteNode =
  | { kind: 'server'; server: ResolvedServer }
  | { kind: 'entry'; server: ResolvedServer; path: string; stat: RemoteStat }
  | { kind: 'error'; server: ResolvedServer; path: string; message: string };

const SELECTED_KEY = 'iremote.remoteHost.selectedServer';
const TREE_MIME = 'application/vnd.code.tree.iremote.remotehost';

export interface TreeHandlers {
  dropFiles: (server: ResolvedServer, targetDir: string, files: vscode.Uri[]) => Promise<void>;
  move: (server: ResolvedServer, sources: string[], targetDir: string) => Promise<void>;
}

export const isDirStat = (st: RemoteStat): boolean => st.type === 'dir' || (st.type === 'symlink' && st.targetType === 'dir');

export const nodePath = (n: RemoteNode): string => (n.kind === 'server' ? n.server.rootPath || '/' : n.path);

export class RemoteHostTree implements vscode.TreeDataProvider<RemoteNode>, vscode.TreeDragAndDropController<RemoteNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<RemoteNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly dropMimeTypes = [TREE_MIME, 'text/uri-list'];
  readonly dragMimeTypes = [TREE_MIME];

  private readonly disposables: vscode.Disposable[] = [];
  private readonly view: vscode.TreeView<RemoteNode>;
  private handlers?: TreeHandlers;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly config: ConfigStore,
    private readonly servers: ServerManager,
  ) {
    this.view = vscode.window.createTreeView('iremote.remoteHost', {
      treeDataProvider: this,
      dragAndDropController: this,
      showCollapseAll: false,
      canSelectMany: true,
    });
    this.disposables.push(
      this.view,
      this.emitter,
      config.onDidChange(() => this.refresh()),
      servers.onDidChangeConnection(() => this.emitter.fire(undefined)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('iremote.remoteHost') && this.refresh()),
    );
    this.updateMessage();
  }

  /** Drag-and-drop actions are supplied by the command layer, which owns the transfer logic. */
  setHandlers(handlers: TreeHandlers): void {
    this.handlers = handlers;
  }

  get treeView(): vscode.TreeView<RemoteNode> {
    return this.view;
  }

  get selectedServerId(): string | undefined {
    return this.context.workspaceState.get<string>(SELECTED_KEY);
  }

  async selectServer(id: string | undefined): Promise<void> {
    await this.context.workspaceState.update(SELECTED_KEY, id);
    this.refresh();
  }

  /** Like PhpStorm, Remote Host shows one server: the chosen one, else a project's default server, else the first. */
  get currentServer(): ResolvedServer | undefined {
    const all = this.config.uniqueServers();
    const sel = this.selectedServerId;
    return all.find((s) => s.id === sel) ?? all.find((s) => s.project.config.defaultServer === s.id) ?? all[0];
  }

  private updateMessage(): void {
    this.view.description = this.currentServer?.name;
  }

  refresh(node?: RemoteNode): void {
    this.updateMessage();
    this.emitter.fire(node);
  }

  getTreeItem(node: RemoteNode): vscode.TreeItem {
    if (node.kind === 'server') {
      const { server } = node;
      const connected = this.servers.isConnected(server.id);
      const item = new vscode.TreeItem(server.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `server:${server.id}`;
      const isDefault = server.project.config.defaultServer === server.id;
      item.description = `${SERVER_TYPE_LABELS[server.type]} · ${server.type === 'local' ? server.rootPath : server.host}${isDefault ? ' · default' : ''}`;
      item.tooltip = new vscode.MarkdownString(
        `**${server.name}**${isDefault ? ' (default)' : ''}\n\n${SERVER_TYPE_LABELS[server.type]} — ${server.host}${server.port ? `:${server.port}` : ''}\n\nRoot: \`${server.rootPath}\`\n\n${connected ? 'Connected' : 'Not connected'}`,
      );
      item.iconPath = new vscode.ThemeIcon(connected ? 'vm-active' : 'vm-outline', isDefault ? new vscode.ThemeColor('charts.blue') : undefined);
      const target = this.config.target(server);
      item.contextValue = ['remote-server', target.mapper.hasMappings ? 'mapped' : '', server.webUrl ? 'web' : '', server.type === 'sftp' ? 'ssh' : '']
        .filter(Boolean)
        .join(';');
      return item;
    }
    if (node.kind === 'error') {
      const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      item.tooltip = node.message;
      item.command = { command: 'iremote.remote.refresh', title: 'Retry', arguments: [] };
      return item;
    }
    const { server, path, stat } = node;
    const dir = isDirStat(stat);
    const item = new vscode.TreeItem(posix.basename(path), dir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `${server.id}:${path}`;
    item.resourceUri = remoteUri(server.id, path);
    const target = this.config.target(server);
    const local = target.mapper.toLocal(path);
    const excluded = target.mapper.isRemoteExcluded(path);
    const mapped = !!local && !excluded;
    const web = !!target.mapper.webUrlForRemote(path);
    item.contextValue = [dir ? 'remote-dir' : 'remote-file', mapped ? 'mapped' : '', web ? 'web' : '', server.type !== 'webdav' ? 'chmod' : '', server.type === 'sftp' ? 'ssh' : '']
      .filter(Boolean)
      .join(';');
    const mtime = stat.mtime ? new Date(stat.mtime).toLocaleString() : 'unknown';
    const lines = [
      `\`${path}\``,
      dir ? '' : `Size: ${stat.size.toLocaleString()} bytes`,
      `Modified: ${mtime}`,
      stat.mode !== undefined ? `Permissions: ${stat.mode.toString(8).padStart(3, '0')}` : '',
      stat.type === 'symlink' ? 'Symbolic link' : '',
      mapped ? `Local: \`${local}\`` : excluded ? 'Excluded from deployment' : 'Not mapped to a local path',
    ];
    item.tooltip = new vscode.MarkdownString(lines.filter(Boolean).join('\n\n'));
    if (!dir) {
      item.description = stat.type === 'symlink' ? '→ link' : undefined;
      item.command = { command: 'iremote.remote.open', title: 'Open', arguments: [node] };
    } else if (stat.type === 'symlink') {
      item.description = '→ link';
    }
    return item;
  }

  async getChildren(node?: RemoteNode): Promise<RemoteNode[]> {
    if (!node) {
      const server = this.currentServer;
      return server ? [{ kind: 'server', server }] : [];
    }
    if (node.kind === 'error') return [];
    if (node.kind === 'entry' && !isDirStat(node.stat)) return [];
    const dir = nodePath(node);
    const { server } = node;
    let entries: RemoteEntry[];
    try {
      entries = await this.servers.pool(server).use((c) => c.list(dir));
    } catch (e) {
      return [{ kind: 'error', server, path: dir, message: errorMessage(e) }];
    }
    const showHidden = vscode.workspace.getConfiguration('iremote').get<boolean>('remoteHost.showHiddenFiles', true);
    return entries
      .filter((e) => showHidden || !e.name.startsWith('.'))
      .sort((a, b) => Number(isDirStat(b)) - Number(isDirStat(a)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      .map((e) => ({ kind: 'entry', server, path: posix.join(dir, e.name), stat: e }));
  }

  getParent(node: RemoteNode): RemoteNode | undefined {
    if (node.kind === 'server') return undefined;
    const root = posix.normalize(node.server.rootPath || '/');
    const parent = posix.dirname(node.path);
    if (parent === root || parent === node.path || !parent.startsWith(root)) return { kind: 'server', server: node.server };
    return { kind: 'entry', server: node.server, path: parent, stat: { type: 'dir', size: 0, mtime: 0 } };
  }

  /** Expands the tree down to a remote path and selects it. */
  async reveal(server: ResolvedServer, path: string, stat: RemoteStat): Promise<void> {
    await this.view.reveal({ kind: 'entry', server, path, stat }, { select: true, focus: true, expand: isDirStat(stat) });
  }

  handleDrag(source: readonly RemoteNode[], data: vscode.DataTransfer): void {
    const entries = source.filter((n): n is Extract<RemoteNode, { kind: 'entry' }> => n.kind === 'entry');
    if (entries.length) data.set(TREE_MIME, new vscode.DataTransferItem(entries.map((e) => ({ serverId: e.server.id, path: e.path }))));
  }

  async handleDrop(target: RemoteNode | undefined, data: vscode.DataTransfer): Promise<void> {
    if (!target || target.kind === 'error') return;
    const server = target.server;
    const targetDir = target.kind === 'server' ? nodePath(target) : isDirStat(target.stat) ? target.path : posix.dirname(target.path);

    const internal = data.get(TREE_MIME);
    if (internal) {
      const items = internal.value as { serverId: string; path: string }[];
      const sources = items.filter((i) => i.serverId === server.id && posix.dirname(i.path) !== targetDir && i.path !== targetDir).map((i) => i.path);
      if (sources.length) await this.handlers?.move(server, sources, targetDir);
      return;
    }
    const uriList = await data.get('text/uri-list')?.asString();
    if (!uriList) return;
    const files = uriList
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => vscode.Uri.parse(l))
      .filter((u) => u.scheme === 'file');
    if (files.length) await this.handlers?.dropFiles(server, targetDir, files);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
