import { Client, FTPError, FileType, type FileInfo, type StringEncoding } from 'basic-ftp';
import { Readable, Writable } from 'node:stream';
import { stat as localStat } from 'node:fs/promises';
import { posix } from 'node:path';
import type { TLSSocket, ConnectionOptions } from 'node:tls';
import { isIP } from 'node:net';
import {
  RemoteError,
  type Capabilities,
  type ConnectContext,
  type ProgressFn,
  type RemoteClient,
  type RemoteEntry,
  type RemoteStat,
} from './types';

export interface FtpOptions {
  host: string;
  port: number;
  username: string;
  /** false = plain FTP, 'explicit' = AUTH TLS, 'implicit' = TLS from the first byte. */
  tls: false | 'explicit' | 'implicit';
  allowUntrustedCertificate: boolean;
  trustedCertificateFingerprint?: string;
  encoding?: StringEncoding;
}

const EMPTY_TLS13_UPLOAD_WAIT_MS = 1000;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** RFC 3659 timestamp: YYYYMMDDHHMMSS[.sss], always UTC. */
export const parseMlsxTime = (value: string): number => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!m) return 0;
  const [, y, mo, d, h, mi, s, ms] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms ? +ms.padEnd(3, '0') : 0);
};

export const formatMlsxTime = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};

/** Parses a single MLST/MLSD fact line: "type=file;size=12;modify=20240101120000; name". */
export const parseMlsxFacts = (line: string): { name: string; facts: Record<string, string> } | undefined => {
  const trimmed = line.replace(/^\s+/, '');
  const sep = trimmed.indexOf(' ');
  if (sep < 0) return undefined;
  const facts: Record<string, string> = {};
  for (const part of trimmed.slice(0, sep).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) facts[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1);
  }
  return { name: trimmed.slice(sep + 1), facts };
};

const factsToStat = (facts: Record<string, string>): RemoteStat => {
  const type = (facts.type ?? '').toLowerCase();
  const isLink = type.startsWith('os.unix=symlink') || type.startsWith('os.unix=slink');
  const mode = facts['unix.mode'] ? parseInt(facts['unix.mode'], 8) : undefined;
  return {
    type: isLink ? 'symlink' : type === 'dir' || type === 'cdir' || type === 'pdir' ? 'dir' : 'file',
    size: facts.size ? Number(facts.size) : 0,
    mtime: facts.modify ? parseMlsxTime(facts.modify) : 0,
    mode: Number.isNaN(mode) ? undefined : mode,
  };
};

const infoToStat = (info: FileInfo): RemoteStat => {
  const perms = info.permissions;
  return {
    type: info.type === FileType.Directory ? 'dir' : info.type === FileType.SymbolicLink ? 'symlink' : 'file',
    size: info.size,
    mtime: info.modifiedAt ? info.modifiedAt.getTime() : 0,
    mode: perms ? (perms.user << 6) | (perms.group << 3) | perms.world : undefined,
  };
};

export class FtpClient implements RemoteClient {
  readonly capabilities: Capabilities = { chmod: true, setMtime: false, exec: false, reliableMtime: false };

  private client?: Client;
  private closeListeners: (() => void)[] = [];
  private closing = false;
  private features = new Map<string, string>();
  private home = '/';
  /**
   * On FTPS a refused transfer (550/553) makes the server drop the data connection mid-handshake, which basic-ftp
   * treats as fatal for the whole session. Preconditions are therefore checked on the control channel first.
   */
  private secure = false;
  private readonly knownDirs = new Set<string>();

  constructor(
    private readonly opts: FtpOptions,
    private readonly ctx: ConnectContext,
  ) {}

  get connected(): boolean {
    return !!this.client && !this.client.closed;
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  private tlsOptions(): ConnectionOptions {
    // Chain validation is performed manually in verifyTls() so the user can pin an untrusted certificate.
    // SNI must be a host name; Node rejects IP addresses as servername.
    return { host: this.opts.host, servername: isIP(this.opts.host) ? undefined : this.opts.host, rejectUnauthorized: false };
  }

  /** Validates the control connection certificate before any credentials are sent. */
  private async verifyTls(socket: TLSSocket): Promise<void> {
    if (socket.authorized) return;
    const cert = socket.getPeerCertificate();
    const fingerprint = cert?.fingerprint256 ?? '';
    const reason = String(socket.authorizationError ?? 'unknown certificate error');
    if (this.opts.trustedCertificateFingerprint && fingerprint === this.opts.trustedCertificateFingerprint) return;
    if (this.opts.allowUntrustedCertificate && this.ctx.verifyCertificate) {
      if (await this.ctx.verifyCertificate(this.opts.host, fingerprint, reason)) return;
    }
    throw new RemoteError('Certificate', `TLS certificate for ${this.opts.host} is not trusted (${reason}).`);
  }

  async connect(): Promise<void> {
    const { opts, ctx } = this;
    const client = new Client(ctx.timeoutMs);
    if (ctx.log) {
      client.ftp.verbose = true;
      client.ftp.log = (m: string) => ctx.log?.(m.replace(/^(> PASS ).*$/m, '$1******'));
    }
    if (opts.encoding) client.ftp.encoding = opts.encoding;
    try {
      if (opts.tls === 'implicit') {
        await client.connectImplicitTLS(opts.host, opts.port, this.tlsOptions());
        await this.verifyTls(client.ftp.socket as TLSSocket);
      } else {
        await client.connect(opts.host, opts.port);
        if (opts.tls === 'explicit') {
          await client.useTLS(this.tlsOptions());
          await this.verifyTls(client.ftp.socket as TLSSocket);
        }
      }
      await client.login(opts.username || 'anonymous', ctx.password ?? '');
      await client.useDefaultSettings();
    } catch (e) {
      client.close();
      if (e instanceof RemoteError) throw e;
      if (e instanceof FTPError && (e.code === 530 || e.code === 331 || e.code === 332))
        throw new RemoteError('Auth', `Authentication failed for ${opts.username}@${opts.host}: ${e.message}`, undefined, e);
      throw new RemoteError('Connection', `Cannot connect to ${opts.host}:${opts.port}: ${(e as Error).message}`, undefined, e);
    }

    this.features = await client.features().catch(() => new Map<string, string>());
    const mlsd = this.features.has('MLST') || this.features.has('MLSD');
    if (mlsd) client.availableListCommands = ['MLSD', 'LIST -a', 'LIST'];
    this.capabilities.reliableMtime = mlsd || this.features.has('MDTM');
    this.capabilities.setMtime = this.features.has('MFMT');
    this.home = await client.pwd().catch(() => '/');
    this.secure = opts.tls !== false;

    client.ftp.socket.once('close', () => {
      if (this.client !== client) return;
      this.client = undefined;
      if (!this.closing) this.closeListeners.forEach((l) => l());
    });
    this.client = client;
  }

  async close(): Promise<void> {
    this.closing = true;
    const c = this.client;
    this.client = undefined;
    c?.close();
  }

  private get c(): Client {
    if (!this.client || this.client.closed) throw new RemoteError('Connection', 'Not connected.');
    return this.client;
  }

  private mapError(e: unknown, path: string, op: string): RemoteError {
    if (e instanceof RemoteError) return e;
    if (!this.connected) return new RemoteError('Connection', `Connection lost during ${op} ${path}`, path, e);
    if (e instanceof FTPError) {
      const msg = e.message.toLowerCase();
      if (e.code === 550 || e.code === 450 || e.code === 553) {
        if (/perm|denied|access|not allowed/.test(msg)) return new RemoteError('Permission', `Permission denied: ${path}`, path, e);
        if (/exist/.test(msg) && !/not exist|no such/.test(msg)) return new RemoteError('Exists', `Already exists: ${path}`, path, e);
        return new RemoteError('NotFound', `No such file or directory: ${path}`, path, e);
      }
      if (e.code === 500 || e.code === 502 || e.code === 504) return new RemoteError('Unsupported', `${op} not supported: ${e.message}`, path, e);
      return new RemoteError('Unknown', `${op} ${path} failed: ${e.message}`, path, e);
    }
    return new RemoteError('Unknown', `${op} ${path} failed: ${(e as Error)?.message ?? e}`, path, e);
  }

  private async run<T>(op: string, path: string, fn: (c: Client) => Promise<T>): Promise<T> {
    try {
      return await fn(this.c);
    } catch (e) {
      throw this.mapError(e, path, op);
    }
  }

  async homeDir(): Promise<string> {
    return this.home;
  }

  /** FTPS precondition: the path must exist (and be of the expected kind) before a data connection is opened. */
  private async requireExisting(path: string, kind: 'file' | 'dir'): Promise<void> {
    if (!this.secure) return;
    const st = await this.stat(path);
    if (!st) throw new RemoteError('NotFound', `No such file or directory: ${path}`, path);
    const isDir = st.type === 'dir' || st.targetType === 'dir';
    if (kind === 'dir' && !isDir) throw new RemoteError('Unknown', `Not a directory: ${path}`, path);
    if (kind === 'file' && isDir) throw new RemoteError('Unknown', `Is a directory: ${path}`, path);
    if (isDir) this.knownDirs.add(posix.normalize(path));
  }

  /** FTPS precondition for uploads: the parent directory must exist (Deployer creates it on NotFound). */
  private async requireParent(path: string): Promise<void> {
    if (!this.secure) return;
    const parent = posix.dirname(posix.normalize(path));
    if (this.knownDirs.has(parent)) return;
    await this.requireExisting(parent, 'dir');
  }

  async list(path: string): Promise<RemoteEntry[]> {
    await this.requireExisting(path, 'dir');
    const items = await this.run('list', path, async (c) => c.list(await c.protectWhitespace(path)));
    const result: RemoteEntry[] = [];
    for (const info of items) {
      if (info.name === '.' || info.name === '..') continue;
      const st = infoToStat(info);
      if (st.type === 'symlink') {
        const target = await this.resolveLinkTarget(posix.join(path, info.name));
        if (target) st.targetType = target;
      }
      result.push({ name: info.name, ...st });
    }
    return result;
  }

  /** FTP has no lstat; a symlink to a directory is detected by trying to change into it. */
  private async resolveLinkTarget(path: string): Promise<'file' | 'dir' | undefined> {
    const c = this.c;
    const cwd = await c.pwd();
    try {
      await c.cd(path);
      return 'dir';
    } catch {
      return 'file';
    } finally {
      await c.cd(cwd).catch(() => undefined);
    }
  }

  async stat(path: string): Promise<RemoteStat | undefined> {
    const norm = posix.normalize(path);
    if (norm === '/') return { type: 'dir', size: 0, mtime: 0 };
    if (this.features.has('MLST')) {
      try {
        const res = await this.c.send(`MLST ${norm}`);
        const line = res.message.split(/\r?\n/).find((l) => /^\s+\S*=/.test(l) || /^\s*type=/i.test(l));
        const parsed = line && parseMlsxFacts(line);
        if (parsed) {
          const st = factsToStat(parsed.facts);
          if (st.type === 'symlink') st.targetType = await this.resolveLinkTarget(norm);
          return st;
        }
      } catch (e) {
        if (e instanceof FTPError && (e.code === 550 || e.code === 450)) return undefined;
        if (!(e instanceof FTPError)) throw this.mapError(e, norm, 'stat');
        // 500/501: MLST advertised but broken — fall back to listing the parent.
      }
    }
    const parent = posix.dirname(norm);
    const name = posix.basename(norm);
    let entries: RemoteEntry[];
    try {
      entries = await this.list(parent);
    } catch (e) {
      if (e instanceof RemoteError && e.code === 'NotFound') return undefined;
      throw e;
    }
    const entry = entries.find((e) => e.name === name);
    if (!entry) return undefined;
    if (entry.type === 'file' && !entry.mtime && this.features.has('MDTM')) {
      entry.mtime = await this.c
        .lastMod(norm)
        .then((d) => d.getTime())
        .catch(() => 0);
    }
    const { name: _n, ...st } = entry;
    return st;
  }

  async readFile(path: string): Promise<Buffer> {
    await this.requireExisting(path, 'file');
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });
    await this.run('read', path, (c) => c.downloadTo(sink, path));
    return Buffer.concat(chunks);
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    await this.requireParent(path);
    await this.run('write', path, (c) => c.uploadFrom(data.length ? Readable.from([data]) : this.emptySource(c), path));
  }

  /**
   * Source for zero-byte uploads. With TLS 1.3 the client finishes the handshake before the server has processed
   * the client's Finished message; closing an empty data channel immediately makes OpenSSL-based servers
   * (ProFTPD, Pure-FTPd) abort with "decode error". The server's session ticket is the only post-handshake signal,
   * so wait for it — bounded, because servers that resume sessions may not send one.
   */
  private emptySource(c: Client): Readable {
    return new Readable({
      read() {
        const socket = c.ftp.dataSocket as TLSSocket | undefined;
        if (!socket || typeof socket.getProtocol !== 'function' || socket.getProtocol() !== 'TLSv1.3') {
          this.push(null);
          return;
        }
        let ended = false;
        const end = () => {
          if (ended) return;
          ended = true;
          clearTimeout(timer);
          socket.off('session', end);
          this.push(null);
        };
        const timer = setTimeout(end, EMPTY_TLS13_UPLOAD_WAIT_MS);
        socket.once('session', end);
      },
    });
  }

  private track(onProgress: ProgressFn | undefined, total: number): void {
    this.c.trackProgress(onProgress ? (info) => onProgress(info.bytes, total) : undefined);
  }

  async download(remotePath: string, localPath: string, onProgress?: ProgressFn): Promise<void> {
    await this.requireExisting(remotePath, 'file');
    const total = onProgress ? ((await this.stat(remotePath))?.size ?? 0) : 0;
    this.track(onProgress, total);
    try {
      await this.run('download', remotePath, (c) => c.downloadTo(localPath, remotePath));
    } finally {
      if (this.connected) this.track(undefined, 0);
    }
  }

  async upload(localPath: string, remotePath: string, onProgress?: ProgressFn): Promise<void> {
    const total = (await localStat(localPath)).size;
    if (total === 0) {
      await this.writeFile(remotePath, Buffer.alloc(0));
      return;
    }
    await this.requireParent(remotePath);
    this.track(onProgress, total);
    try {
      await this.run('upload', remotePath, (c) => c.uploadFrom(localPath, remotePath));
    } finally {
      if (this.connected) this.track(undefined, 0);
    }
  }

  async mkdirp(path: string): Promise<void> {
    const norm = posix.normalize(path);
    if (norm === '/' || norm === '.') return;
    if (this.knownDirs.has(norm)) return;
    const existing = await this.stat(norm);
    if (existing) {
      if (existing.type === 'dir' || existing.targetType === 'dir') {
        this.knownDirs.add(norm);
        return;
      }
      throw new RemoteError('Exists', `A file exists where a directory is expected: ${norm}`, norm);
    }
    await this.mkdirp(posix.dirname(norm));
    try {
      await this.c.send(`MKD ${norm}`);
    } catch (e) {
      if ((await this.stat(norm))?.type !== 'dir') throw this.mapError(e, norm, 'mkdir');
    }
    this.knownDirs.add(norm);
  }

  async deleteFile(path: string): Promise<void> {
    await this.run('delete', path, (c) => c.remove(path));
  }

  async deleteDir(path: string, recursive: boolean): Promise<void> {
    if (recursive) {
      for (const entry of await this.list(path)) {
        const child = posix.join(path, entry.name);
        if (entry.type === 'dir') await this.deleteDir(child, true);
        else await this.deleteFile(child);
      }
    }
    await this.run('rmdir', path, (c) => c.removeEmptyDir(path));
    this.knownDirs.clear();
  }

  async rename(from: string, to: string): Promise<void> {
    await this.run('rename', from, (c) => c.rename(from, to));
    this.knownDirs.clear();
  }

  async chmod(path: string, mode: number): Promise<void> {
    if (!this.capabilities.chmod) throw new RemoteError('Unsupported', 'Server does not support SITE CHMOD.', path);
    try {
      await this.run('chmod', path, (c) => c.send(`SITE CHMOD ${mode.toString(8)} ${path}`));
    } catch (e) {
      // Remember the missing command so later uploads don't keep issuing it.
      if (e instanceof RemoteError && e.code === 'Unsupported') this.capabilities.chmod = false;
      throw e;
    }
  }

  async setMtime(path: string, mtime: number): Promise<void> {
    if (!this.capabilities.setMtime) throw new RemoteError('Unsupported', 'Server does not support MFMT.', path);
    await this.run('setMtime', path, (c) => c.send(`MFMT ${formatMlsxTime(mtime)} ${path}`));
  }

  async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
    throw new RemoteError('Unsupported', 'FTP servers cannot execute commands.');
  }
}
