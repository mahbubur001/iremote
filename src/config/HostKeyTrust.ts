import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkHostKey, fingerprintSha256, hostToken, isRevoked, parseKnownHosts } from './KnownHosts';
import { expandHome } from './sshConfig';

export type TrustedKeys = Record<string, { type: string; key: string }[]>;

export type HostKeyQuestion =
  | { kind: 'revoked'; host: string; port: number; keyType: string; fingerprint: string }
  | { kind: 'changed'; host: string; port: number; keyType: string; fingerprint: string }
  | { kind: 'unknown'; host: string; port: number; keyType: string; fingerprint: string };

/** 'remember' = add to iRemote's trusted keys, 'once' = trust for this session, undefined = refuse. */
export type HostKeyAnswer = 'remember' | 'once' | undefined;

export interface HostKeyTrustOptions {
  /** Extra known_hosts files besides ~/.ssh/known_hosts. */
  extraKnownHostsFiles(): string[];
  load(): TrustedKeys | Promise<TrustedKeys>;
  save(keys: TrustedKeys): Promise<void>;
  /** Asks the user. For 'revoked' only informs; the answer is ignored and the key is refused. */
  ask(q: HostKeyQuestion): Promise<HostKeyAnswer>;
}

/** Known-hosts policy shared by every host: ~/.ssh/known_hosts first, then keys the user accepted in iRemote. */
export class HostKeyTrust {
  /** Host keys accepted with "Trust Once" — valid for this process so pooled connections don't re-prompt. */
  private readonly session = new Set<string>();

  constructor(private readonly opts: HostKeyTrustOptions) {}

  async verify(host: string, port: number, keyType: string, key: Buffer): Promise<boolean> {
    const files = [join(homedir(), '.ssh', 'known_hosts'), ...this.opts.extraKnownHostsFiles().map(expandHome)];
    const systemEntries: ReturnType<typeof parseKnownHosts> = [];
    for (const file of files) {
      try {
        systemEntries.push(...parseKnownHosts(await fs.readFile(file, 'utf8')));
      } catch {
        // Missing file: rely on the remaining files and iRemote's own store.
      }
    }
    const fingerprint = fingerprintSha256(key);
    if (isRevoked(systemEntries, key)) {
      await this.opts.ask({ kind: 'revoked', host, port, keyType, fingerprint });
      return false;
    }
    const sys = checkHostKey(systemEntries, host, port, keyType, key);
    if (sys === 'trusted') return true;

    const sessionId = `${hostToken(host, port)} ${key.toString('base64')}`;
    if (this.session.has(sessionId)) return true;

    const own = (await this.opts.load())[hostToken(host, port)] ?? [];
    const ownMatch = own.find((e) => e.type === keyType);
    if (ownMatch?.key === key.toString('base64')) return true;

    if (sys === 'mismatch' || ownMatch) {
      // A changed key can only be replaced permanently, never trusted "once".
      if ((await this.opts.ask({ kind: 'changed', host, port, keyType, fingerprint })) !== 'remember') return false;
      await this.remember(host, port, keyType, key);
      return true;
    }

    const answer = await this.opts.ask({ kind: 'unknown', host, port, keyType, fingerprint });
    if (answer === 'remember') await this.remember(host, port, keyType, key);
    if (answer === 'once') this.session.add(sessionId);
    return answer === 'remember' || answer === 'once';
  }

  private async remember(host: string, port: number, type: string, key: Buffer): Promise<void> {
    const all = { ...(await this.opts.load()) };
    const token = hostToken(host, port);
    all[token] = [...(all[token] ?? []).filter((e) => e.type !== type), { type, key: key.toString('base64') }];
    await this.opts.save(all);
  }

  async forget(host: string, port: number): Promise<void> {
    const all = { ...(await this.opts.load()) };
    delete all[hostToken(host, port)];
    await this.opts.save(all);
  }
}
