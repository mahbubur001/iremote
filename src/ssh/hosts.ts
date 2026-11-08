import { homedir } from 'node:os';
import type { GlobalServer, ServerConfig, SftpAuth } from '../config/schema';
import type { ImportedSshConfig } from '../config/PhpStormImporter';

/**
 * The SSH session host list (PhpStorm: Tools | Start SSH Session…). Pure: no `vscode` import, so it is unit tested
 * in plain Node. Every host is expressed as an SFTP `ServerConfig` so ServerManager's login flow can connect it.
 */

export type SshHostSource = 'iremote' | 'sshconfig' | 'recent';

export interface SshHost {
  /** Identity for de-duplication: user@host:port, or the alias for ~/.ssh/config hosts. */
  key: string;
  label: string;
  source: SshHostSource;
  /** iRemote servers: "visible only for this project" (project) or shared across projects (global). */
  scope?: 'project' | 'global';
  server: ServerConfig;
}

export interface Destination {
  username?: string;
  host: string;
  port: number;
}

export const hostKey = (username: string | undefined, host: string, port: number | undefined): string =>
  `${username ?? ''}@${host.toLowerCase()}:${port ?? 22}`;

export const describe = (d: { username?: string; host: string; port?: number }): string =>
  `${d.username ? `${d.username}@` : ''}${d.host.includes(':') ? `[${d.host}]` : d.host}:${d.port ?? 22}`;

const sshServer = (id: string, name: string, fields: Partial<ServerConfig>): ServerConfig => ({
  id,
  name,
  type: 'sftp',
  host: '',
  rootPath: '/',
  mappings: [],
  excludedLocal: [],
  excludedRemote: [],
  ...fields,
});

export const fromServer = (server: ServerConfig, scope?: 'project' | 'global'): SshHost => ({
  key: server.auth === 'openssh' && server.sshConfigHost ? server.sshConfigHost : hostKey(server.username, server.host, server.port),
  label: server.name,
  source: 'iremote',
  scope,
  server,
});

/**
 * A PhpStorm SSH configuration as an iRemote global SFTP server (one-time import). Its own auth type wins over
 * "Parse config file ~/.ssh/config", which only adds settings; the display name follows PhpStorm.
 */
export const phpStormSshToServer = (c: ImportedSshConfig): GlobalServer => {
  const type = c.authType?.toUpperCase();
  const auth: SftpAuth = type === 'KEY_PAIR' && c.keyPath ? 'key' : type === 'OPEN_SSH' ? 'openssh' : 'password';
  return {
    id: `ssh-${c.id}`.replace(/[^A-Za-z0-9._-]/g, '-'),
    name: c.nameFormat?.toUpperCase() === 'CUSTOM' && c.customName ? c.customName : describe(c),
    type: 'sftp',
    host: c.host,
    port: c.port ?? 22,
    username: c.username,
    auth,
    privateKeyPath: auth === 'key' ? c.keyPath?.replace(/\$USER_HOME\$/g, homedir()) : undefined,
    sshConfigHost: auth === 'openssh' ? c.host : undefined,
    rootPath: '/',
  };
};

/** Concrete `Host` aliases in an OpenSSH config (patterns with *, ? or ! are templates, not hosts). */
export const parseOpenSshHosts = (text: string): string[] => {
  const hosts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*Host(?:\s*=\s*|\s+)(.+)$/i.exec(line);
    if (!m) continue;
    for (const alias of m[1].replace(/#.*/, '').trim().split(/\s+/)) {
      if (alias && !/[*?!]/.test(alias) && !hosts.includes(alias)) hosts.push(alias);
    }
  }
  return hosts;
};

export const fromSshConfigAlias = (alias: string): SshHost => ({
  key: alias,
  label: alias,
  source: 'sshconfig',
  server: sshServer(`ssh-config-${alias}`, alias, { host: alias, auth: 'openssh', sshConfigHost: alias }),
});

/** Parses `user@host`, `user@host:port`, `host -p port` or `user@[ipv6]:port`. */
export const parseDestination = (input: string): Destination | undefined => {
  let text = input.trim().replace(/^ssh\s+/, '');
  let port: number | undefined;
  const flag = /\s+-p\s*(\d+)\s*$/.exec(text);
  if (flag) {
    port = Number(flag[1]);
    text = text.slice(0, flag.index).trim();
  }
  const at = text.lastIndexOf('@');
  const username = at > 0 ? text.slice(0, at) : undefined;
  let host = at >= 0 ? text.slice(at + 1) : text;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
  if (v6) {
    host = v6[1];
    if (v6[2]) port = Number(v6[2]);
  } else {
    const hp = /^([^:\s]+):(\d+)$/.exec(host);
    if (hp) {
      host = hp[1];
      port = Number(hp[2]);
    }
  }
  if (!host || /\s/.test(host) || (username !== undefined && /\s/.test(username))) return undefined;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) return undefined;
  return { username, host, port: port ?? 22 };
};

export const fromDestination = (d: Destination): SshHost => {
  const label = describe(d);
  return {
    key: hostKey(d.username, d.host, d.port),
    label,
    source: 'recent',
    server: sshServer(`ssh-${label}`, label, { host: d.host, port: d.port, username: d.username, auth: 'password' }),
  };
};

/**
 * Merges host lists in priority order (earlier lists win on the same key) and sorts by label. `keys` maps a host key
 * to a private key installed with "Install Public Key", which then replaces password login for that host.
 */
export const mergeHosts = (lists: SshHost[][], keys: Record<string, string> = {}): SshHost[] => {
  const byKey = new Map<string, SshHost>();
  for (const host of lists.flat()) if (!byKey.has(host.key)) byKey.set(host.key, host);
  return [...byKey.values()]
    .map((h) => (keys[h.key] && h.server.auth !== 'openssh' ? { ...h, server: { ...h.server, auth: 'key' as const, privateKeyPath: keys[h.key] } } : h))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }));
};

export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A single-line OpenSSH public key (`type base64 [comment]`), or undefined. */
export const parsePublicKey = (text: string): string | undefined => {
  const line = text.trim();
  return /^(ssh-|ecdsa-|sk-)[\w@.-]+ [A-Za-z0-9+/=]+( [^\r\n]*)?$/.test(line) ? line : undefined;
};

/** Idempotently appends a public key to ~/.ssh/authorized_keys with the permissions sshd requires. */
export const authorizedKeysCommand = (publicKey: string): string => {
  const q = shellQuote(publicKey);
  const file = '~/.ssh/authorized_keys';
  return [
    'umask 077',
    'mkdir -p ~/.ssh',
    `touch ${file}`,
    `chmod 700 ~/.ssh && chmod 600 ${file}`,
    `if ! grep -qxF ${q} ${file}; then { [ -s ${file} ] && [ -n "$(tail -c 1 ${file})" ] && echo; printf '%s\\n' ${q}; } >> ${file}; fi`,
  ].join(' && ');
};
