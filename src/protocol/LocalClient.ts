import { promises as fs, createReadStream, createWriteStream, type Stats } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { homedir } from 'node:os';
import {
  RemoteError,
  type Capabilities,
  type ProgressFn,
  type RemoteClient,
  type RemoteEntry,
  type RemoteStat,
} from './types';

/** Remote-style paths for Windows drives arrive as "/C:/dir"; Node expects "C:/dir". */
const osPath = (p: string): string => (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p) ? p.slice(1) : p);

/** "Local or mounted folder" server: the deployment target is a directory reachable through the OS file system. */
export class LocalClient implements RemoteClient {
  readonly capabilities: Capabilities = { chmod: process.platform !== 'win32', setMtime: true, exec: false, reliableMtime: true };
  private open = false;

  get connected(): boolean {
    return this.open;
  }

  onClose(): void {
    // A local folder never drops its connection.
  }

  async connect(): Promise<void> {
    this.open = true;
  }

  async close(): Promise<void> {
    this.open = false;
  }

  async homeDir(): Promise<string> {
    return homedir().replace(/\\/g, '/');
  }

  private mapError(e: unknown, path: string, op: string): RemoteError {
    const code = (e as NodeJS.ErrnoException)?.code;
    switch (code) {
      case 'ENOENT':
      case 'ENOTDIR':
        return new RemoteError('NotFound', `No such file or directory: ${path}`, path, e);
      case 'EACCES':
      case 'EPERM':
        return new RemoteError('Permission', `Permission denied: ${path}`, path, e);
      case 'EEXIST':
      case 'ENOTEMPTY':
        return new RemoteError('Exists', `${code === 'ENOTEMPTY' ? 'Directory is not empty' : 'Already exists'}: ${path}`, path, e);
      default:
        return new RemoteError('Unknown', `${op} ${path} failed: ${(e as Error)?.message ?? e}`, path, e);
    }
  }

  private async run<T>(op: string, path: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw this.mapError(e, path, op);
    }
  }

  private async toStat(path: string, st: Stats): Promise<RemoteStat> {
    if (!st.isSymbolicLink()) {
      return { type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs, mode: st.mode & 0o7777 };
    }
    const target = await fs.stat(path).catch(() => undefined);
    return {
      type: 'symlink',
      targetType: target ? (target.isDirectory() ? 'dir' : 'file') : undefined,
      size: target?.size ?? 0,
      mtime: target?.mtimeMs ?? st.mtimeMs,
      mode: st.mode & 0o7777,
    };
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const names = await this.run('list', path, () => fs.readdir(osPath(path)));
    const out: RemoteEntry[] = [];
    for (const name of names) {
      const full = `${path.replace(/\/$/, '')}/${name}`;
      const st = await fs.lstat(osPath(full)).catch(() => undefined);
      if (st) out.push({ name, ...(await this.toStat(osPath(full), st)) });
    }
    return out;
  }

  async stat(path: string): Promise<RemoteStat | undefined> {
    try {
      return await this.toStat(osPath(path), await fs.lstat(osPath(path)));
    } catch (e) {
      const err = this.mapError(e, path, 'stat');
      if (err.code === 'NotFound') return undefined;
      throw err;
    }
  }

  readFile(path: string): Promise<Buffer> {
    return this.run('read', path, () => fs.readFile(osPath(path)));
  }

  writeFile(path: string, data: Buffer): Promise<void> {
    return this.run('write', path, () => fs.writeFile(osPath(path), data));
  }

  private async copy(from: string, to: string, onProgress?: ProgressFn): Promise<void> {
    const { size } = await fs.stat(from);
    let done = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        done += chunk.length;
        onProgress?.(done, size);
        cb(null, chunk);
      },
    });
    await pipeline(createReadStream(from), tap, createWriteStream(to));
  }

  download(remotePath: string, localPath: string, onProgress?: ProgressFn): Promise<void> {
    return this.run('download', remotePath, () => this.copy(osPath(remotePath), localPath, onProgress));
  }

  upload(localPath: string, remotePath: string, onProgress?: ProgressFn): Promise<void> {
    return this.run('upload', remotePath, () => this.copy(localPath, osPath(remotePath), onProgress));
  }

  async mkdirp(path: string): Promise<void> {
    await this.run('mkdir', path, () => fs.mkdir(osPath(path), { recursive: true }));
  }

  deleteFile(path: string): Promise<void> {
    return this.run('delete', path, () => fs.unlink(osPath(path)));
  }

  deleteDir(path: string, recursive: boolean): Promise<void> {
    return this.run('rmdir', path, () => (recursive ? fs.rm(osPath(path), { recursive: true }) : fs.rmdir(osPath(path))));
  }

  rename(from: string, to: string): Promise<void> {
    return this.run('rename', from, () => fs.rename(osPath(from), osPath(to)));
  }

  chmod(path: string, mode: number): Promise<void> {
    return this.run('chmod', path, () => fs.chmod(osPath(path), mode));
  }

  setMtime(path: string, mtime: number): Promise<void> {
    const t = new Date(mtime);
    return this.run('setMtime', path, () => fs.utimes(osPath(path), t, t));
  }

  async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
    throw new RemoteError('Unsupported', 'Local deployment targets do not run commands.');
  }
}
