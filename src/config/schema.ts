/**
 * Deployment configuration model. Mirrors PhpStorm's Deployment settings:
 * servers (Connection tab), mappings (Mappings tab), excluded paths (Excluded Paths tab)
 * and project-wide options (Deployment → Options).
 *
 * Secrets are never part of this model; they live in VS Code SecretStorage.
 */

export type ServerType = 'sftp' | 'ftp' | 'ftps' | 'ftps-implicit' | 'webdav' | 'local';

export type SftpAuth = 'password' | 'key' | 'agent' | 'openssh';

export interface Mapping {
  /** Local path, relative to the project (workspace folder) root. "" or "." means the root. */
  local: string;
  /** Deployment path, relative to the server root path. */
  remote: string;
  /** Web path, relative to the server web URL. */
  web: string;
}

export interface ServerConfig {
  id: string;
  name: string;
  type: ServerType;
  host: string;
  port?: number;
  username?: string;
  /** SFTP authentication method. */
  auth?: SftpAuth;
  privateKeyPath?: string;
  /** Host alias from ~/.ssh/config used when auth = "openssh". */
  sshConfigHost?: string;
  /** Jump host in user@host:port form (SFTP). */
  jumpHost?: string;
  /** Root path on the server; all deployment paths are relative to it. For "local" this is a local directory. */
  rootPath: string;
  /** Web server URL (e.g. https://example.com). */
  webUrl?: string;
  /** FTP passive mode. basic-ftp only supports passive transfers, kept for PhpStorm parity. */
  passive?: boolean;
  /** Accept self-signed / untrusted TLS certificates (FTPS/WebDAV over https). */
  allowUntrustedCertificate?: boolean;
  /** Pinned SHA-256 fingerprint of an untrusted certificate that the user accepted. */
  trustedCertificateFingerprint?: string;
  /** WebDAV authentication scheme. */
  webdavAuth?: 'basic' | 'digest' | 'none';
  /** Remote file name encoding for FTP. */
  encoding?: string;
  /** Maximum concurrent connections to this server. */
  maxConnections?: number;
  /** SSH keep-alive interval in seconds (0 = disabled). */
  keepAliveSeconds?: number;
  /** Shell commands may be used over SSH for content hashing (sha1sum). */
  allowShellCommands?: boolean;
  mappings: Mapping[];
  /** Local excluded paths relative to the project root. */
  excludedLocal: string[];
  /** Remote excluded paths, absolute on the server. */
  excludedRemote: string[];
}

export type AutoUploadMode = 'always' | 'onExplicitSave' | 'never';
export type OverwriteCheck = 'none' | 'timestampAndSize' | 'content';

export interface DeploymentOptions {
  /** PhpStorm: "Upload changed files automatically to the default server". */
  autoUpload: AutoUploadMode;
  /** PhpStorm: "Skip external changes" — ignore changes not made in the editor (git checkout, build tools). */
  skipExternalChanges: boolean;
  /** PhpStorm: "Delete remote files when local are deleted". */
  deleteRemoteOnLocalDelete: boolean;
  /** PhpStorm: "Create empty directories". */
  createEmptyDirectories: boolean;
  /** PhpStorm: "Preserve files timestamps". */
  preserveTimestamps: boolean;
  /** PhpStorm: "Warn when uploading over newer file". */
  warnOnNewerRemote: OverwriteCheck;
  /** PhpStorm: "Override default permissions on files" (octal string, empty = server default). */
  filePermissions: string;
  /** PhpStorm: "Override default permissions on folders". */
  folderPermissions: string;
  /** PhpStorm: "Exclude items by name" — glob patterns matched against each path segment. */
  excludeNames: string[];
  /** PhpStorm: "Confirm deleting remote files". */
  confirmRemoteDelete: boolean;
  /** PhpStorm: "Overwrite up-to-date files" during sync. */
  overwriteUpToDate: boolean;
  /** PhpStorm: "Notify about remote changes" — check opened remote-backed files when focusing the editor. */
  notifyRemoteChanges: boolean;
  /** Parallel transfers per server. */
  concurrency: number;
}

/** Per-project mapping data for a globally defined server (PhpStorm: server not "visible only for this project"). */
export interface ProjectServerData {
  mappings: Mapping[];
  excludedLocal: string[];
  excludedRemote: string[];
}

export interface ProjectConfigFile {
  $schema?: string;
  version: 1;
  defaultServer?: string;
  options: DeploymentOptions;
  /** Servers visible only in this project. */
  servers: ServerConfig[];
  /** Mappings for global (IDE-level) servers, keyed by server id. */
  globalServerData?: Record<string, ProjectServerData>;
}

export interface GlobalConfigFile {
  version: 1;
  servers: Omit<ServerConfig, 'mappings' | 'excludedLocal' | 'excludedRemote'>[];
}

export type GlobalServer = GlobalConfigFile['servers'][number];

export const DEFAULT_EXCLUDE_NAMES = ['.svn', '.cvs', '.idea', '.DS_Store', '.git', '.hg', '.vscode', 'node_modules'];

export const defaultOptions = (): DeploymentOptions => ({
  autoUpload: 'never',
  skipExternalChanges: true,
  deleteRemoteOnLocalDelete: false,
  createEmptyDirectories: false,
  preserveTimestamps: true,
  warnOnNewerRemote: 'timestampAndSize',
  filePermissions: '',
  folderPermissions: '',
  excludeNames: [...DEFAULT_EXCLUDE_NAMES],
  confirmRemoteDelete: true,
  overwriteUpToDate: false,
  notifyRemoteChanges: true,
  concurrency: 4,
});

export const defaultPort = (type: ServerType): number | undefined => {
  switch (type) {
    case 'sftp':
      return 22;
    case 'ftp':
    case 'ftps':
      return 21;
    case 'ftps-implicit':
      return 990;
    case 'webdav':
    case 'local':
      return undefined;
  }
};

export const SERVER_TYPE_LABELS: Record<ServerType, string> = {
  sftp: 'SFTP',
  ftp: 'FTP',
  ftps: 'FTPS (explicit)',
  'ftps-implicit': 'FTPS (implicit)',
  webdav: 'WebDAV',
  local: 'Local or mounted folder',
};

export const newServer = (id: string, name: string, type: ServerType = 'sftp'): ServerConfig => ({
  id,
  name,
  type,
  host: '',
  port: defaultPort(type),
  username: '',
  auth: type === 'sftp' ? 'password' : undefined,
  rootPath: '/',
  webUrl: '',
  passive: true,
  mappings: [{ local: '', remote: '/', web: '/' }],
  excludedLocal: [],
  excludedRemote: [],
});
