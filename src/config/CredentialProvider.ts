import type { ServerConfig } from './schema';

export type SecretKind = 'password' | 'passphrase';

/**
 * Secrets, prompts and trust decisions needed to log in. Implemented per host: VS Code (SecretStorage + input boxes)
 * and the Neovim server (system keychain + prompts relayed to Neovim).
 */
export interface CredentialProvider {
  getStored(serverId: string, kind: SecretKind): Promise<string | undefined>;
  /** Returns the stored or session secret, prompting when none is available. Undefined = user cancelled. */
  obtain(server: ServerConfig, kind: SecretKind, opts?: { forcePrompt?: boolean; detail?: string }): Promise<string | undefined>;
  forgetSession(serverId: string, kind: SecretKind): void;
  /** Persists a prompted secret after a successful login when the user agrees. */
  offerToSave(server: ServerConfig, kind: SecretKind): Promise<void>;
  readPrivateKey(path: string): Promise<Buffer>;
  verifyHostKey(host: string, port: number, keyType: string, key: Buffer): Promise<boolean>;
  /** Untrusted TLS certificate: 'remember', 'once' or undefined (reject). */
  verifyCertificate(serverName: string, host: string, fingerprint: string, reason: string): Promise<'remember' | 'once' | undefined>;
  keyboardInteractive(serverName: string, prompts: { prompt: string; echo: boolean }[]): Promise<string[] | undefined>;
}
