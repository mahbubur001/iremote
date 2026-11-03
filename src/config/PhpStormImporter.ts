import { XMLParser } from 'fast-xml-parser';
import { promises as fs } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { defaultOptions, type DeploymentOptions, type Mapping, type ServerConfig, type ServerType, type SftpAuth } from './schema';

/**
 * Reads PhpStorm / IntelliJ deployment configuration:
 *  - .idea/webServers.xml   servers (connection)          — or the IDE-level options/webServers.xml
 *  - .idea/sshConfigs.xml   SSH configurations (newer IDEs) — or options/sshConfigs.xml
 *  - .idea/deployment.xml   mappings, excluded paths, default server, options
 * Passwords live in the OS keychain under JetBrains' own entries and cannot be imported.
 */

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  isArray: (name) => ['webServer', 'sshConfig', 'paths', 'mapping', 'excludedPath', 'option', 'component'].includes(name),
});

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const attr = (n: Node | undefined, name: string): string | undefined => {
  const v = n?.[`@${name}`];
  return typeof v === 'string' ? v : undefined;
};

/** Values may be attributes or nested <option name="x" value="y"/> elements depending on IDE version. */
const prop = (n: Node | undefined, name: string): string | undefined => {
  const direct = attr(n, name);
  if (direct !== undefined) return direct;
  for (const o of asArray(n?.option as Node[] | undefined)) if (attr(o, 'name') === name) return attr(o, 'value');
  return undefined;
};

const components = (doc: Node): Node[] => asArray((doc.project as Node | undefined)?.component as Node[] | undefined);
const component = (doc: Node, name: string): Node | undefined => components(doc).find((c) => attr(c, 'name') === name);

export interface ImportedSshConfig {
  id: string;
  host: string;
  port?: number;
  username?: string;
  authType?: string;
  keyPath?: string;
  useOpenSSHConfig?: boolean;
}

export interface ImportedWebServer {
  id: string;
  name: string;
  url?: string;
  accessType: string;
  host?: string;
  port?: number;
  username?: string;
  rootFolder?: string;
  privateKey?: string;
  keyPair?: boolean;
  sshConfigId?: string;
  passive?: boolean;
}

export interface ImportedDeployment {
  defaultServerName?: string;
  options: Partial<DeploymentOptions>;
  paths: { serverName: string; mappings: { local: string; deploy: string; web: string }[]; excludedLocal: string[]; excludedRemote: string[] }[];
}

export interface ImportResult {
  servers: ServerConfig[];
  defaultServer?: string;
  options: DeploymentOptions;
  warnings: string[];
}

const toPort = (s: string | undefined): number | undefined => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
};

export const parseSshConfigs = (xml: string): ImportedSshConfig[] => {
  const doc = parser.parse(xml) as Node;
  const comp = component(doc, 'SshConfigs');
  const configs = asArray(((comp?.configs as Node | undefined)?.sshConfig as Node[] | undefined) ?? []);
  return configs
    .map((c) => ({
      id: prop(c, 'id') ?? '',
      host: prop(c, 'host') ?? '',
      port: toPort(prop(c, 'port')),
      username: prop(c, 'username'),
      authType: prop(c, 'authType'),
      keyPath: prop(c, 'keyPath'),
      useOpenSSHConfig: prop(c, 'useOpenSSHConfig') === 'true',
    }))
    .filter((c) => c.id && c.host);
};

export const parseWebServers = (xml: string): ImportedWebServer[] => {
  const doc = parser.parse(xml) as Node;
  const comp = component(doc, 'WebServers');
  const option = asArray(comp?.option as Node[] | undefined).find((o) => attr(o, 'name') === 'servers');
  const servers = asArray((option?.webServer as Node[] | undefined) ?? []);
  return servers.map((w) => {
    const ft = (w.fileTransfer as Node | undefined) ?? {};
    const adv = ((ft.advancedOptions as Node | undefined)?.advancedOptions as Node | undefined) ?? (ft.advancedOptions as Node | undefined);
    return {
      id: attr(w, 'id') ?? '',
      name: attr(w, 'name') ?? 'Imported server',
      url: attr(w, 'url'),
      accessType: (prop(ft, 'accessType') ?? 'FTP').toUpperCase(),
      host: prop(ft, 'host'),
      port: toPort(prop(ft, 'port')),
      username: prop(ft, 'username') ?? prop(ft, 'user'),
      rootFolder: prop(ft, 'rootFolder'),
      privateKey: prop(ft, 'privateKey'),
      keyPair: prop(ft, 'keyPair') === 'true',
      sshConfigId: prop(ft, 'sshConfigId'),
      passive: prop(adv, 'passiveMode') !== 'false',
    };
  });
};

const AUTO_UPLOAD: Record<string, DeploymentOptions['autoUpload']> = {
  always: 'always',
  'on explicit save action': 'onExplicitSave',
  on_explicit_save: 'onExplicitSave',
  explicit: 'onExplicitSave',
  never: 'never',
  false: 'never',
  true: 'always',
};

export const parseDeployment = (xml: string): ImportedDeployment => {
  const doc = parser.parse(xml) as Node;
  const comp = component(doc, 'PublishConfigData');
  const options: Partial<DeploymentOptions> = {};
  const auto = (prop(comp, 'autoUpload') ?? prop(comp, 'myAutoUpload'))?.toLowerCase();
  if (auto && AUTO_UPLOAD[auto]) options.autoUpload = AUTO_UPLOAD[auto];
  const external = prop(comp, 'autoUploadExternalChanges');
  if (external !== undefined) options.skipExternalChanges = external !== 'true';
  const overwrite = prop(comp, 'promptOnRemoteOverwrite')?.toUpperCase();
  if (overwrite) options.warnOnNewerRemote = overwrite === 'CHECK_CONTENT' ? 'content' : overwrite === 'DONT_CHECK' ? 'none' : 'timestampAndSize';
  const bools: [string, keyof DeploymentOptions][] = [
    ['notifyRemoteChanges', 'notifyRemoteChanges'],
    ['preserveTimestamps', 'preserveTimestamps'],
    ['createEmptyFolders', 'createEmptyDirectories'],
    ['deleteMissingItems', 'deleteRemoteOnLocalDelete'],
    ['confirmBeforeDeletion', 'confirmRemoteDelete'],
    ['overwriteUpToDate', 'overwriteUpToDate'],
  ];
  for (const [xmlName, key] of bools) {
    const v = prop(comp, xmlName);
    if (v === 'true' || v === 'false') (options as Record<string, unknown>)[key] = v === 'true';
  }
  const perms = (name: string): string | undefined => {
    const v = prop(comp, name);
    if (!v || v === '-1') return undefined;
    const n = Number(v);
    // IntelliJ stores permissions as a decimal integer of the octal mode bits.
    return Number.isInteger(n) && n > 0 && n <= 0o7777 ? n.toString(8) : undefined;
  };
  const filePermissions = perms('filePermissions');
  const folderPermissions = perms('folderPermissions');
  if (filePermissions) options.filePermissions = filePermissions;
  if (folderPermissions) options.folderPermissions = folderPermissions;

  const paths = asArray(((comp?.serverData as Node | undefined)?.paths as Node[] | undefined) ?? []).map((p) => {
    const sd = (p.serverdata as Node | undefined) ?? {};
    const mappings = asArray(((sd.mappings as Node | undefined)?.mapping as Node[] | undefined) ?? []).map((m) => ({
      local: attr(m, 'local') ?? '$PROJECT_DIR$',
      deploy: attr(m, 'deploy') ?? '/',
      web: attr(m, 'web') ?? '/',
    }));
    const excluded = asArray(((sd.excludedPaths as Node | undefined)?.excludedPath as Node[] | undefined) ?? []);
    return {
      serverName: attr(p, 'name') ?? '',
      mappings,
      excludedLocal: excluded.filter((e) => attr(e, 'local') === 'true').map((e) => attr(e, 'path') ?? '').filter(Boolean),
      excludedRemote: excluded.filter((e) => attr(e, 'local') !== 'true').map((e) => attr(e, 'path') ?? '').filter(Boolean),
    };
  });
  return { defaultServerName: prop(comp, 'serverName'), options, paths };
};

/** Converts "$PROJECT_DIR$/public" into a project-relative path; leaves outside paths absolute. */
export const projectRelative = (p: string, projectRoot: string): string => {
  const expanded = p.replace(/\$PROJECT_DIR\$/g, projectRoot).replace(/\$USER_HOME\$/g, homedir());
  if (!isAbsolute(expanded)) return expanded.replace(/\\/g, '/');
  const rel = relative(projectRoot, expanded).replace(/\\/g, '/');
  return rel.startsWith('..') ? expanded.replace(/\\/g, '/') : rel;
};

const TYPE_MAP: Record<string, ServerType> = {
  SFTP: 'sftp',
  FTP: 'ftp',
  FTPS: 'ftps',
  WEBDAV: 'webdav',
  MOUNT: 'local',
  LOCAL: 'local',
  LOCAL_OR_MOUNTED: 'local',
};

const sftpAuth = (ssh: ImportedSshConfig | undefined, ws: ImportedWebServer): SftpAuth => {
  const t = ssh?.authType?.toUpperCase();
  if (ssh?.useOpenSSHConfig || t === 'OPEN_SSH') return 'openssh';
  if (t === 'KEY_PAIR' || ws.keyPair) return 'key';
  return 'password';
};

export const buildImport = (
  projectRoot: string,
  webServers: ImportedWebServer[],
  sshConfigs: ImportedSshConfig[],
  deployment: ImportedDeployment | undefined,
): ImportResult => {
  const warnings: string[] = [];
  const servers: ServerConfig[] = [];
  const usedIds = new Set<string>();
  for (const ws of webServers) {
    const type = TYPE_MAP[ws.accessType];
    if (!type) {
      warnings.push(`Server "${ws.name}": access type ${ws.accessType} is not supported; skipped.`);
      continue;
    }
    const ssh = ws.sshConfigId ? sshConfigs.find((c) => c.id === ws.sshConfigId) : undefined;
    if (ws.sshConfigId && !ssh) warnings.push(`Server "${ws.name}": SSH configuration ${ws.sshConfigId} not found; using inline settings.`);
    const paths = deployment?.paths.find((p) => p.serverName === ws.name);
    let id = (ws.id || ws.name).replace(/[^A-Za-z0-9._-]/g, '-');
    while (usedIds.has(id)) id += '-1';
    usedIds.add(id);
    const auth = type === 'sftp' ? sftpAuth(ssh, ws) : undefined;
    const keyPath = ssh?.keyPath ?? ws.privateKey;
    const mappings: Mapping[] = (paths?.mappings.length ? paths.mappings : [{ local: '$PROJECT_DIR$', deploy: '/', web: '/' }]).map((m) => ({
      local: projectRelative(m.local, projectRoot),
      remote: m.deploy || '/',
      web: m.web || '/',
    }));
    servers.push({
      id,
      name: ws.name,
      type,
      host: type === 'webdav' ? (ws.url ?? ws.host ?? '') : (ssh?.host ?? ws.host ?? ''),
      port: ssh?.port ?? ws.port,
      username: ssh?.username ?? ws.username ?? '',
      auth,
      privateKeyPath: auth === 'key' && keyPath ? keyPath.replace(/\$PROJECT_DIR\$/g, projectRoot).replace(/\$USER_HOME\$/g, '~') : undefined,
      sshConfigHost: auth === 'openssh' ? (ssh?.host ?? ws.host) : undefined,
      rootPath: ws.rootFolder || '/',
      webUrl: type === 'webdav' ? '' : (ws.url ?? ''),
      passive: ws.passive,
      mappings,
      excludedLocal: (paths?.excludedLocal ?? []).map((p) => projectRelative(p, projectRoot)),
      excludedRemote: paths?.excludedRemote ?? [],
    });
  }
  if (deployment) {
    for (const p of deployment.paths) {
      if (!webServers.some((w) => w.name === p.serverName)) {
        warnings.push(`Mappings for "${p.serverName}" found, but the server definition is missing (it may be an IDE-level server).`);
      }
    }
  }
  if (servers.some((s) => s.type !== 'local' && (s.auth === 'password' || s.type !== 'sftp'))) {
    warnings.push('Passwords are not imported. You will be asked for them on first connect and can save them in the system keychain.');
  }
  const def = deployment?.defaultServerName ? servers.find((s) => s.name === deployment.defaultServerName) : undefined;
  return { servers, defaultServer: def?.id, options: { ...defaultOptions(), ...(deployment?.options ?? {}) }, warnings };
};

const readIf = (p: string): Promise<string | undefined> => fs.readFile(p, 'utf8').then((t) => t, () => undefined);

/** Locates the newest JetBrains IDE options directory (PhpStorm preferred, then IntelliJ IDEA / WebStorm). */
export const findIdeOptionsDirs = async (): Promise<string[]> => {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'JetBrains')
      : process.platform === 'win32'
        ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'JetBrains')
        : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'JetBrains');
  let entries: string[];
  try {
    entries = await fs.readdir(base);
  } catch {
    return [];
  }
  const rank = (n: string) => (n.startsWith('PhpStorm') ? 0 : n.startsWith('IntelliJIdea') ? 1 : n.startsWith('WebStorm') ? 2 : 3);
  return entries
    .filter((n) => /^(PhpStorm|IntelliJIdea|WebStorm|PyCharm|GoLand|RubyMine)\d{4}\.\d/.test(n))
    .sort((a, b) => rank(a) - rank(b) || b.localeCompare(a, undefined, { numeric: true }))
    .map((n) => join(base, n, 'options'));
};

/** Reads everything needed for an import from a project folder (falls back to IDE-level servers). */
export const importFromProject = async (projectRoot: string): Promise<ImportResult | undefined> => {
  const idea = join(projectRoot, '.idea');
  const [deploymentXml, projectServersXml, projectSshXml] = await Promise.all([
    readIf(join(idea, 'deployment.xml')),
    readIf(join(idea, 'webServers.xml')),
    readIf(join(idea, 'sshConfigs.xml')),
  ]);
  if (!deploymentXml && !projectServersXml) return undefined;
  const webServers = projectServersXml ? parseWebServers(projectServersXml) : [];
  const sshConfigs = projectSshXml ? parseSshConfigs(projectSshXml) : [];
  const deployment = deploymentXml ? parseDeployment(deploymentXml) : undefined;

  // Servers not "visible only for this project" live in the IDE options directory.
  const missing = deployment?.paths.some((p) => !webServers.some((w) => w.name === p.serverName));
  const needsSsh = webServers.some((w) => w.sshConfigId && !sshConfigs.some((c) => c.id === w.sshConfigId));
  if (missing || needsSsh) {
    for (const dir of await findIdeOptionsDirs()) {
      const [ideServers, ideSsh] = await Promise.all([readIf(join(dir, 'webServers.xml')), readIf(join(dir, 'sshConfigs.xml'))]);
      if (ideServers) {
        for (const w of parseWebServers(ideServers)) if (!webServers.some((x) => x.name === w.name)) webServers.push(w);
      }
      if (ideSsh) {
        for (const c of parseSshConfigs(ideSsh)) if (!sshConfigs.some((x) => x.id === c.id)) sshConfigs.push(c);
      }
      if (ideServers || ideSsh) break;
    }
  }
  return buildImport(projectRoot, webServers, sshConfigs, deployment);
};
