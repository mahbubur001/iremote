/**
 * Newline-delimited JSON-RPC 2.0 over stdio, in both directions: Neovim calls server methods, and the server calls
 * back into Neovim for prompts (passwords, host keys, conflicts). stdout carries protocol messages only.
 */
type Handler = (params: never) => unknown;

interface Message {
  jsonrpc?: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export class Rpc {
  private readonly handlers = new Map<string, Handler>();
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private buffer = '';

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {}

  on<P, R>(method: string, handler: (params: P) => R | Promise<R>): void {
    this.handlers.set(method, handler as Handler);
  }

  start(onClose: () => void): void {
    this.input.setEncoding('utf8');
    this.input.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) void this.dispatch(line);
      }
    });
    this.input.on('end', onClose);
  }

  /** Calls a method in Neovim and waits for its answer. */
  request<R>(method: string, params: unknown): Promise<R> {
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(msg: Message): void {
    this.output.write(`${JSON.stringify(msg)}\n`);
  }

  private async dispatch(line: string): Promise<void> {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      this.send({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (msg.method === undefined) {
      // Response to one of our requests.
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result ?? null);
      return;
    }
    const handler = this.handlers.get(msg.method);
    if (msg.id === undefined) {
      if (handler) void Promise.resolve().then(() => handler(msg.params as never)).catch(() => undefined);
      return;
    }
    if (!handler) {
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } });
      return;
    }
    try {
      const result = await handler((msg.params ?? {}) as never);
      this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
    } catch (e) {
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: 1, message: e instanceof Error ? e.message : String(e) } });
    }
  }
}
