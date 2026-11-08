import { Client, type ConnectConfig, type SFTPWrapper, type Stats, type ClientChannel } from 'ssh2';
import { stat as localStat } from 'node:fs/promises';
import { posix } from 'node:path';
import {
  RemoteError,
  type Capabilities,
  type ConnectContext,
  type ProgressFn,
  type RemoteClient,
  type RemoteEntry,
  type RemoteStat,
} from './types';

const STATUS_NO_SUCH_FILE = 2;
const STATUS_PERMISSION_DENIED = 3;
const STATUS_FAILURE = 4;
const STATUS_OP_UNSUPPORTED = 8;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export interface SftpOptions {
  host: string;
  port: number;
  username: string;
  keepAliveSeconds: number;
  /** Prefer agent auth; when false and no key/password is given, auth fails fast. */
  useAgent: boolean;
  tryKeyboard: boolean;
  /** Skip the SFTP subsystem: the connection only serves interactive shells (SSH terminal sessions). */
  shellOnly?: boolean;
}

/** Reads the algorithm name embedded at the start of an SSH public key blob. */
export const hostKeyType = (key: Buffer): string => {
  if (key.length < 4) return 'unknown';
  const len = key.readUInt32BE(0);
  return len > 0 && len < 64 && key.length >= 4 + len ? key.subarray(4, 4 + len).toString('ascii') : 'unknown';
};

const toStat = (attrs: Stats): RemoteStat => {
  const kind = attrs.mode & S_IFMT;
  return {
    type: kind === S_IFDIR ? 'dir' : kind === S_IFLNK ? 'symlink' : 'file',
    size: attrs.size,
    mtime: attrs.mtime * 1000,
    mode: attrs.mode & 0o7777,
  };
};

export class SftpClient implements RemoteClient {
  readonly capabilities: Capabilities = { chmod: true, setMtime: true, exec: true, reliableMtime: true };

  private conn?: Client;
  private sftp?: SFTPWrapper;
  private closeListeners: (() => void)[] = [];
  private closing = false;
  private home?: string;

  constructor(
    private readonly opts: SftpOptions,
    private readonly ctx: ConnectContext,
  ) {}

  get connected(): boolean {
    return this.opts.shellOnly ? !!this.conn : !!this.sftp;
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  async connect(): Promise<void> {
    const { opts, ctx } = this;
    if (!ctx.verifyHostKey) throw new RemoteError('HostKey', 'Host key verification handler is required for SFTP.');
    const verify = ctx.verifyHostKey;
    const conn = new Client();
    let hostKeyRejected = false;

    const config: ConnectConfig = {
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: ctx.password,
      privateKey: ctx.privateKey,
      passphrase: ctx.passphrase,
      agent: opts.useAgent ? ctx.agent : undefined,
      sock: ctx.sock as ConnectConfig['sock'],
      readyTimeout: ctx.timeoutMs,
      keepaliveInterval: opts.keepAliveSeconds > 0 ? opts.keepAliveSeconds * 1000 : 0,
      keepaliveCountMax: 3,
      tryKeyboard: opts.tryKeyboard,
      hostVerifier: (key: Buffer, cb: (valid: boolean) => void) => {
        verify(opts.host, opts.port, hostKeyType(key), key).then(
          (ok) => {
            hostKeyRejected = !ok;
            cb(ok);
          },
          () => {
            hostKeyRejected = true;
            cb(false);
          },
        );
      },
      debug: ctx.log ? (msg: string) => ctx.log?.(msg) : undefined,
    };

    let passwordOffered = false;
    conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      // Servers commonly ask for the account password via keyboard-interactive; answer it once from the known password.
      const isPasswordPrompt = prompts.length === 1 && !prompts[0].echo && /password/i.test(prompts[0].prompt);
      if (ctx.password !== undefined && isPasswordPrompt && !passwordOffered) {
        passwordOffered = true;
        finish([ctx.password]);
        return;
      }
      if (prompts.length === 0) {
        finish([]);
        return;
      }
      if (!ctx.promptKeyboardInteractive) {
        finish(prompts.map(() => ''));
        return;
      }
      ctx.promptKeyboardInteractive(prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo }))).then(
        (answers) => finish(answers ?? []),
        () => finish([]),
      );
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error & { level?: string }) => {
        conn.removeListener('ready', onReady);
        if (hostKeyRejected) reject(new RemoteError('HostKey', `Host key for ${opts.host} was not accepted.`, undefined, err));
        else if (err.level === 'client-authentication')
          reject(new RemoteError('Auth', `Authentication failed for ${opts.username}@${opts.host}.`, undefined, err));
        else reject(new RemoteError('Connection', `Cannot connect to ${opts.host}:${opts.port}: ${err.message}`, undefined, err));
      };
      const onReady = () => {
        conn.removeListener('error', onError);
        resolve();
      };
      conn.once('error', onError);
      conn.once('ready', onReady);
      conn.connect(config);
    });

    if (!opts.shellOnly) {
      this.sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
        conn.sftp((err, sftp) =>
          err ? reject(new RemoteError('Connection', `SFTP subsystem unavailable: ${err.message}`, undefined, err)) : resolve(sftp),
        ),
      );
    }
    this.conn = conn;

    const dropped = () => {
      if (!this.conn) return;
      this.sftp = undefined;
      this.conn = undefined;
      if (!this.closing) this.closeListeners.forEach((l) => l());
    };
    conn.on('error', (err) => ctx.log?.(`SSH error: ${err.message}`));
    conn.on('close', dropped);
    this.sftp?.on('close', dropped);
  }

  async close(): Promise<void> {
    this.closing = true;
    const conn = this.conn;
    this.sftp = undefined;
    this.conn = undefined;
    conn?.end();
  }

  private get s(): SFTPWrapper {
    if (!this.sftp) throw new RemoteError('Connection', 'Not connected.');
    return this.sftp;
  }

  private mapError(err: Error & { code?: number | string }, path: string, op: string): RemoteError {
    if (!this.sftp) return new RemoteError('Connection', `Connection lost during ${op} ${path}`, path, err);
    switch (err.code) {
      case STATUS_NO_SUCH_FILE:
        return new RemoteError('NotFound', `No such file: ${path}`, path, err);
      case STATUS_PERMISSION_DENIED:
        return new RemoteError('Permission', `Permission denied: ${path}`, path, err);
      case STATUS_OP_UNSUPPORTED:
        return new RemoteError('Unsupported', `${op} is not supported by the server`, path, err);
      default:
        return new RemoteError('Unknown', `${op} ${path} failed: ${err.message}`, path, err);
    }
  }

  private call<T>(op: string, path: string, fn: (cb: (err: Error | undefined | null, res?: T) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        fn((err, res) => (err ? reject(this.mapError(err, path, op)) : resolve(res as T)));
      } catch (e) {
        reject(e instanceof RemoteError ? e : this.mapError(e as Error, path, op));
      }
    });
  }

  async homeDir(): Promise<string> {
    this.home ??= await this.call<string>('realpath', '.', (cb) => this.s.realpath('.', cb));
    return this.home;
  }

  private async resolveLink(path: string, st: RemoteStat): Promise<RemoteStat> {
    if (st.type !== 'symlink') return st;
    try {
      const target = toStat(await this.call<Stats>('stat', path, (cb) => this.s.stat(path, cb)));
      return { ...st, targetType: target.type === 'dir' ? 'dir' : 'file', size: target.size, mtime: target.mtime };
    } catch {
      return st;
    }
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const raw = await this.call<{ filename: string; attrs: Stats }[]>('list', path, (cb) => this.s.readdir(path, cb));
    const entries = raw.filter((e) => e.filename !== '.' && e.filename !== '..');
    return Promise.all(
      entries.map(async (e) => ({ name: e.filename, ...(await this.resolveLink(posix.join(path, e.filename), toStat(e.attrs))) })),
    );
  }

  async stat(path: string): Promise<RemoteStat | undefined> {
    try {
      const st = toStat(await this.call<Stats>('lstat', path, (cb) => this.s.lstat(path, cb)));
      return await this.resolveLink(path, st);
    } catch (e) {
      if (e instanceof RemoteError && e.code === 'NotFound') return undefined;
      throw e;
    }
  }

  async readFile(path: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of this.s.createReadStream(path)) chunks.push(chunk as Buffer);
    } catch (e) {
      throw e instanceof RemoteError ? e : this.mapError(e as Error, path, 'read');
    }
    return Buffer.concat(chunks);
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = this.s.createWriteStream(path, { flags: 'w' });
      ws.once('error', (err: Error) => reject(this.mapError(err, path, 'write')));
      ws.once('close', () => resolve());
      ws.end(data);
    });
  }

  async download(remotePath: string, localPath: string, onProgress?: ProgressFn): Promise<void> {
    await this.call<void>('download', remotePath, (cb) =>
      this.s.fastGet(remotePath, localPath, { step: onProgress ? (done, _chunk, total) => onProgress(done, total) : undefined }, (err) =>
        cb(err),
      ),
    );
  }

  async upload(localPath: string, remotePath: string, onProgress?: ProgressFn): Promise<void> {
    const { size } = await localStat(localPath);
    if (size === 0) {
      // fastPut opens with concurrency even for empty files; plain stream is safer for zero bytes.
      await this.writeFile(remotePath, Buffer.alloc(0));
      return;
    }
    await this.call<void>('upload', remotePath, (cb) =>
      this.s.fastPut(localPath, remotePath, { step: onProgress ? (done, _chunk, total) => onProgress(done, total) : undefined }, (err) =>
        cb(err),
      ),
    );
  }

  async mkdirp(path: string): Promise<void> {
    const existing = await this.stat(path);
    if (existing) {
      if (existing.type === 'dir' || existing.targetType === 'dir') return;
      throw new RemoteError('Exists', `A file exists where a directory is expected: ${path}`, path);
    }
    const parent = posix.dirname(path);
    if (parent !== path) await this.mkdirp(parent);
    try {
      await this.call<void>('mkdir', path, (cb) => this.s.mkdir(path, (err) => cb(err)));
    } catch (e) {
      // Another concurrent transfer may have created it in the meantime.
      if (e instanceof RemoteError && e.code === 'Unknown' && (await this.stat(path))?.type === 'dir') return;
      throw e;
    }
  }

  async deleteFile(path: string): Promise<void> {
    await this.call<void>('delete', path, (cb) => this.s.unlink(path, (err) => cb(err)));
  }

  async deleteDir(path: string, recursive: boolean): Promise<void> {
    if (recursive) {
      for (const entry of await this.list(path)) {
        const child = posix.join(path, entry.name);
        if (entry.type === 'dir') await this.deleteDir(child, true);
        else await this.deleteFile(child);
      }
    }
    await this.call<void>('rmdir', path, (cb) => this.s.rmdir(path, (err) => cb(err)));
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      // POSIX rename (overwrites the target atomically) when the server supports the OpenSSH extension.
      await this.call<void>('rename', from, (cb) => this.s.ext_openssh_rename(from, to, (err) => cb(err)));
    } catch (e) {
      if (!(e instanceof RemoteError) || (e.code !== 'Unsupported' && e.code !== 'Unknown')) throw e;
      await this.call<void>('rename', from, (cb) => this.s.rename(from, to, (err) => cb(err)));
    }
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.call<void>('chmod', path, (cb) => this.s.chmod(path, mode, (err) => cb(err)));
  }

  async setMtime(path: string, mtime: number): Promise<void> {
    const secs = Math.floor(mtime / 1000);
    await this.call<void>('utimes', path, (cb) => this.s.utimes(path, secs, secs, (err) => cb(err)));
  }

  /** Opens an interactive login shell on a pseudo-terminal of the given size. */
  async shell(window: { cols: number; rows: number }): Promise<ClientChannel> {
    const conn = this.conn;
    if (!conn) throw new RemoteError('Connection', 'Not connected.');
    return new Promise<ClientChannel>((resolve, reject) =>
      conn.shell({ term: 'xterm-256color', cols: window.cols, rows: window.rows }, (err, ch) =>
        err ? reject(new RemoteError('Unsupported', `The server refused a shell: ${err.message}`, undefined, err)) : resolve(ch),
      ),
    );
  }

  async exec(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const conn = this.conn;
    if (!conn) throw new RemoteError('Connection', 'Not connected.');
    const channel = await new Promise<ClientChannel>((resolve, reject) =>
      conn.exec(command, (err, ch) => (err ? reject(new RemoteError('Unsupported', `exec failed: ${err.message}`, undefined, err)) : resolve(ch))),
    );
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      channel.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      channel.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      channel.on('close', (code: number | null) => resolve({ code: code ?? STATUS_FAILURE, stdout, stderr }));
    });
  }
}
