import { execFile, spawn } from 'node:child_process';

/** System keychain access for the Neovim server. Secrets are never passed on a command line. */
export interface Keychain {
  readonly persistent: boolean;
  get(account: string): Promise<string | undefined>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

const SERVICE = 'iremote';

const run = (cmd: string, args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });

/** macOS: `security`. Writes go through `security -i` on stdin so the secret never shows up in `ps`. */
class MacKeychain implements Keychain {
  readonly persistent = true;

  async get(account: string): Promise<string | undefined> {
    const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
    return r.code === 0 ? r.stdout.replace(/\n$/, '') : undefined;
  }

  async set(account: string, secret: string): Promise<void> {
    if (/[\r\n]/.test(secret) || /[\r\n"]/.test(account)) throw new Error('Secret cannot be stored in the keychain.');
    const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const r = await run('security', ['-i'], `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(account)} -w ${quote(secret)}\n`);
    if (r.code !== 0 || /error/i.test(r.stderr)) throw new Error(`Keychain write failed: ${r.stderr.trim() || r.code}`);
  }

  async delete(account: string): Promise<void> {
    await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
  }
}

/** Linux: libsecret's `secret-tool` (reads the secret from stdin). */
class SecretTool implements Keychain {
  readonly persistent = true;

  async get(account: string): Promise<string | undefined> {
    const r = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
    return r.code === 0 && r.stdout !== '' ? r.stdout.replace(/\n$/, '') : undefined;
  }

  async set(account: string, secret: string): Promise<void> {
    const r = await run('secret-tool', ['store', `--label=iRemote ${account}`, 'service', SERVICE, 'account', account], secret);
    if (r.code !== 0) throw new Error(`Keychain write failed: ${r.stderr.trim() || r.code}`);
  }

  async delete(account: string): Promise<void> {
    await run('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
  }
}

/** No keychain available: secrets live for this Neovim session only. */
class NoKeychain implements Keychain {
  readonly persistent = false;
  async get(): Promise<string | undefined> {
    return undefined;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
}

const hasCommand = (cmd: string): Promise<boolean> =>
  new Promise((resolve) => execFile('which', [cmd], (err) => resolve(!err)));

export const detectKeychain = async (): Promise<Keychain> => {
  if (process.platform === 'darwin') return new MacKeychain();
  if (process.platform === 'linux' && (await hasCommand('secret-tool'))) return new SecretTool();
  return new NoKeychain();
};
