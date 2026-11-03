import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import SSHConfig from 'ssh-config';
import { checkHostKey, fingerprintSha256, hostToken, isRevoked, parseKnownHosts } from './KnownHosts';
import type { ServerConfig } from './schema';

const STORE_KEY = 'iremote.knownHosts';

type SecretKind = 'password' | 'passphrase';

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

export class Credentials {
  /** Passwords typed for this session only (user chose not to save, or not yet saved). */
  private readonly session = new Map<string, string>();
  /** Host keys accepted with "Trust Once" — valid until VS Code restarts so pooled connections don't re-prompt. */
  private readonly sessionHostKeys = new Set<string>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  private key(serverId: string, kind: SecretKind): string {
    return `iremote.${serverId}.${kind}`;
  }

  async getStored(serverId: string, kind: SecretKind): Promise<string | undefined> {
    return this.context.secrets.get(this.key(serverId, kind));
  }

  async store(serverId: string, kind: SecretKind, value: string): Promise<void> {
    this.session.delete(this.key(serverId, kind));
    await this.context.secrets.store(this.key(serverId, kind), value);
  }

  async forget(serverId: string, kind?: SecretKind): Promise<void> {
    for (const k of kind ? [kind] : (['password', 'passphrase'] as SecretKind[])) {
      this.session.delete(this.key(serverId, k));
      await this.context.secrets.delete(this.key(serverId, k));
    }
  }

  /** Uses a secret for this session without persisting it (e.g. typed in Settings with "Save" unchecked). */
  setSession(serverId: string, kind: SecretKind, value: string): void {
    this.session.set(this.key(serverId, kind), value);
  }

  forgetSession(serverId: string, kind: SecretKind): void {
    this.session.delete(this.key(serverId, kind));
  }

  /** Returns the stored or session secret, prompting when none is available. Undefined = user cancelled. */
  async obtain(server: ServerConfig, kind: SecretKind, opts: { forcePrompt?: boolean; detail?: string } = {}): Promise<string | undefined> {
    const k = this.key(server.id, kind);
    if (!opts.forcePrompt) {
      const known = this.session.get(k) ?? (await this.getStored(server.id, kind));
      if (known !== undefined) return known;
    }
    const who = server.username ? `${server.username}@${server.host}` : server.host;
    const value = await vscode.window.showInputBox({
      title: `${server.name}: ${kind === 'password' ? 'Password' : 'Private key passphrase'}`,
      prompt: opts.detail ?? (kind === 'password' ? `Password for ${who}` : `Passphrase for ${server.privateKeyPath ?? 'private key'}`),
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return undefined;
    this.session.set(k, value);
    return value;
  }

  /** Persists a prompted secret after a successful login when the user agrees. */
  async offerToSave(server: ServerConfig, kind: SecretKind): Promise<void> {
    const k = this.key(server.id, kind);
    const value = this.session.get(k);
    if (value === undefined || (await this.getStored(server.id, kind)) === value) return;
    const choice = await vscode.window.showInformationMessage(
      `Save the ${kind} for "${server.name}" in the system keychain?`,
      'Save',
      'Not Now',
    );
    if (choice === 'Save') await this.store(server.id, kind, value);
  }

  async readPrivateKey(path: string): Promise<Buffer> {
    return fs.readFile(expandHome(path));
  }

  // ---- Host keys -------------------------------------------------------------------------

  private stored(): Record<string, { type: string; key: string }[]> {
    return this.context.globalState.get<Record<string, { type: string; key: string }[]>>(STORE_KEY) ?? {};
  }

  private async remember(host: string, port: number, type: string, key: Buffer): Promise<void> {
    const all = this.stored();
    const token = hostToken(host, port);
    all[token] = [...(all[token] ?? []).filter((e) => e.type !== type), { type, key: key.toString('base64') }];
    await this.context.globalState.update(STORE_KEY, all);
  }

  async forgetHostKeys(host: string, port: number): Promise<void> {
    const all = this.stored();
    delete all[hostToken(host, port)];
    await this.context.globalState.update(STORE_KEY, all);
  }

  /** Enforces known-hosts policy: ~/.ssh/known_hosts first, then keys the user accepted in iRemote. */
  async verifyHostKey(host: string, port: number, keyType: string, key: Buffer): Promise<boolean> {
    const extra = vscode.workspace.getConfiguration('iremote').get<string[]>('ssh.knownHostsFiles', []);
    const files = [join(homedir(), '.ssh', 'known_hosts'), ...extra.map(expandHome)];
    const systemEntries: ReturnType<typeof parseKnownHosts> = [];
    for (const file of files) {
      try {
        systemEntries.push(...parseKnownHosts(await fs.readFile(file, 'utf8')));
      } catch {
        // Missing file: rely on the remaining files and iRemote's own store.
      }
    }
    const fp = fingerprintSha256(key);
    if (isRevoked(systemEntries, key)) {
      void vscode.window.showErrorMessage(`The host key for ${host} (${fp}) is marked @revoked in known_hosts. Connection refused.`, { modal: true });
      return false;
    }
    const sys = checkHostKey(systemEntries, host, port, keyType, key);
    if (sys === 'trusted') return true;

    const sessionId = `${hostToken(host, port)} ${key.toString('base64')}`;
    if (this.sessionHostKeys.has(sessionId)) return true;

    const own = this.stored()[hostToken(host, port)] ?? [];
    const ownMatch = own.find((e) => e.type === keyType);
    if (ownMatch?.key === key.toString('base64')) return true;

    if (sys === 'mismatch' || ownMatch) {
      const choice = await vscode.window.showWarningMessage(
        `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED for ${host}:${port}!`,
        {
          modal: true,
          detail:
            `The ${keyType} host key presented by the server does not match the key previously trusted.\n` +
            `This could mean someone is intercepting the connection (man-in-the-middle), or the server was reinstalled.\n\n` +
            `New fingerprint: ${fp}\n\nOnly continue if you have verified this fingerprint with the server administrator.`,
        },
        'Replace Trusted Key',
      );
      if (choice !== 'Replace Trusted Key') return false;
      await this.remember(host, port, keyType, key);
      return true;
    }

    const choice = await vscode.window.showWarningMessage(
      `The authenticity of host ${host}:${port} can't be established.`,
      { modal: true, detail: `${keyType} key fingerprint is ${fp}.\n\nAre you sure you want to continue connecting?` },
      'Trust and Remember',
      'Trust Once',
    );
    if (choice === 'Trust and Remember') await this.remember(host, port, keyType, key);
    if (choice === 'Trust Once') this.sessionHostKeys.add(sessionId);
    return choice === 'Trust and Remember' || choice === 'Trust Once';
  }

  /** Prompt for an untrusted TLS certificate. Returns 'remember', 'once' or undefined (reject). */
  async verifyCertificate(serverName: string, host: string, fingerprint: string, reason: string): Promise<'remember' | 'once' | undefined> {
    const choice = await vscode.window.showWarningMessage(
      `The TLS certificate presented by ${host} is not trusted.`,
      {
        modal: true,
        detail: `Server: ${serverName}\nReason: ${reason}\nSHA-256 fingerprint:\n${fingerprint}\n\nOnly accept if you recognise this certificate.`,
      },
      'Accept and Remember',
      'Accept Once',
    );
    return choice === 'Accept and Remember' ? 'remember' : choice === 'Accept Once' ? 'once' : undefined;
  }

  async keyboardInteractive(serverName: string, prompts: { prompt: string; echo: boolean }[]): Promise<string[] | undefined> {
    const answers: string[] = [];
    for (const p of prompts) {
      const v = await vscode.window.showInputBox({ title: `${serverName}: authentication`, prompt: p.prompt, password: !p.echo, ignoreFocusOut: true });
      if (v === undefined) return undefined;
      answers.push(v);
    }
    return answers;
  }
}
