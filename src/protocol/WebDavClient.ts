import { createClient, AuthType, type WebDAVClient, type FileStat } from 'webdav';
import { Agent as HttpsAgent, type AgentOptions, type RequestOptions } from 'node:https';
import { connect as tlsConnect, type TLSSocket, type ConnectionOptions } from 'node:tls';
import type { Duplex } from 'node:stream';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat as localStat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
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

export interface WebDavOptions {
  /** Base URL of the WebDAV endpoint, e.g. https://cloud.example.com/remote.php/dav/files/me */
  url: string;
  username: string;
  auth: 'basic' | 'digest' | 'none';
  allowUntrustedCertificate: boolean;
  trustedCertificateFingerprint?: string;
}

type CertDecision = (host: string, fingerprint: string, reason: string) => Promise<boolean>;

/**
 * HTTPS agent that completes the TLS handshake and validates the certificate (CA chain or pinned
 * fingerprint) before handing the socket to the HTTP layer, so credentials are never sent to an
 * unverified peer.
 */
class VerifyingAgent extends HttpsAgent {
  private readonly accepted = new Set<string>();

  constructor(
    options: AgentOptions,
    pinned: string | undefined,
    private readonly decide: CertDecision | undefined,
  ) {
    super({ ...options, keepAlive: true });
    if (pinned) this.accepted.add(pinned);
  }

  // Node's Agent passes a callback and waits for it when createConnection returns undefined.
  override createConnection(options: RequestOptions, callback?: (err: Error | null, stream: Duplex) => void): Duplex | null | undefined {
    if (!callback) throw new Error('VerifyingAgent requires the asynchronous createConnection form.');
    const cb = (err: Error | null, socket?: TLSSocket) => callback(err, socket as Duplex);
    const socket: TLSSocket = tlsConnect({ ...(options as ConnectionOptions), rejectUnauthorized: false });
    socket.once('error', (err) => cb(err));
    socket.once('secureConnect', () => {
      if (socket.authorized) return cb(null, socket);
      const fingerprint = socket.getPeerCertificate()?.fingerprint256 ?? '';
      if (this.accepted.has(fingerprint)) return cb(null, socket);
      const reason = String(socket.authorizationError ?? 'unknown certificate error');
      const host = String(options.host ?? options.servername ?? '');
      const reject = () => {
        socket.destroy();
        cb(new RemoteError('Certificate', `TLS certificate for ${host} is not trusted (${reason}).`));
      };
      if (!this.decide) return reject();
      this.decide(host, fingerprint, reason).then(
        (ok) => {
          if (!ok) return reject();
          this.accepted.add(fingerprint);
          cb(null, socket);
        },
        reject,
      );
    });
    return undefined;
  }
}

const toStat = (fs: FileStat): RemoteStat => {
  const t = Date.parse(fs.lastmod);
  return { type: fs.type === 'directory' ? 'dir' : 'file', size: fs.size ?? 0, mtime: Number.isNaN(t) ? 0 : t };
};

const statusOf = (e: unknown): number | undefined => {
  const err = e as { status?: number; response?: { status?: number } };
  return err?.status ?? err?.response?.status;
};

const progressTap = (total: number, onProgress?: ProgressFn) => {
  let done = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
      onProgress?.(done, total);
      cb(null, chunk);
    },
  });
};

export class WebDavClient implements RemoteClient {
  readonly capabilities: Capabilities = { chmod: false, setMtime: false, exec: false, reliableMtime: true };

  private client?: WebDAVClient;
  private agent?: VerifyingAgent;
  private closeListeners: (() => void)[] = [];

  constructor(
    private readonly opts: WebDavOptions,
    private readonly ctx: ConnectContext,
  ) {}

  get connected(): boolean {
    return !!this.client;
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  async connect(): Promise<void> {
    const { opts, ctx } = this;
    let url: URL;
    try {
      url = new URL(opts.url);
    } catch {
      throw new RemoteError('Connection', `Invalid WebDAV URL: ${opts.url}`);
    }
    if (url.protocol === 'https:') {
      this.agent = new VerifyingAgent(
        { timeout: ctx.timeoutMs },
        opts.trustedCertificateFingerprint,
        opts.allowUntrustedCertificate ? ctx.verifyCertificate : undefined,
      );
    }
    const client = createClient(opts.url, {
      authType: opts.auth === 'digest' ? AuthType.Digest : opts.auth === 'none' ? AuthType.None : AuthType.Password,
      username: opts.auth === 'none' ? undefined : opts.username,
      password: opts.auth === 'none' ? undefined : ctx.password,
      httpsAgent: this.agent,
    });
    try {
      await client.stat('/');
    } catch (e) {
      throw this.mapError(e, '/', 'connect');
    }
    this.client = client;
  }

  async close(): Promise<void> {
    this.client = undefined;
    this.agent?.destroy();
    this.agent = undefined;
  }

  private get c(): WebDAVClient {
    if (!this.client) throw new RemoteError('Connection', 'Not connected.');
    return this.client;
  }

  private mapError(e: unknown, path: string, op: string): RemoteError {
    if (e instanceof RemoteError) return e;
    const cause = (e as { cause?: unknown })?.cause;
    if (cause instanceof RemoteError) return cause;
    const status = statusOf(e);
    switch (status) {
      case 401:
        return new RemoteError('Auth', `Authentication failed for ${this.opts.url}`, path, e);
      case 403:
        return new RemoteError('Permission', `Permission denied: ${path}`, path, e);
      case 404:
      case 409:
        return new RemoteError('NotFound', `No such file or directory: ${path}`, path, e);
      case 405:
        return new RemoteError(op === 'mkdir' ? 'Exists' : 'Unsupported', `${op} not allowed: ${path}`, path, e);
      case 412:
        return new RemoteError('Exists', `Already exists: ${path}`, path, e);
      case undefined:
        return new RemoteError('Connection', `${op} ${path} failed: ${(e as Error)?.message ?? e}`, path, e);
      default:
        return new RemoteError('Unknown', `${op} ${path} failed: HTTP ${status}`, path, e);
    }
  }

  private async run<T>(op: string, path: string, fn: (c: WebDAVClient) => Promise<T>): Promise<T> {
    try {
      return await fn(this.c);
    } catch (e) {
      const err = this.mapError(e, path, op);
      if (err.isFatal && this.client) {
        this.client = undefined;
        this.closeListeners.forEach((l) => l());
      }
      throw err;
    }
  }

  async homeDir(): Promise<string> {
    return '/';
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const items = (await this.run('list', path, (c) => c.getDirectoryContents(path))) as FileStat[];
    const self = posix.normalize(path).replace(/\/$/, '');
    return items
      .filter((i) => posix.normalize(i.filename).replace(/\/$/, '') !== self)
      .map((i) => ({ name: i.basename, ...toStat(i) }));
  }

  async stat(path: string): Promise<RemoteStat | undefined> {
    try {
      return toStat((await this.run('stat', path, (c) => c.stat(path))) as FileStat);
    } catch (e) {
      if (e instanceof RemoteError && e.code === 'NotFound') return undefined;
      throw e;
    }
  }

  async readFile(path: string): Promise<Buffer> {
    const data = await this.run('read', path, (c) => c.getFileContents(path, { format: 'binary' }));
    return Buffer.from(data as ArrayBuffer);
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    await this.run('write', path, (c) => c.putFileContents(path, data, { overwrite: true, contentLength: data.length }));
  }

  async download(remotePath: string, localPath: string, onProgress?: ProgressFn): Promise<void> {
    const total = onProgress ? ((await this.stat(remotePath))?.size ?? 0) : 0;
    await this.run('download', remotePath, (c) =>
      pipeline(c.createReadStream(remotePath) as Readable, progressTap(total, onProgress), createWriteStream(localPath)),
    );
  }

  async upload(localPath: string, remotePath: string, onProgress?: ProgressFn): Promise<void> {
    const { size } = await localStat(localPath);
    const body = createReadStream(localPath).pipe(progressTap(size, onProgress));
    await this.run('upload', remotePath, (c) => c.putFileContents(remotePath, body, { overwrite: true, contentLength: size }));
  }

  async mkdirp(path: string): Promise<void> {
    const norm = posix.normalize(path);
    if (norm === '/' || norm === '.') return;
    const existing = await this.stat(norm);
    if (existing) {
      if (existing.type === 'dir') return;
      throw new RemoteError('Exists', `A file exists where a directory is expected: ${norm}`, norm);
    }
    await this.mkdirp(posix.dirname(norm));
    try {
      await this.run('mkdir', norm, (c) => c.createDirectory(norm));
    } catch (e) {
      if ((await this.stat(norm))?.type === 'dir') return;
      throw e;
    }
  }

  async deleteFile(path: string): Promise<void> {
    await this.run('delete', path, (c) => c.deleteFile(path));
  }

  async deleteDir(path: string, recursive: boolean): Promise<void> {
    if (!recursive && (await this.list(path)).length > 0) {
      throw new RemoteError('Exists', `Directory is not empty: ${path}`, path);
    }
    // WebDAV DELETE on a collection is recursive by definition (RFC 4918 §9.6.1).
    await this.run('rmdir', path, (c) => c.deleteFile(path));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.run('rename', from, (c) => c.moveFile(from, to, { overwrite: true }));
  }

  async chmod(path: string): Promise<void> {
    throw new RemoteError('Unsupported', 'WebDAV does not support permissions.', path);
  }

  async setMtime(path: string): Promise<void> {
    throw new RemoteError('Unsupported', 'WebDAV does not support setting modification times.', path);
  }

  async exec(): Promise<{ code: number; stdout: string; stderr: string }> {
    throw new RemoteError('Unsupported', 'WebDAV servers cannot execute commands.');
  }
}
