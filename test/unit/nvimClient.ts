import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';

export type Answers = Record<string, (params: { message?: string; choices?: string[]; prompt?: string }) => unknown>;

/** Minimal JSON-RPC client playing the Neovim side; answers server→client prompts from `answers`. */
export class Client {
  private buffer = '';
  private id = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly notifications: { method: string; params: unknown }[] = [];
  readonly asked: { method: string; params: unknown }[] = [];

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly answers: Answers,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(this.buffer.slice(0, nl));
        this.buffer = this.buffer.slice(nl + 1);
        this.handle(msg);
      }
    });
  }

  private handle(msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }): void {
    if (msg.method && msg.id !== undefined) {
      this.asked.push({ method: msg.method, params: msg.params });
      const answer = this.answers[msg.method]?.(msg.params as { choices?: string[] }) ?? null;
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: answer })}\n`);
    } else if (msg.method) {
      this.notifications.push({ method: msg.method, params: msg.params });
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }

  call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
}

/** Spawns the bundled server (out-test/nvim/iremote.js, built by scripts/build-tests.mjs). */
export const startServer = (answers: Answers = {}) => {
  const child = spawn(process.execPath, [join(__dirname, '..', 'nvim', 'iremote.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  return { child, client: new Client(child, answers) };
};

export const stopServer = async (client: Client, child: ChildProcessWithoutNullStreams): Promise<void> => {
  await client.call('shutdown').catch(() => undefined);
  if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
};
