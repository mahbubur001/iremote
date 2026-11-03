/**
 * Messages exchanged between the extension host and the webviews. This file is compiled into both sides,
 * so it must stay free of runtime imports.
 */

export type ServerType = 'sftp' | 'ftp' | 'ftps' | 'ftps-implicit' | 'webdav' | 'local';

export interface UiMapping {
  local: string;
  remote: string;
  web: string;
}

export interface UiServer {
  id: string;
  name: string;
  type: ServerType;
  scope: 'project' | 'global';
  host: string;
  port?: number;
  username?: string;
  auth?: 'password' | 'key' | 'agent' | 'openssh';
  privateKeyPath?: string;
  sshConfigHost?: string;
  jumpHost?: string;
  rootPath: string;
  webUrl?: string;
  passive?: boolean;
  allowUntrustedCertificate?: boolean;
  trustedCertificateFingerprint?: string;
  webdavAuth?: 'basic' | 'digest' | 'none';
  encoding?: string;
  maxConnections?: number;
  keepAliveSeconds?: number;
  allowShellCommands?: boolean;
  mappings: UiMapping[];
  excludedLocal: string[];
  excludedRemote: string[];
}

export interface UiOptions {
  autoUpload: 'always' | 'onExplicitSave' | 'never';
  skipExternalChanges: boolean;
  deleteRemoteOnLocalDelete: boolean;
  createEmptyDirectories: boolean;
  preserveTimestamps: boolean;
  warnOnNewerRemote: 'none' | 'timestampAndSize' | 'content';
  filePermissions: string;
  folderPermissions: string;
  excludeNames: string[];
  confirmRemoteDelete: boolean;
  overwriteUpToDate: boolean;
  notifyRemoteChanges: boolean;
  concurrency: number;
}

export interface UiProject {
  key: string;
  name: string;
  root: string;
  defaultServer?: string;
  options: UiOptions;
  servers: UiServer[];
}

export interface SecretState {
  hasPassword: boolean;
  hasPassphrase: boolean;
}

export interface SecretChange {
  /** New value typed by the user; undefined = unchanged. */
  password?: string;
  passphrase?: string;
  savePassword: boolean;
  savePassphrase: boolean;
}

export interface SettingsInit {
  type: 'init';
  projects: UiProject[];
  activeProject: string;
  selectedServer?: string;
  secrets: Record<string, SecretState>;
  problems: string[];
  pathSeparator: string;
}

export type SettingsToHost =
  | { type: 'ready' }
  | { type: 'save'; projects: UiProject[]; secrets: Record<string, SecretChange>; close: boolean }
  | { type: 'cancel' }
  | { type: 'test'; requestId: number; projectKey: string; server: UiServer; secret?: SecretChange }
  | { type: 'detectRoot'; requestId: number; projectKey: string; server: UiServer; secret?: SecretChange }
  | { type: 'browseRemote'; requestId: number; projectKey: string; server: UiServer; secret?: SecretChange; path: string }
  | { type: 'browseLocal'; requestId: number; projectKey: string; current: string; folders: boolean; relative: boolean }
  | { type: 'importPhpStorm' };

export type SettingsToWebview =
  | SettingsInit
  | { type: 'saved'; ok: boolean; message?: string; problems?: string[] }
  | { type: 'result'; requestId: number; ok: boolean; message?: string; path?: string; entries?: { name: string; isDir: boolean }[] };

// ---- Sync ------------------------------------------------------------------------------------

export type SyncState = 'same' | 'localOnly' | 'remoteOnly' | 'localNewer' | 'remoteNewer' | 'conflict';
export type SyncAction = 'upload' | 'download' | 'deleteRemote' | 'deleteLocal' | 'skip';

export interface UiSyncItem {
  id: number;
  rel: string;
  remotePath: string;
  localPath: string;
  localSize?: number;
  localMtime?: number;
  remoteSize?: number;
  remoteMtime?: number;
  state: SyncState;
  action: SyncAction;
  wasSynced: boolean;
  status?: 'running' | 'done' | 'failed';
  error?: string;
}

export type SyncToWebview =
  | { type: 'init'; serverName: string; scope: string; canCompareContents: boolean }
  | { type: 'loading'; message: string }
  | { type: 'items'; items: UiSyncItem[] }
  | { type: 'error'; message: string }
  | { type: 'itemStatus'; id: number; status: 'running' | 'done' | 'failed'; error?: string }
  | { type: 'finished'; transferred: number; failed: number };

export type SyncToHost =
  | { type: 'ready' }
  | { type: 'refresh'; compareContents: boolean }
  | { type: 'diff'; id: number }
  | { type: 'open'; id: number; side: 'local' | 'remote' }
  | { type: 'run'; items: { id: number; action: SyncAction }[] };
