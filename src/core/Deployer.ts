import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { posix, dirname, join, normalize } from 'node:path';
import type { DeploymentOptions, ServerConfig } from '../config/schema';
import { RemoteError, type RemoteClient, type RemoteStat } from '../protocol/types';
import type { PathMapper } from './PathMapper';
import type { StateCache } from './StateCache';
import type { TransferQueue } from './TransferQueue';
import type { ConnectionPool } from './ConnectionPool';

export interface DeploymentTarget {
  server: ServerConfig;
  projectRoot: string;
  options: DeploymentOptions;
  mapper: PathMapper;
}

export interface ConflictInfo {
  target: DeploymentTarget;
  localPath: string;
  remotePath: string;
  remote: RemoteStat;
  reason: string;
}

export type ConflictDecision = 'overwrite' | 'skip';

export interface DeployHooks {
  /** Asked when the remote file changed since the last transfer. Throw a Cancelled RemoteError to stop. */
  onConflict(info: ConflictInfo): Promise<ConflictDecision>;
  log(message: string): void;
}

export interface TransferResult {
  transferred: number;
  skipped: number;
  failed: { path: string; error: unknown }[];
}

const emptyResult = (): TransferResult => ({ transferred: 0, skipped: 0, failed: [] });

export const sha1File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash('sha1');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });

export const sha1Buffer = (b: Buffer): string => createHash('sha1').update(b).digest('hex');

const parseMode = (s: string): number | undefined => {
  const t = s.trim();
  return /^[0-7]{3,4}$/.test(t) ? parseInt(t, 8) : undefined;
};

/** Size and mtime tolerances: FTP/SFTP report whole seconds. */
const sameTime = (a: number, b: number) => Math.abs(a - b) < 2000;

export class Deployer {
  /** Local paths recently written by downloads; auto-upload must not echo them back to the server. */
  private readonly ownWrites = new Map<string, number>();

  constructor(
    private readonly queue: TransferQueue,
    private readonly cache: StateCache,
    private readonly hooks: DeployHooks,
    private readonly getPool: (serverId: string) => ConnectionPool,
  ) {}

  /** Runs an ad-hoc operation (listing, stat) outside the transfer queue. */
  withClient<T>(t: DeploymentTarget, fn: (client: RemoteClient) => Promise<T>): Promise<T> {
    return this.getPool(t.server.id).use(fn);
  }

  isOwnLocalWrite(localPath: string): boolean {
    const key = normalize(localPath);
    const until = this.ownWrites.get(key);
    if (until === undefined) return false;
    if (Date.now() > until) {
      this.ownWrites.delete(key);
      return false;
    }
    return true;
  }

  private markOwnWrite(localPath: string): void {
    const now = Date.now();
    for (const [p, until] of this.ownWrites) if (until < now) this.ownWrites.delete(p);
    this.ownWrites.set(normalize(localPath), now + 5000);
  }

  /** Creates missing directories top-down, applying folder permissions to the ones it creates. */
  async ensureRemoteDir(client: RemoteClient, t: DeploymentTarget, dir: string): Promise<void> {
    const missing: string[] = [];
    let d = posix.normalize(dir);
    while (d !== '/' && d !== '.' && !(await client.stat(d))) {
      missing.unshift(d);
      const up = posix.dirname(d);
      if (up === d) break;
      d = up;
    }
    const mode = parseMode(t.options.folderPermissions);
    for (const m of missing) {
      await client.mkdirp(m);
      if (mode !== undefined && client.capabilities.chmod) await client.chmod(m, mode).catch((e) => this.hooks.log(`chmod ${m}: ${e}`));
    }
  }

  /** Decides whether the remote copy changed since we last transferred it (PhpStorm "Warn when uploading over newer file"). */
  private async detectConflict(client: RemoteClient, t: DeploymentTarget, localPath: string, remotePath: string): Promise<ConflictInfo | undefined> {
    const mode = t.options.warnOnNewerRemote;
    if (mode === 'none') return undefined;
    const remote = await client.stat(remotePath);
    if (!remote || remote.type === 'dir') return undefined;
    const record = this.cache.get(t.server.id, remotePath);
    let reason: string | undefined;
    if (record) {
      const timeKnown = remote.mtime > 0 && record.remoteMtime > 0;
      const changed = remote.size !== record.remoteSize || (timeKnown && !sameTime(remote.mtime, record.remoteMtime));
      if (changed) reason = 'The remote file was modified after it was last uploaded or downloaded.';
    } else if (remote.mtime > 0) {
      const local = await fs.stat(localPath);
      if (remote.mtime > local.mtimeMs + 2000) reason = 'The remote file is newer than the local file.';
    }
    if (!reason) return undefined;
    if (mode === 'content') {
      const [remoteData, localData] = await Promise.all([client.readFile(remotePath), fs.readFile(localPath)]);
      if (remoteData.equals(localData)) return undefined;
      if (record?.sha1 && sha1Buffer(remoteData) === record.sha1) return undefined;
    }
    return { target: t, localPath, remotePath, remote, reason };
  }

  /** Records the post-transfer state so later conflict checks and syncs are accurate. */
  async remember(client: RemoteClient, t: DeploymentTarget, localPath: string, remotePath: string, sha1?: string): Promise<void> {
    const [remote, local] = await Promise.all([client.stat(remotePath), fs.stat(localPath)]);
    if (!remote) return;
    this.cache.set(t.server.id, remotePath, {
      remoteMtime: remote.mtime,
      remoteSize: remote.size,
      localMtime: local.mtimeMs,
      localSize: local.size,
      sha1: sha1 ?? (await sha1File(localPath)),
    });
  }

  /** Uploads one file through an already-leased client. Returns false if the user chose to skip. */
  async uploadWithClient(
    client: RemoteClient,
    t: DeploymentTarget,
    localPath: string,
    remotePath: string,
    opts: { checkConflict: boolean; progress?: (b: number, total: number) => void },
  ): Promise<boolean> {
    if (opts.checkConflict) {
      const conflict = await this.detectConflict(client, t, localPath, remotePath);
      if (conflict && (await this.hooks.onConflict(conflict)) === 'skip') return false;
    }
    try {
      await client.upload(localPath, remotePath, opts.progress);
    } catch (e) {
      // Servers report a missing parent as "no such file" or a generic failure; retry only if the parent is really missing.
      if (!(e instanceof RemoteError) || (e.code !== 'NotFound' && e.code !== 'Unknown')) throw e;
      const parent = posix.dirname(remotePath);
      if (await client.stat(parent)) throw e;
      await this.ensureRemoteDir(client, t, parent);
      await client.upload(localPath, remotePath, opts.progress);
    }
    const local = await fs.stat(localPath);
    if (t.options.preserveTimestamps && client.capabilities.setMtime) {
      await client.setMtime(remotePath, local.mtimeMs).catch((e) => this.hooks.log(`Cannot preserve timestamp on ${remotePath}: ${e}`));
    }
    const mode = parseMode(t.options.filePermissions);
    if (mode !== undefined && client.capabilities.chmod) {
      await client.chmod(remotePath, mode).catch((e) => this.hooks.log(`Cannot chmod ${remotePath}: ${e}`));
    }
    await this.remember(client, t, localPath, remotePath);
    return true;
  }

  /** Queues a single file upload. */
  uploadFile(t: DeploymentTarget, localPath: string, checkConflict: boolean, result = emptyResult()): Promise<TransferResult> {
    const remotePath = t.mapper.toRemote(localPath);
    if (!remotePath) return Promise.resolve(result);
    return this.queue
      .enqueue({
        kind: 'upload',
        serverId: t.server.id,
        serverName: t.server.name,
        source: localPath,
        target: remotePath,
        key: `${t.server.id}:${remotePath}`,
        run: async (client, progress) => {
          const done = await this.uploadWithClient(client, t, localPath, remotePath, { checkConflict, progress });
          if (done) result.transferred++;
          else result.skipped++;
        },
      })
      .then(
        () => result,
        (error) => {
          if (error instanceof RemoteError && error.code === 'Cancelled') throw error;
          result.failed.push({ path: localPath, error });
          return result;
        },
      );
  }

  /** Recursively collects deployable files (and directories, for empty-dir creation) under the given local paths. */
  async collectLocal(t: DeploymentTarget, roots: string[]): Promise<{ files: string[]; dirs: string[] }> {
    const files: string[] = [];
    const dirs: string[] = [];
    const seen = new Set<string>();
    const walk = async (p: string): Promise<void> => {
      if (t.mapper.isLocalExcluded(p) || !t.mapper.toRemote(p)) return;
      let st;
      try {
        st = await fs.stat(p);
      } catch {
        return;
      }
      if (st.isDirectory()) {
        const real = await fs.realpath(p);
        if (seen.has(real)) return;
        seen.add(real);
        dirs.push(p);
        const names = await fs.readdir(p);
        for (const name of names) await walk(join(p, name));
      } else if (st.isFile()) {
        files.push(p);
      }
    };
    for (const r of roots) await walk(r);
    return { files, dirs };
  }

  /** Upload files and folders (PhpStorm "Upload to…"). */
  async upload(t: DeploymentTarget, localPaths: string[], checkConflict: boolean): Promise<TransferResult> {
    const result = emptyResult();
    const { files, dirs } = await this.collectLocal(t, localPaths);
    if (t.options.createEmptyDirectories) {
      const withFiles = new Set(files.map((f) => dirname(f)));
      const empty = dirs.filter((d) => !withFiles.has(d) && !dirs.some((o) => o !== d && dirname(o) === d));
      await Promise.all(empty.map((d) => this.mkdir(t, t.mapper.toRemote(d)!).catch((error) => result.failed.push({ path: d, error }))));
    }
    await Promise.all(files.map((f) => this.uploadFile(t, f, checkConflict, result)));
    return result;
  }

  mkdir(t: DeploymentTarget, remotePath: string): Promise<void> {
    return this.queue.enqueue({
      kind: 'mkdir',
      serverId: t.server.id,
      serverName: t.server.name,
      source: remotePath,
      target: remotePath,
      key: `${t.server.id}:${remotePath}`,
      run: (client) => this.ensureRemoteDir(client, t, remotePath),
    });
  }

  /** Downloads one remote file to a local path, creating local folders and recording state. */
  async downloadWithClient(
    client: RemoteClient,
    t: DeploymentTarget,
    remotePath: string,
    localPath: string,
    progress?: (b: number, total: number) => void,
  ): Promise<void> {
    await fs.mkdir(dirname(localPath), { recursive: true });
    const tmp = `${localPath}.iremote-download`;
    this.markOwnWrite(tmp);
    this.markOwnWrite(localPath);
    try {
      await client.download(remotePath, tmp, progress);
      await fs.rename(tmp, localPath);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    const remote = await client.stat(remotePath);
    if (remote && remote.mtime > 0 && t.options.preserveTimestamps) {
      const time = new Date(remote.mtime);
      await fs.utimes(localPath, time, time).catch(() => undefined);
    }
    this.markOwnWrite(localPath);
    await this.remember(client, t, localPath, remotePath);
  }

  downloadFile(t: DeploymentTarget, remotePath: string, localPath: string, result = emptyResult()): Promise<TransferResult> {
    return this.queue
      .enqueue({
        kind: 'download',
        serverId: t.server.id,
        serverName: t.server.name,
        source: remotePath,
        target: localPath,
        key: `${t.server.id}:${remotePath}`,
        run: async (client, progress) => {
          await this.downloadWithClient(client, t, remotePath, localPath, progress);
          result.transferred++;
        },
      })
      .then(
        () => result,
        (error) => {
          if (error instanceof RemoteError && error.code === 'Cancelled') throw error;
          result.failed.push({ path: remotePath, error });
          return result;
        },
      );
  }

  /** Recursively lists remote files under a path, honoring remote excludes. */
  async collectRemote(client: RemoteClient, t: DeploymentTarget, root: string): Promise<{ files: { path: string; stat: RemoteStat }[]; dirs: string[] }> {
    const files: { path: string; stat: RemoteStat }[] = [];
    const dirs: string[] = [];
    const walk = async (p: string, st: RemoteStat): Promise<void> => {
      if (t.mapper.isRemoteExcluded(p)) return;
      const isDir = st.type === 'dir' || (st.type === 'symlink' && st.targetType === 'dir');
      if (!isDir) {
        files.push({ path: p, stat: st });
        return;
      }
      if (st.type === 'symlink') return; // Do not descend through remote directory links (loop risk).
      dirs.push(p);
      for (const e of await client.list(p)) await walk(posix.join(p, e.name), e);
    };
    const st = await client.stat(root);
    if (st) await walk(root, st);
    return { files, dirs };
  }

  /** Download files and folders (PhpStorm "Download from…"). Remote paths must be mapped. */
  async download(t: DeploymentTarget, remotePaths: string[]): Promise<TransferResult> {
    const result = emptyResult();
    const all: { remote: string; local: string }[] = [];
    const emptyDirs: string[] = [];
    await this.withClient(t, async (client) => {
      for (const r of remotePaths) {
        const { files, dirs } = await this.collectRemote(client, t, r);
        for (const f of files) {
          const local = t.mapper.toLocal(f.path);
          if (local && !t.mapper.isLocalExcluded(local)) all.push({ remote: f.path, local });
        }
        if (t.options.createEmptyDirectories) {
          for (const d of dirs) {
            const local = t.mapper.toLocal(d);
            if (local && !files.some((f) => f.path.startsWith(`${d}/`))) emptyDirs.push(local);
          }
        }
      }
    });
    emptyDirs.forEach((d) => this.markOwnWrite(d));
    await Promise.all(emptyDirs.map((d) => fs.mkdir(d, { recursive: true })));
    await Promise.all(all.map(({ remote, local }) => this.downloadFile(t, remote, local, result)));
    return result;
  }

  deleteRemote(t: DeploymentTarget, remotePath: string, isDir: boolean): Promise<void> {
    return this.queue.enqueue({
      kind: 'delete',
      serverId: t.server.id,
      serverName: t.server.name,
      source: remotePath,
      target: remotePath,
      key: `${t.server.id}:${remotePath}`,
      run: async (client) => {
        try {
          if (isDir) await client.deleteDir(remotePath, true);
          else await client.deleteFile(remotePath);
        } catch (e) {
          if (!(e instanceof RemoteError && e.code === 'NotFound')) throw e;
        }
        this.cache.delete(t.server.id, remotePath, isDir);
      },
    });
  }

  renameRemote(t: DeploymentTarget, from: string, to: string): Promise<void> {
    return this.queue.enqueue({
      kind: 'rename',
      serverId: t.server.id,
      serverName: t.server.name,
      source: from,
      target: to,
      key: `${t.server.id}:${from}`,
      run: async (client) => {
        try {
          await client.rename(from, to);
        } catch (e) {
          if (!(e instanceof RemoteError) || e.code !== 'NotFound') throw e;
          if (!(await client.stat(from))) return; // Source never deployed: nothing to rename.
          await this.ensureRemoteDir(client, t, posix.dirname(to));
          await client.rename(from, to);
        }
        this.cache.rename(t.server.id, from, to);
      },
    });
  }

  chmod(t: DeploymentTarget, remotePath: string, mode: number): Promise<void> {
    return this.queue.enqueue({
      kind: 'chmod',
      serverId: t.server.id,
      serverName: t.server.name,
      source: remotePath,
      target: `${remotePath} → ${mode.toString(8)}`,
      key: `${t.server.id}:${remotePath}`,
      run: (client) => client.chmod(remotePath, mode),
    });
  }
}
