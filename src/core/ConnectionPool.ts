import { RemoteError, type RemoteClient } from '../protocol/types';

interface Slot {
  client: RemoteClient;
  busy: boolean;
  dead: boolean;
  lastUsed: number;
}

export interface PoolOptions {
  maxConnections: number;
  idleCloseMs: number;
}

/**
 * Per-server pool of protocol clients. FTP can only run one command per control connection,
 * so parallelism comes from multiple clients. The first connection is established alone so that
 * interactive prompts (password, host key) happen once before more connections are opened.
 */
export class ConnectionPool {
  private slots: Slot[] = [];
  private waiters: { resolve: (slot: Slot) => void; reject: (e: unknown) => void }[] = [];
  private pendingConnects = 0;
  private firstConnect?: Promise<void>;
  private hasConnected = false;
  private idleTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private readonly factory: () => RemoteClient,
    private readonly opts: PoolOptions,
  ) {}

  get size(): number {
    return this.slots.length;
  }

  get activeCount(): number {
    return this.slots.filter((s) => s.busy).length;
  }

  /** Runs `fn` with a leased client. Retries once on a fresh connection if a reused one turned out to be stale. */
  async use<T>(fn: (client: RemoteClient) => Promise<T>): Promise<T> {
    const slot = await this.acquire();
    const reused = slot.lastUsed > 0;
    try {
      return await fn(slot.client);
    } catch (e) {
      if (e instanceof RemoteError && e.code === 'Connection') {
        this.discard(slot);
        if (reused && !this.disposed) {
          const fresh = await this.acquire();
          try {
            return await fn(fresh.client);
          } finally {
            this.release(fresh);
          }
        }
      } else if (e instanceof RemoteError && e.isFatal) {
        this.discard(slot);
      }
      throw e;
    } finally {
      this.release(slot);
    }
  }

  private async acquire(): Promise<Slot> {
    if (this.disposed) throw new RemoteError('Cancelled', 'Connection pool closed.');
    const idle = this.slots.find((s) => !s.busy && !s.dead && s.client.connected);
    if (idle) {
      idle.busy = true;
      return idle;
    }
    if (!this.hasConnected && this.firstConnect) {
      // Share the outcome of the first (possibly interactive) connection attempt instead of prompting again.
      await this.firstConnect;
      return this.acquire();
    }
    if (this.slots.length + this.pendingConnects < this.opts.maxConnections) {
      return this.open();
    }
    return new Promise<Slot>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private async open(): Promise<Slot> {
    this.pendingConnects++;
    const client = this.factory();
    const attempt = client.connect();
    const isFirst = !this.hasConnected;
    if (isFirst) this.firstConnect = attempt;
    try {
      await attempt;
    } catch (e) {
      if (isFirst && this.firstConnect === attempt) this.firstConnect = undefined;
      await client.close().catch(() => undefined);
      throw e;
    } finally {
      this.pendingConnects--;
    }
    this.hasConnected = true;
    const slot: Slot = { client, busy: true, dead: false, lastUsed: 0 };
    client.onClose(() => this.discard(slot));
    if (this.disposed) {
      await client.close();
      throw new RemoteError('Cancelled', 'Connection pool closed.');
    }
    this.slots.push(slot);
    this.scheduleIdleCheck();
    return slot;
  }

  private release(slot: Slot): void {
    if (!slot.busy) return;
    slot.busy = false;
    slot.lastUsed = Date.now();
    if (slot.dead) {
      this.wakeWaiterWithNewConnection();
      return;
    }
    const next = this.waiters.shift();
    if (next) {
      slot.busy = true;
      next.resolve(slot);
    }
  }

  private discard(slot: Slot): void {
    if (slot.dead) return;
    slot.dead = true;
    this.slots = this.slots.filter((s) => s !== slot);
    void slot.client.close().catch(() => undefined);
    if (!slot.busy) this.wakeWaiterWithNewConnection();
  }

  /** A slot went away while requests are queued: open a replacement for the first waiter. */
  private wakeWaiterWithNewConnection(): void {
    const next = this.waiters.shift();
    if (!next) return;
    this.open().then(next.resolve, next.reject);
  }

  private scheduleIdleCheck(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const slot of [...this.slots]) {
        if (!slot.busy && now - slot.lastUsed > this.opts.idleCloseMs) this.discard(slot);
      }
      if (this.slots.length === 0 && this.idleTimer) {
        clearInterval(this.idleTimer);
        this.idleTimer = undefined;
      }
    }, Math.min(this.opts.idleCloseMs, 30_000));
    this.idleTimer.unref?.();
  }

  async closeAll(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    const slots = this.slots.splice(0);
    slots.forEach((s) => (s.dead = true));
    this.waiters.splice(0).forEach((w) => w.reject(new RemoteError('Cancelled', 'Connections closed.')));
    await Promise.all(slots.map((s) => s.client.close().catch(() => undefined)));
    this.hasConnected = false;
    this.firstConnect = undefined;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.closeAll();
  }
}
