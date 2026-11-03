import { Client, type ClientChannel } from 'ssh2';
import { RemoteError, type ConnectContext } from './types';
import { hostKeyType } from './SftpClient';

export interface JumpSpec {
  host: string;
  port: number;
  username: string;
}

/** Parses "user@host:port" (user and port optional) as used by OpenSSH ProxyJump. Only the first hop is used. */
export const parseJump = (spec: string, defaultUser: string): JumpSpec | undefined => {
  const first = spec.split(',')[0].trim();
  const m = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(first);
  if (!m) return undefined;
  return { username: m[1] ?? defaultUser, host: m[2].replace(/^\[|\]$/g, ''), port: m[3] ? Number(m[3]) : 22 };
};

/**
 * Opens an SSH connection to the jump host and a direct-tcpip channel to the target.
 * The jump host is authenticated with the agent / private key from the context, falling back to keyboard-interactive.
 */
export const openJumpChannel = async (
  jump: JumpSpec,
  targetHost: string,
  targetPort: number,
  ctx: ConnectContext,
): Promise<{ channel: ClientChannel; close: () => void }> => {
  if (!ctx.verifyHostKey) throw new RemoteError('HostKey', 'Host key verification handler is required.');
  const verify = ctx.verifyHostKey;
  const conn = new Client();
  conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
    if (!ctx.promptKeyboardInteractive) return finish([]);
    ctx.promptKeyboardInteractive(prompts.map((p) => ({ prompt: `[${jump.host}] ${p.prompt}`, echo: !!p.echo }))).then(
      (a) => finish(a ?? []),
      () => finish([]),
    );
  });
  await new Promise<void>((resolve, reject) => {
    conn.once('ready', () => resolve());
    conn.once('error', (err: Error & { level?: string }) =>
      reject(
        new RemoteError(
          err.level === 'client-authentication' ? 'Auth' : 'Connection',
          `Jump host ${jump.host}:${jump.port}: ${err.message}`,
          undefined,
          err,
        ),
      ),
    );
    conn.connect({
      host: jump.host,
      port: jump.port,
      username: jump.username,
      agent: ctx.agent,
      privateKey: ctx.privateKey,
      passphrase: ctx.passphrase,
      tryKeyboard: true,
      readyTimeout: ctx.timeoutMs,
      hostVerifier: (key: Buffer, cb: (ok: boolean) => void) => {
        verify(jump.host, jump.port, hostKeyType(key), key).then(cb, () => cb(false));
      },
    });
  });
  const channel = await new Promise<ClientChannel>((resolve, reject) =>
    conn.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, ch) =>
      err ? reject(new RemoteError('Connection', `Jump host cannot reach ${targetHost}:${targetPort}: ${err.message}`, undefined, err)) : resolve(ch),
    ),
  );
  channel.on('close', () => conn.end());
  return { channel, close: () => conn.end() };
};
