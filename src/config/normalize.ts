import {
  defaultOptions,
  defaultPort,
  type DeploymentOptions,
  type GlobalConfigFile,
  type GlobalServer,
  type Mapping,
  type ProjectConfigFile,
  type ProjectServerData,
  type ServerConfig,
  type ServerType,
} from './schema';

/** Server ids appear as URI authorities (iremote://<id>/path), so they are restricted to URI-safe characters. */
export const SERVER_ID = /^[A-Za-z0-9._-]+$/;
const SERVER_TYPES: ServerType[] = ['sftp', 'ftp', 'ftps', 'ftps-implicit', 'webdav', 'local'];
const AUTO_UPLOAD = ['always', 'onExplicitSave', 'never'] as const;
const OVERWRITE = ['none', 'timestampAndSize', 'content'] as const;
const SFTP_AUTH = ['password', 'key', 'agent', 'openssh'] as const;
const WEBDAV_AUTH = ['basic', 'digest', 'none'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export const isValidPermission = (s: string): boolean => s === '' || /^[0-7]{3,4}$/.test(s);

const normMappings = (v: unknown): Mapping[] =>
  Array.isArray(v)
    ? v.filter(isObj).map((m) => ({ local: str(m.local), remote: str(m.remote, '/'), web: str(m.web, '/') }))
    : [];

export const normalizeOptions = (v: unknown, errors: string[]): DeploymentOptions => {
  const d = defaultOptions();
  if (!isObj(v)) return d;
  const filePermissions = str(v.filePermissions).trim();
  const folderPermissions = str(v.folderPermissions).trim();
  if (!isValidPermission(filePermissions)) errors.push(`options.filePermissions "${filePermissions}" is not an octal mode; ignored.`);
  if (!isValidPermission(folderPermissions)) errors.push(`options.folderPermissions "${folderPermissions}" is not an octal mode; ignored.`);
  const concurrency = num(v.concurrency);
  return {
    autoUpload: oneOf(v.autoUpload, AUTO_UPLOAD, d.autoUpload),
    skipExternalChanges: bool(v.skipExternalChanges, d.skipExternalChanges),
    deleteRemoteOnLocalDelete: bool(v.deleteRemoteOnLocalDelete, d.deleteRemoteOnLocalDelete),
    createEmptyDirectories: bool(v.createEmptyDirectories, d.createEmptyDirectories),
    preserveTimestamps: bool(v.preserveTimestamps, d.preserveTimestamps),
    warnOnNewerRemote: oneOf(v.warnOnNewerRemote, OVERWRITE, d.warnOnNewerRemote),
    filePermissions: isValidPermission(filePermissions) ? filePermissions : '',
    folderPermissions: isValidPermission(folderPermissions) ? folderPermissions : '',
    excludeNames: Array.isArray(v.excludeNames) ? strList(v.excludeNames) : d.excludeNames,
    confirmRemoteDelete: bool(v.confirmRemoteDelete, d.confirmRemoteDelete),
    overwriteUpToDate: bool(v.overwriteUpToDate, d.overwriteUpToDate),
    notifyRemoteChanges: bool(v.notifyRemoteChanges, d.notifyRemoteChanges),
    concurrency: concurrency !== undefined ? Math.min(16, Math.max(1, Math.round(concurrency))) : d.concurrency,
  };
};

const normConnection = (v: Obj, index: number, errors: string[]): GlobalServer | undefined => {
  const id = optStr(v.id);
  const name = optStr(v.name) ?? `Server ${index + 1}`;
  if (!id) {
    errors.push(`Server "${name}" has no id; skipped.`);
    return undefined;
  }
  if (!SERVER_ID.test(id)) {
    errors.push(`Server "${name}": id "${id}" may only contain letters, digits, ".", "_" and "-"; skipped.`);
    return undefined;
  }
  const type = oneOf(v.type, SERVER_TYPES, 'sftp');
  if (!SERVER_TYPES.includes(v.type as ServerType)) errors.push(`Server "${name}": unknown type "${String(v.type)}", using SFTP.`);
  if (type !== 'local' && !optStr(v.host)) errors.push(`Server "${name}": host is empty.`);
  if ('password' in v || 'passphrase' in v) {
    errors.push(`Server "${name}": passwords in the config file are ignored. They are stored securely in the OS keychain instead.`);
  }
  const port = num(v.port);
  return {
    id,
    name,
    type,
    host: str(v.host).trim(),
    port: port !== undefined && port > 0 && port < 65536 ? port : defaultPort(type),
    username: str(v.username),
    auth: type === 'sftp' ? oneOf(v.auth, SFTP_AUTH, 'password') : undefined,
    privateKeyPath: optStr(v.privateKeyPath),
    sshConfigHost: optStr(v.sshConfigHost),
    jumpHost: optStr(v.jumpHost),
    rootPath: str(v.rootPath, '/') || '/',
    webUrl: str(v.webUrl),
    passive: bool(v.passive, true),
    allowUntrustedCertificate: bool(v.allowUntrustedCertificate, false),
    trustedCertificateFingerprint: optStr(v.trustedCertificateFingerprint),
    webdavAuth: type === 'webdav' ? oneOf(v.webdavAuth, WEBDAV_AUTH, 'basic') : undefined,
    encoding: optStr(v.encoding),
    maxConnections: num(v.maxConnections),
    keepAliveSeconds: num(v.keepAliveSeconds),
    allowShellCommands: bool(v.allowShellCommands, false),
  };
};

const normServerData = (v: unknown): ProjectServerData => {
  const o = isObj(v) ? v : {};
  return { mappings: normMappings(o.mappings), excludedLocal: strList(o.excludedLocal), excludedRemote: strList(o.excludedRemote) };
};

export const normalizeServer = (v: Obj, index: number, errors: string[]): ServerConfig | undefined => {
  const conn = normConnection(v, index, errors);
  return conn ? { ...conn, ...normServerData(v) } : undefined;
};

export const normalizeProjectConfig = (raw: unknown, errors: string[] = []): ProjectConfigFile => {
  const v = isObj(raw) ? raw : {};
  const seen = new Set<string>();
  const servers: ServerConfig[] = [];
  (Array.isArray(v.servers) ? v.servers : []).filter(isObj).forEach((s, i) => {
    const server = normalizeServer(s, i, errors);
    if (!server) return;
    if (seen.has(server.id)) {
      errors.push(`Duplicate server id "${server.id}"; second definition skipped.`);
      return;
    }
    seen.add(server.id);
    servers.push(server);
  });
  const globalServerData: Record<string, ProjectServerData> = {};
  if (isObj(v.globalServerData)) {
    for (const [id, data] of Object.entries(v.globalServerData)) globalServerData[id] = normServerData(data);
  }
  return {
    $schema: optStr(v.$schema),
    version: 1,
    defaultServer: optStr(v.defaultServer),
    options: normalizeOptions(v.options, errors),
    servers,
    globalServerData,
  };
};

export const normalizeGlobalConfig = (raw: unknown, errors: string[] = []): GlobalConfigFile => {
  const v = isObj(raw) ? raw : {};
  const servers = (Array.isArray(v.servers) ? v.servers : [])
    .filter(isObj)
    .map((s, i) => normConnection(s, i, errors))
    .filter((s): s is GlobalServer => !!s);
  return { version: 1, servers };
};

/** Serializes without undefined fields so the JSON file stays tidy and diff-friendly. */
export const toJson = (value: unknown): string =>
  `${JSON.stringify(value, (_k, val) => (val === undefined || val === '' ? undefined : val), 2)}\n`;
