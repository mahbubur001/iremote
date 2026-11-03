/**
 * Protocol-neutral remote file system contract. Implementations must not import `vscode`
 * so they can be exercised by plain Node integration tests.
 */

export type EntryType = 'file' | 'dir' | 'symlink';

export interface RemoteStat {
  type: EntryType;
  /** For symlinks: the type of the link target when it could be resolved. */
  targetType?: 'file' | 'dir';
  size: number;
  /** Modification time in ms since epoch; 0 when the server cannot report it reliably. */
  mtime: number;
  /** Unix permission bits (e.g. 0o644) when known. */
  mode?: number;
}

export interface RemoteEntry extends RemoteStat {
  name: string;
}

export interface Capabilities {
  chmod: boolean;
  setMtime: boolean;
  /** Remote shell commands available (SFTP over SSH). */
  exec: boolean;
  /** `mtime` values are reliable enough for change detection. */
  reliableMtime: boolean;
}

export type ProgressFn = (transferredBytes: number, totalBytes: number) => void;

export interface RemoteClient {
  readonly capabilities: Capabilities;
  readonly connected: boolean;
  /** Fires once when the underlying connection drops unexpectedly. */
  onClose(listener: () => void): void;
  connect(): Promise<void>;
  close(): Promise<void>;
  /** Directory the server places the user in after login. */
  homeDir(): Promise<string>;
  list(path: string): Promise<RemoteEntry[]>;
  /** Returns undefined when the path does not exist. */
  stat(path: string): Promise<RemoteStat | undefined>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  download(remotePath: string, localPath: string, onProgress?: ProgressFn): Promise<void>;
  upload(localPath: string, remotePath: string, onProgress?: ProgressFn): Promise<void>;
  /** Creates the directory and any missing parents. Succeeds if it already exists. */
  mkdirp(path: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  /** Removes a directory; when recursive, removes its contents first. */
  deleteDir(path: string, recursive: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  setMtime(path: string, mtime: number): Promise<void>;
  exec(command: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export type RemoteErrorCode =
  | 'NotFound'
  | 'Exists'
  | 'Permission'
  | 'Auth'
  | 'Connection'
  | 'HostKey'
  | 'Certificate'
  | 'Unsupported'
  | 'Cancelled'
  | 'Unknown';

export class RemoteError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
    readonly path?: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RemoteError';
  }

  /** Connection-level failures invalidate the client; operation-level ones do not. */
  get isFatal(): boolean {
    return this.code === 'Connection' || this.code === 'Auth' || this.code === 'HostKey' || this.code === 'Certificate';
  }
}

export const isRemoteError = (e: unknown, code?: RemoteErrorCode): e is RemoteError =>
  e instanceof RemoteError && (code === undefined || e.code === code);

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Credentials and interactive hooks supplied by the host (VS Code layer or tests). */
export interface ConnectContext {
  password?: string;
  passphrase?: string;
  privateKey?: Buffer;
  /** Resolved agent socket (SSH_AUTH_SOCK or Pageant). */
  agent?: string;
  timeoutMs: number;
  /**
   * Called with the server's host key; resolve true to accept. Must enforce known-hosts policy.
   * Required for SFTP.
   */
  verifyHostKey?: (host: string, port: number, keyType: string, key: Buffer) => Promise<boolean>;
  /** Called for an untrusted TLS certificate; resolve true to accept this fingerprint. */
  verifyCertificate?: (host: string, fingerprint256: string, reason: string) => Promise<boolean>;
  /** Keyboard-interactive prompts (2FA etc.). */
  promptKeyboardInteractive?: (prompts: { prompt: string; echo: boolean }[]) => Promise<string[] | undefined>;
  /** Socket to tunnel through (jump host). */
  sock?: NodeJS.ReadableStream & NodeJS.WritableStream;
  log?: (message: string) => void;
}
