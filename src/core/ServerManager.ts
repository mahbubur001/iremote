import { utils as sshUtils } from 'ssh2';
import type { StringEncoding } from 'basic-ftp';
import { ConnectionPool } from './ConnectionPool';
import { SftpClient } from '../protocol/SftpClient';
import { FtpClient } from '../protocol/FtpClient';
import { WebDavClient } from '../protocol/WebDavClient';
import { LocalClient } from '../protocol/LocalClient';
import { openJumpChannel, parseJump } from '../protocol/JumpHost';
import { RemoteError, type ConnectContext, type ProgressFn, type RemoteClient } from '../protocol/types';
import { defaultAgentSocket, resolveSshConfig } from '../config/sshConfig';
import type { CredentialProvider } from '../config/CredentialProvider';
import type { ServerConfig } from '../config/schema';
import { log } from '../util/log';
import { Emitter, type Disposable, type Event } from '../util/emitter';

const MAX_AUTH_ATTEMPTS = 3;

/** Where servers come from: VS Code's ConfigStore or the Neovim server's project config. */
export interface ServerSource {
  uniqueServers(): ServerConfig[];
  findServer(id: string): ServerConfig | undefined;
  readonly onDidChange: Event<void>;
  /** Persists an "Accept and Remember" TLS certificate fingerprint on the server definition. */
  pinCertificate(serverId: string, fingerprint: string): Promise<void>;
}

export interface ConnectionSettings {
  timeoutMs: number;
  idleCloseMs: number;
}

/**
 * RemoteClient that resolves credentials (keychain, prompts, ~/.ssh/config, agent, jump host) when it connects,
 * then delegates every operation to the protocol implementation. Lets the pool factory stay synchronous.
 */
class DeferredClient implements RemoteClient {
  private inner?: RemoteClient;
  private closeListeners: (() => void)[] = [];
  private cleanup?: () => void;

  constructor(
    private readonly server: ServerConfig,
    private readonly manager: ServerManager,
  ) {}

  get capabilities() {
    return this.inner?.capabilities ?? { chmod: false, setMtime: false, exec: false, reliableMtime: false };
  }

  get connected(): boolean {
    return !!this.inner?.connected;
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  async connect(): Promise<void> {
    const { client, cleanup } = await this.manager.connectClient(this.server);
    this.inner = client;
    this.cleanup = cleanup;
    client.onClose(() => {
      this.cleanup?.();
      this.closeListeners.forEach((l) => l());
    });
  }

  async close(): Promise<void> {
    await this.inner?.close();
    this.cleanup?.();
    this.inner = undefined;
  }

  private get c(): RemoteClient {
    if (!this.inner) throw new RemoteError('Connection', 'Not connected.');
    return this.inner;
  }

  homeDir = () => this.c.homeDir();
  list = (p: string) => this.c.list(p);
  stat = (p: string) => this.c.stat(p);
  readFile = (p: string) => this.c.readFile(p);
  writeFile = (p: string, d: Buffer) => this.c.writeFile(p, d);
  download = (r: string, l: string, pr?: ProgressFn) => this.c.download(r, l, pr);
  upload = (l: string, r: string, pr?: ProgressFn) => this.c.upload(l, r, pr);
  mkdirp = (p: string) => this.c.mkdirp(p);
  deleteFile = (p: string) => this.c.deleteFile(p);
  deleteDir = (p: string, r: boolean) => this.c.deleteDir(p, r);
  rename = (f: string, t: string) => this.c.rename(f, t);
  chmod = (p: string, m: number) => this.c.chmod(p, m);
  setMtime = (p: string, t: number) => this.c.setMtime(p, t);
  exec = (cmd: string) => this.c.exec(cmd);
}

export class ServerManager implements Disposable {
  private readonly pools = new Map<string, { pool: ConnectionPool; signature: string }>();
  /** TLS fingerprints accepted with "Accept Once", per server, for this session. */
  private readonly acceptedCerts = new Map<string, Set<string>>();
  private readonly emitter = new Emitter<string>();
  /** Fires with a server id whenever its connection state changes. */
  readonly onDidChangeConnection = this.emitter.event;

  constructor(
    private readonly config: ServerSource,
    readonly credentials: CredentialProvider,
    private readonly settings: () => ConnectionSettings,
  ) {
    config.onDidChange(() => this.dropStalePools());
  }

  /** Connection-relevant fields; when they change the pool is rebuilt. */
  private signature(s: ServerConfig): string {
    const { mappings: _m, excludedLocal: _l, excludedRemote: _r, name: _n, webUrl: _w, ...conn } = s;
    return JSON.stringify(conn);
  }

  private dropStalePools(): void {
    const servers = new Map(this.config.uniqueServers().map((s) => [s.id, s]));
    for (const [id, entry] of this.pools) {
      const s = servers.get(id);
      if (!s || this.signature(s) !== entry.signature) {
        void entry.pool.dispose();
        this.pools.delete(id);
        this.emitter.fire(id);
      }
    }
  }

  pool(server: ServerConfig): ConnectionPool {
    const sig = this.signature(server);
    const existing = this.pools.get(server.id);
    if (existing && existing.signature === sig) return existing.pool;
    if (existing) void existing.pool.dispose();
    const { idleCloseMs } = this.settings();
    const ftpLike = server.type.startsWith('ftp');
    const pool = new ConnectionPool(() => new DeferredClient(server, this), {
      // SFTP multiplexes requests over one session; FTP needs one control connection per parallel transfer.
      maxConnections: server.maxConnections ?? (ftpLike ? 4 : server.type === 'sftp' ? 2 : 4),
      idleCloseMs,
    });
    this.pools.set(server.id, { pool, signature: sig });
    return pool;
  }

  poolById(id: string): ConnectionPool {
    const server = this.config.findServer(id);
    if (!server) throw new RemoteError('Connection', `Unknown server "${id}".`);
    return this.pool(server);
  }

  isConnected(id: string): boolean {
    return (this.pools.get(id)?.pool.size ?? 0) > 0;
  }

  async disconnect(id?: string): Promise<void> {
    for (const [sid, entry] of this.pools) {
      if (id && sid !== id) continue;
      await entry.pool.closeAll();
      this.emitter.fire(sid);
    }
  }

  private baseContext(server: ServerConfig): ConnectContext {
    const { timeoutMs } = this.settings();
    return {
      timeoutMs,
      log: log.wantsDetails ? (m) => log.detail(`[${server.name}] ${m}`) : undefined,
      verifyHostKey: (host, port, type, key) => this.credentials.verifyHostKey(host, port, type, key),
      verifyCertificate: async (host, fingerprint, reason) => {
        const accepted = this.acceptedCerts.get(server.id) ?? new Set<string>();
        if (accepted.has(fingerprint)) return true;
        const decision = await this.credentials.verifyCertificate(server.name, host, fingerprint, reason);
        if (!decision) return false;
        accepted.add(fingerprint);
        this.acceptedCerts.set(server.id, accepted);
        if (decision === 'remember') await this.config.pinCertificate(server.id, fingerprint);
        return true;
      },
      promptKeyboardInteractive: (prompts) => this.credentials.keyboardInteractive(server.name, prompts),
    };
  }

  /**
   * Connects an SSH session for an interactive terminal: same login flow as file transfers (keychain, prompts,
   * ~/.ssh/config, agent, jump host, host-key checks) but without the SFTP subsystem and outside the pool.
   */
  async connectShell(server: ServerConfig): Promise<{ client: SftpClient; cleanup?: () => void }> {
    if (server.type !== 'sftp') throw new RemoteError('Unsupported', `${server.name} is not an SFTP/SSH server.`);
    const { client, cleanup } = await this.connectClient(server, true);
    return { client: client as SftpClient, cleanup };
  }

  /** Builds and connects the protocol client, prompting for secrets and retrying failed logins. */
  async connectClient(server: ServerConfig, shellOnly = false): Promise<{ client: RemoteClient; cleanup?: () => void }> {
    if (server.type === 'local') {
      const client = new LocalClient();
      await client.connect();
      return { client };
    }
    let prompted = false;
    for (let attempt = 1; ; attempt++) {
      const ctx = this.baseContext(server);
      let cleanup: (() => void) | undefined;
      try {
        const built = await this.build(server, ctx, attempt > 1, shellOnly);
        prompted ||= built.prompted;
        cleanup = built.cleanup;
        await built.client.connect();
        log.info(`Connected to ${server.name}`);
        if (!shellOnly) this.emitter.fire(server.id);
        if (prompted) void this.credentials.offerToSave(server, built.secretKind);
        return { client: built.client, cleanup };
      } catch (e) {
        cleanup?.();
        if (e instanceof RemoteError && e.code === 'Auth' && attempt < MAX_AUTH_ATTEMPTS && this.usesSecret(server)) {
          log.error(`Authentication failed for ${server.name}`, e);
          this.credentials.forgetSession(server.id, this.secretKind(server));
          continue;
        }
        throw e;
      }
    }
  }

  private usesSecret(server: ServerConfig): boolean {
    if (server.type === 'webdav') return server.webdavAuth !== 'none';
    if (server.type === 'sftp') return server.auth === 'password' || server.auth === 'key';
    return !!server.username && server.username !== 'anonymous';
  }

  private secretKind(server: ServerConfig): 'password' | 'passphrase' {
    return server.type === 'sftp' && server.auth === 'key' ? 'passphrase' : 'password';
  }

  private cancelled(): never {
    throw new RemoteError('Cancelled', 'Login cancelled.');
  }

  private async build(
    server: ServerConfig,
    ctx: ConnectContext,
    retry: boolean,
    shellOnly = false,
  ): Promise<{ client: RemoteClient; prompted: boolean; secretKind: 'password' | 'passphrase'; cleanup?: () => void }> {
    const detail = retry ? 'Authentication failed. Please try again.' : undefined;
    const needsPrompt = async (kind: 'password' | 'passphrase') =>
      retry || ((await this.credentials.getStored(server.id, kind)) === undefined);

    switch (server.type) {
      case 'sftp':
        return this.buildSftp(server, ctx, retry, detail, shellOnly);
      case 'ftp':
      case 'ftps':
      case 'ftps-implicit': {
        let prompted = false;
        if (this.usesSecret(server)) {
          prompted = await needsPrompt('password');
          ctx.password = (await this.credentials.obtain(server, 'password', { forcePrompt: retry, detail })) ?? this.cancelled();
        }
        const tls = server.type === 'ftp' ? false : server.type === 'ftps' ? 'explicit' : 'implicit';
        const client = new FtpClient(
          {
            host: server.host,
            port: server.port ?? (tls === 'implicit' ? 990 : 21),
            username: server.username ?? '',
            tls,
            allowUntrustedCertificate: !!server.allowUntrustedCertificate,
            trustedCertificateFingerprint: server.trustedCertificateFingerprint,
            encoding: server.encoding as StringEncoding | undefined,
          },
          ctx,
        );
        return { client, prompted, secretKind: 'password' };
      }
      case 'webdav': {
        let prompted = false;
        if (this.usesSecret(server)) {
          prompted = await needsPrompt('password');
          ctx.password = (await this.credentials.obtain(server, 'password', { forcePrompt: retry, detail })) ?? this.cancelled();
        }
        const client = new WebDavClient(
          {
            url: server.host,
            username: server.username ?? '',
            auth: server.webdavAuth ?? 'basic',
            allowUntrustedCertificate: !!server.allowUntrustedCertificate,
            trustedCertificateFingerprint: server.trustedCertificateFingerprint,
          },
          ctx,
        );
        return { client, prompted, secretKind: 'password' };
      }
      case 'local':
        return { client: new LocalClient(), prompted: false, secretKind: 'password' };
    }
  }

  private async buildSftp(server: ServerConfig, ctx: ConnectContext, retry: boolean, detail?: string, shellOnly = false) {
    let host = server.host;
    let port = server.port ?? 22;
    let username = server.username ?? '';
    let keyPaths = server.privateKeyPath ? [server.privateKeyPath] : [];
    let jump = server.jumpHost;
    let prompted = false;
    const auth = server.auth ?? 'password';
    let secretKind: 'password' | 'passphrase' = 'password';

    if (auth === 'openssh') {
      const resolved = await resolveSshConfig(server.sshConfigHost || server.host);
      host = resolved.host;
      port = server.port && server.port !== 22 ? server.port : (resolved.port ?? 22);
      username = server.username || resolved.user || '';
      keyPaths = resolved.identityFiles.length ? resolved.identityFiles : keyPaths;
      jump = server.jumpHost || resolved.proxyJump;
    }

    const agent = defaultAgentSocket();
    if (auth === 'agent' || auth === 'openssh') ctx.agent = agent;

    if (auth === 'password') {
      prompted = retry || (await this.credentials.getStored(server.id, 'password')) === undefined;
      ctx.password = (await this.credentials.obtain(server, 'password', { forcePrompt: retry, detail })) ?? this.cancelled();
    }

    if (auth === 'key' || auth === 'openssh') {
      for (const path of keyPaths) {
        let key: Buffer;
        try {
          key = await this.credentials.readPrivateKey(path);
        } catch (e) {
          if (auth === 'key') throw new RemoteError('Auth', `Cannot read private key ${path}: ${(e as Error).message}`);
          continue;
        }
        const parsed = sshUtils.parseKey(key);
        if (parsed instanceof Error && /passphrase/i.test(parsed.message)) {
          secretKind = 'passphrase';
          prompted = retry || (await this.credentials.getStored(server.id, 'passphrase')) === undefined;
          const pass = (await this.credentials.obtain(server, 'passphrase', { forcePrompt: retry, detail })) ?? this.cancelled();
          if (sshUtils.parseKey(key, pass) instanceof Error) {
            this.credentials.forgetSession(server.id, 'passphrase');
            throw new RemoteError('Auth', `Wrong passphrase for ${path}.`);
          }
          ctx.passphrase = pass;
        } else if (parsed instanceof Error) {
          if (auth === 'key') throw new RemoteError('Auth', `Unsupported private key ${path}: ${parsed.message}`);
          continue;
        }
        ctx.privateKey = key;
        break;
      }
      if (auth === 'key' && !ctx.privateKey) throw new RemoteError('Auth', 'No private key file configured.');
    }

    let cleanup: (() => void) | undefined;
    if (jump) {
      const spec = parseJump(jump, username);
      if (!spec) throw new RemoteError('Connection', `Invalid jump host "${jump}". Use user@host:port.`);
      if (!ctx.agent) ctx.agent = agent;
      const { channel, close } = await openJumpChannel(spec, host, port, ctx);
      ctx.sock = channel;
      cleanup = close;
    }

    const client = new SftpClient(
      {
        host,
        port,
        username,
        keepAliveSeconds: server.keepAliveSeconds ?? 30,
        useAgent: !!ctx.agent,
        tryKeyboard: true,
        shellOnly,
      },
      ctx,
    );
    return { client, prompted, secretKind, cleanup };
  }

  dispose(): void {
    for (const { pool } of this.pools.values()) void pool.dispose();
    this.pools.clear();
    this.emitter.dispose();
  }
}
