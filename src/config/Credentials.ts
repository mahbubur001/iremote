import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { HostKeyTrust, type TrustedKeys } from './HostKeyTrust';
import type { ServerConfig } from './schema';
import { expandHome } from './sshConfig';
import type { CredentialProvider, SecretKind } from './CredentialProvider';

const STORE_KEY = 'iremote.knownHosts';


export { expandHome, resolveSshConfig, defaultAgentSocket, type SshConfigResolution } from './sshConfig';

export class Credentials implements CredentialProvider {
  /** Passwords typed for this session only (user chose not to save, or not yet saved). */
  private readonly session = new Map<string, string>();

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

  private readonly hostKeys = new HostKeyTrust({
    extraKnownHostsFiles: () => vscode.workspace.getConfiguration('iremote').get<string[]>('ssh.knownHostsFiles', []),
    load: () => this.context.globalState.get<TrustedKeys>(STORE_KEY) ?? {},
    save: async (keys) => {
      await this.context.globalState.update(STORE_KEY, keys);
    },
    ask: async (q) => {
      if (q.kind === 'revoked') {
        void vscode.window.showErrorMessage(`The host key for ${q.host} (${q.fingerprint}) is marked @revoked in known_hosts. Connection refused.`, { modal: true });
        return undefined;
      }
      if (q.kind === 'changed') {
        const choice = await vscode.window.showWarningMessage(
          `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED for ${q.host}:${q.port}!`,
          {
            modal: true,
            detail:
              `The ${q.keyType} host key presented by the server does not match the key previously trusted.\n` +
              `This could mean someone is intercepting the connection (man-in-the-middle), or the server was reinstalled.\n\n` +
              `New fingerprint: ${q.fingerprint}\n\nOnly continue if you have verified this fingerprint with the server administrator.`,
          },
          'Replace Trusted Key',
        );
        return choice === 'Replace Trusted Key' ? 'remember' : undefined;
      }
      const choice = await vscode.window.showWarningMessage(
        `The authenticity of host ${q.host}:${q.port} can't be established.`,
        { modal: true, detail: `${q.keyType} key fingerprint is ${q.fingerprint}.\n\nAre you sure you want to continue connecting?` },
        'Trust and Remember',
        'Trust Once',
      );
      return choice === 'Trust and Remember' ? 'remember' : choice === 'Trust Once' ? 'once' : undefined;
    },
  });

  forgetHostKeys(host: string, port: number): Promise<void> {
    return this.hostKeys.forget(host, port);
  }

  /** Enforces known-hosts policy: ~/.ssh/known_hosts first, then keys the user accepted in iRemote. */
  verifyHostKey(host: string, port: number, keyType: string, key: Buffer): Promise<boolean> {
    return this.hostKeys.verify(host, port, keyType, key);
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
