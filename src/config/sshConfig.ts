import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import SSHConfig from 'ssh-config';

export const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(1)) : p);

export interface SshConfigResolution {
  host: string;
  port?: number;
  user?: string;
  identityFiles: string[];
  proxyJump?: string;
}

/** Resolves a Host alias through ~/.ssh/config (Match exec is never evaluated). */
export const resolveSshConfig = async (alias: string): Promise<SshConfigResolution> => {
  let text: string;
  try {
    text = await fs.readFile(join(homedir(), '.ssh', 'config'), 'utf8');
  } catch {
    return { host: alias, identityFiles: [] };
  }
  const c = SSHConfig.parse(text).compute(alias, { ignoreCase: true, matchExec: false });
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
  const port = Number(first(c.port));
  const proxyJump = first(c.proxyjump);
  return {
    host: first(c.hostname) ?? alias,
    port: Number.isFinite(port) && port > 0 ? port : undefined,
    user: first(c.user),
    identityFiles: list(c.identityfile).map(expandHome),
    proxyJump: proxyJump && proxyJump.toLowerCase() !== 'none' ? proxyJump : undefined,
  };
};

export const defaultAgentSocket = (): string | undefined =>
  process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK;
