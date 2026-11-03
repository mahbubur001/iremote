import * as vscode from 'vscode';
import { posix } from 'node:path';
import { RemoteError, isRemoteError, type RemoteClient, type RemoteStat } from '../protocol/types';
import type { ServerManager } from '../core/ServerManager';
import type { ConfigStore } from '../config/ConfigStore';
import { parseRemoteUri, SCHEME } from './uri';

interface Version {
  mtime: number;
  size: number;
}

const STAT_TTL_MS = 3000;

/**
 * Exposes deployment servers as a VS Code file system (iremote://<serverId>/<path>), so remote files open in the
 * regular editor and saving writes straight to the server — the equivalent of PhpStorm's "Edit Remote File".
 */
export class RemoteFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  private readonly statCache = new Map<string, { stat: RemoteStat | undefined; at: number }>();
  /** Remote version last read into (or written from) an editor; used to detect concurrent server-side edits. */
  private readonly versions = new Map<string, Version>();

  constructor(
    private readonly servers: ServerManager,
    private readonly config: ConfigStore,
  ) {}

  private pool(uri: vscode.Uri) {
    const { serverId } = parseRemoteUri(uri);
    const server = this.config.findServer(serverId);
    if (!server) throw vscode.FileSystemError.Unavailable(`Server "${serverId}" is not configured.`);
    return { pool: this.servers.pool(server), server };
  }

  private toFsError(e: unknown, uri: vscode.Uri): Error {
    if (e instanceof vscode.FileSystemError) return e;
    if (!(e instanceof RemoteError)) return e instanceof Error ? e : new Error(String(e));
    switch (e.code) {
      case 'NotFound':
        return vscode.FileSystemError.FileNotFound(uri);
      case 'Exists':
        return vscode.FileSystemError.FileExists(uri);
      case 'Permission':
        return vscode.FileSystemError.NoPermissions(uri);
      case 'Connection':
      case 'Auth':
      case 'HostKey':
      case 'Certificate':
      case 'Cancelled':
        return vscode.FileSystemError.Unavailable(e.message);
      default:
        return new Error(e.message);
    }
  }

  private async run<T>(uri: vscode.Uri, fn: (c: RemoteClient) => Promise<T>): Promise<T> {
    try {
      return await this.pool(uri).pool.use(fn);
    } catch (e) {
      throw this.toFsError(e, uri);
    }
  }

  private invalidate(uri: vscode.Uri): void {
    this.statCache.delete(uri.toString());
    this.statCache.delete(uri.with({ path: posix.dirname(uri.path) }).toString());
  }

  private async remoteStat(uri: vscode.Uri, fresh = false): Promise<RemoteStat | undefined> {
    const key = uri.toString();
    const cached = this.statCache.get(key);
    if (!fresh && cached && Date.now() - cached.at < STAT_TTL_MS) return cached.stat;
    const stat = await this.run(uri, (c) => c.stat(parseRemoteUri(uri).path));
    this.statCache.set(key, { stat, at: Date.now() });
    return stat;
  }

  private fileType(st: RemoteStat): vscode.FileType {
    if (st.type === 'dir') return vscode.FileType.Directory;
    if (st.type === 'symlink') return vscode.FileType.SymbolicLink | (st.targetType === 'dir' ? vscode.FileType.Directory : vscode.FileType.File);
    return vscode.FileType.File;
  }

  watch(): vscode.Disposable {
    // Change notifications come from RemoteChangeMonitor (focus-based polling of open editors).
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const st = await this.remoteStat(uri);
    if (!st) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: this.fileType(st), ctime: st.mtime, mtime: st.mtime, size: st.size };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const dir = parseRemoteUri(uri).path;
    const entries = await this.run(uri, (c) => c.list(dir));
    const now = Date.now();
    for (const e of entries) this.statCache.set(uri.with({ path: posix.join(dir, e.name) }).toString(), { stat: e, at: now });
    return entries.map((e) => [e.name, this.fileType(e)]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const path = parseRemoteUri(uri).path;
    const { data, st } = await this.run(uri, async (c) => {
      const st = await c.stat(path);
      if (!st) throw new RemoteError('NotFound', `No such file: ${path}`, path);
      if (st.type === 'dir') throw vscode.FileSystemError.FileIsADirectory(uri);
      return { data: await c.readFile(path), st };
    });
    this.versions.set(uri.toString(), { mtime: st.mtime, size: st.size });
    this.statCache.set(uri.toString(), { stat: st, at: Date.now() });
    return data;
  }

  /** The remote version last loaded into an editor, if any. */
  knownVersion(uri: vscode.Uri): Version | undefined {
    return this.versions.get(uri.toString());
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const path = parseRemoteUri(uri).path;
    const { server } = this.pool(uri);
    const existing = await this.remoteStat(uri, true);
    if (existing?.type === 'dir') throw vscode.FileSystemError.FileIsADirectory(uri);
    if (!existing && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    if (existing && options.create && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);

    const known = this.versions.get(uri.toString());
    if (existing && known && existing.mtime > 0 && (existing.mtime !== known.mtime || existing.size !== known.size)) {
      const choice = await vscode.window.showWarningMessage(
        `"${posix.basename(path)}" was changed on ${server.name} after you opened it.`,
        { modal: true, detail: 'Saving will overwrite the changes made on the server.' },
        'Overwrite',
      );
      if (choice !== 'Overwrite') throw vscode.FileSystemError.Unavailable('Save cancelled: the remote file changed.');
    }

    const project = server.project;
    const mode = /^[0-7]{3,4}$/.test(project.config.options.filePermissions) ? parseInt(project.config.options.filePermissions, 8) : undefined;
    const st = await this.run(uri, async (c) => {
      await c.writeFile(path, Buffer.from(content));
      if (!existing && mode !== undefined && c.capabilities.chmod) await c.chmod(path, mode).catch(() => undefined);
      return c.stat(path);
    });
    if (st) this.versions.set(uri.toString(), { mtime: st.mtime, size: st.size });
    this.invalidate(uri);
    this.emitter.fire([{ type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const path = parseRemoteUri(uri).path;
    if (await this.remoteStat(uri, true)) throw vscode.FileSystemError.FileExists(uri);
    const parent = uri.with({ path: posix.dirname(path) });
    if (!(await this.remoteStat(parent, true))) throw vscode.FileSystemError.FileNotFound(parent);
    await this.run(uri, (c) => c.mkdirp(path));
    this.invalidate(uri);
    this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const path = parseRemoteUri(uri).path;
    const st = await this.remoteStat(uri, true);
    if (!st) throw vscode.FileSystemError.FileNotFound(uri);
    await this.run(uri, (c) => (st.type === 'dir' ? c.deleteDir(path, options.recursive) : c.deleteFile(path)));
    this.invalidate(uri);
    this.versions.delete(uri.toString());
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (oldUri.authority !== newUri.authority) throw vscode.FileSystemError.NoPermissions('Cannot move files between servers.');
    const from = parseRemoteUri(oldUri).path;
    const to = parseRemoteUri(newUri).path;
    const target = await this.remoteStat(newUri, true);
    if (target && !options.overwrite) throw vscode.FileSystemError.FileExists(newUri);
    await this.run(oldUri, async (c) => {
      if (target && target.type !== 'dir') await c.deleteFile(to).catch((e) => (isRemoteError(e, 'NotFound') ? undefined : Promise.reject(e)));
      await c.rename(from, to);
    });
    this.invalidate(oldUri);
    this.invalidate(newUri);
    this.versions.delete(oldUri.toString());
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  /** Signals a server-side change (from the monitor or another iRemote operation) so editors reload. */
  notifyChanged(uris: vscode.Uri[]): void {
    uris.forEach((u) => this.invalidate(u));
    if (uris.length) this.emitter.fire(uris.map((uri) => ({ type: vscode.FileChangeType.Changed, uri })));
  }

  /** Called after a reload so the next save compares against the fresh version. */
  forgetVersion(uri: vscode.Uri): void {
    this.versions.delete(uri.toString());
  }

  static register(context: vscode.ExtensionContext, provider: RemoteFileSystemProvider): void {
    context.subscriptions.push(
      vscode.workspace.registerFileSystemProvider(SCHEME, provider, { isCaseSensitive: true }),
      provider,
    );
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
