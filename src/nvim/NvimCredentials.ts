import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { CredentialProvider, SecretKind } from '../config/CredentialProvider';
import { HostKeyTrust, type TrustedKeys } from '../config/HostKeyTrust';
import { expandHome } from '../config/sshConfig';
import type { ServerConfig } from '../config/schema';
import type { Keychain } from './keychain';
import type { Rpc } from './rpc';

/** Asks Neovim to pick one of `choices`; resolves to the choice or null when dismissed. */
export const confirm = (rpc: Rpc, message: string, detail: string, choices: string[]): Promise<string | null> =>
  rpc.request<string | null>('confirm', { message, detail, choices });

const prompt = (rpc: Rpc, title: string, text: string, secret: boolean): Promise<string | null> =>
  rpc.request<string | null>('prompt', { title, prompt: text, secret });

/** Credentials for the Neovim host: system keychain, prompts relayed to Neovim, iRemote's own trusted host keys. */
export class NvimCredentials implements CredentialProvider {
  private readonly session = new Map<string, string>();
  private readonly hostKeys: HostKeyTrust;

  constructor(
    private readonly rpc: Rpc,
    private readonly keychain: Keychain,
    /** JSON file holding host keys accepted with "Trust and Remember". */
    private readonly hostKeysFile: string,
    private readonly knownHostsFiles: () => string[],
  ) {
    this.hostKeys = new HostKeyTrust({
      extraKnownHostsFiles: this.knownHostsFiles,
      load: () => this.loadHostKeys(),
      save: (keys) => this.saveHostKeys(keys),
      ask: async (q) => {
        if (q.kind === 'revoked') {
          await confirm(this.rpc, `The host key for ${q.host} is marked @revoked in known_hosts. Connection refused.`, q.fingerprint, ['OK']);
          return undefined;
        }
        if (q.kind === 'changed') {
          const c = await confirm(
            this.rpc,
            `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED for ${q.host}:${q.port}!`,
            `The ${q.keyType} host key does not match the key previously trusted. Someone may be intercepting the ` +
              `connection, or the server was reinstalled.\nNew fingerprint: ${q.fingerprint}\n` +
              `Only continue if you have verified this fingerprint with the server administrator.`,
            ['Replace Trusted Key', 'Cancel'],
          );
          return c === 'Replace Trusted Key' ? 'remember' : undefined;
        }
        const c = await confirm(
          this.rpc,
          `The authenticity of host ${q.host}:${q.port} can't be established.`,
          `${q.keyType} key fingerprint is ${q.fingerprint}. Continue connecting?`,
          ['Trust and Remember', 'Trust Once', 'Cancel'],
        );
        return c === 'Trust and Remember' ? 'remember' : c === 'Trust Once' ? 'once' : undefined;
      },
    });
  }

  private account(serverId: string, kind: SecretKind): string {
    return `${serverId}.${kind}`;
  }

  getStored(serverId: string, kind: SecretKind): Promise<string | undefined> {
    return this.keychain.get(this.account(serverId, kind));
  }

  forgetSession(serverId: string, kind: SecretKind): void {
    this.session.delete(this.account(serverId, kind));
  }

  async forget(serverId: string): Promise<void> {
    for (const kind of ['password', 'passphrase'] as SecretKind[]) {
      this.forgetSession(serverId, kind);
      await this.keychain.delete(this.account(serverId, kind));
    }
  }

  async obtain(server: ServerConfig, kind: SecretKind, opts: { forcePrompt?: boolean; detail?: string } = {}): Promise<string | undefined> {
    const k = this.account(server.id, kind);
    if (!opts.forcePrompt) {
      const known = this.session.get(k) ?? (await this.getStored(server.id, kind));
      if (known !== undefined) return known;
    }
    const who = server.username ? `${server.username}@${server.host}` : server.host;
    const value = await prompt(
      this.rpc,
      `${server.name}: ${kind === 'password' ? 'Password' : 'Private key passphrase'}`,
      opts.detail ?? (kind === 'password' ? `Password for ${who}` : `Passphrase for ${server.privateKeyPath ?? 'private key'}`),
      true,
    );
    if (value === null) return undefined;
    this.session.set(k, value);
    return value;
  }

  async offerToSave(server: ServerConfig, kind: SecretKind): Promise<void> {
    if (!this.keychain.persistent) return;
    const k = this.account(server.id, kind);
    const value = this.session.get(k);
    if (value === undefined || (await this.getStored(server.id, kind)) === value) return;
    const c = await confirm(this.rpc, `Save the ${kind} for "${server.name}" in the system keychain?`, '', ['Save', 'Not Now']);
    if (c === 'Save') await this.keychain.set(k, value);
  }

  readPrivateKey(path: string): Promise<Buffer> {
    return fs.readFile(expandHome(path));
  }

  verifyHostKey(host: string, port: number, keyType: string, key: Buffer): Promise<boolean> {
    return this.hostKeys.verify(host, port, keyType, key);
  }

  forgetHostKeys(host: string, port: number): Promise<void> {
    return this.hostKeys.forget(host, port);
  }

  async verifyCertificate(serverName: string, host: string, fingerprint: string, reason: string): Promise<'remember' | 'once' | undefined> {
    const c = await confirm(
      this.rpc,
      `The TLS certificate presented by ${host} is not trusted.`,
      `Server: ${serverName}\nReason: ${reason}\nSHA-256: ${fingerprint}\nOnly accept if you recognise this certificate.`,
      ['Accept and Remember', 'Accept Once', 'Cancel'],
    );
    return c === 'Accept and Remember' ? 'remember' : c === 'Accept Once' ? 'once' : undefined;
  }

  async keyboardInteractive(serverName: string, prompts: { prompt: string; echo: boolean }[]): Promise<string[] | undefined> {
    const answers: string[] = [];
    for (const p of prompts) {
      const v = await prompt(this.rpc, `${serverName}: authentication`, p.prompt, !p.echo);
      if (v === null) return undefined;
      answers.push(v);
    }
    return answers;
  }

  private async loadHostKeys(): Promise<TrustedKeys> {
    try {
      return JSON.parse(await fs.readFile(this.hostKeysFile, 'utf8')) as TrustedKeys;
    } catch {
      return {};
    }
  }

  private async saveHostKeys(keys: TrustedKeys): Promise<void> {
    await fs.mkdir(dirname(this.hostKeysFile), { recursive: true });
    const tmp = `${this.hostKeysFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.hostKeysFile);
  }
}
