import { EventEmitter } from 'node:events';
import { RemoteError, errorMessage, type ProgressFn, type RemoteClient } from '../protocol/types';
import type { ConnectionPool } from './ConnectionPool';

export type TaskKind = 'upload' | 'download' | 'delete' | 'mkdir' | 'rename' | 'chmod';
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TaskInfo {
  id: number;
  kind: TaskKind;
  serverId: string;
  serverName: string;
  /** Human-readable source (local path for uploads, remote for downloads). */
  source: string;
  /** Human-readable destination. */
  target: string;
  status: TaskStatus;
  bytes: number;
  total: number;
  error?: string;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface TaskSpec {
  kind: TaskKind;
  serverId: string;
  serverName: string;
  source: string;
  target: string;
  /** Tasks sharing a key run strictly in order; queued uploads with the same key are coalesced. */
  key: string;
  run: (client: RemoteClient, progress: ProgressFn) => Promise<void>;
}

interface Task {
  info: TaskInfo;
  spec: TaskSpec;
  resolve: () => void;
  reject: (e: unknown) => void;
  promise: Promise<void>;
}

export interface QueueEvents {
  changed: [TaskInfo];
  idle: [];
}

const MAX_HISTORY = 500;

export class TransferQueue extends EventEmitter<QueueEvents> {
  private nextId = 1;
  private queued: Task[] = [];
  private running = new Set<Task>();
  private history: TaskInfo[] = [];
  private cancelledServers = new Set<string>();

  constructor(
    private readonly getPool: (serverId: string) => ConnectionPool,
    private readonly getConcurrency: (serverId: string) => number,
  ) {
    super();
  }

  get tasks(): readonly TaskInfo[] {
    return this.history;
  }

  get pendingCount(): number {
    return this.queued.length + this.running.size;
  }

  enqueue(spec: TaskSpec): Promise<void> {
    if (spec.kind === 'upload' || spec.kind === 'download') {
      const dup = this.queued.find((t) => t.spec.key === spec.key && t.spec.kind === spec.kind);
      if (dup) {
        // A newer save of the same file supersedes the queued one; both callers wait for the same transfer.
        dup.spec = spec;
        return dup.promise;
      }
    }
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const info: TaskInfo = {
      id: this.nextId++,
      kind: spec.kind,
      serverId: spec.serverId,
      serverName: spec.serverName,
      source: spec.source,
      target: spec.target,
      status: 'queued',
      bytes: 0,
      total: 0,
      queuedAt: Date.now(),
    };
    const task: Task = { info, spec, resolve, reject, promise };
    this.cancelledServers.delete(spec.serverId);
    this.queued.push(task);
    this.history.unshift(info);
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
    this.emit('changed', info);
    this.pump();
    return promise;
  }

  private runningFor(serverId: string): number {
    let n = 0;
    for (const t of this.running) if (t.spec.serverId === serverId) n++;
    return n;
  }

  private keyBusy(key: string, before: Task): boolean {
    for (const t of this.running) if (t.spec.key === key) return true;
    for (const t of this.queued) {
      if (t === before) return false;
      if (t.spec.key === key) return true;
    }
    return false;
  }

  private pump(): void {
    for (const task of [...this.queued]) {
      const { serverId, key } = task.spec;
      if (this.runningFor(serverId) >= Math.max(1, this.getConcurrency(serverId))) continue;
      if (this.keyBusy(key, task)) continue;
      this.queued.splice(this.queued.indexOf(task), 1);
      this.running.add(task);
      void this.execute(task);
    }
    if (this.queued.length === 0 && this.running.size === 0) this.emit('idle');
  }

  private async execute(task: Task): Promise<void> {
    const { info } = task;
    info.status = 'running';
    info.startedAt = Date.now();
    this.emit('changed', info);
    let lastEmit = 0;
    const progress: ProgressFn = (bytes, total) => {
      info.bytes = bytes;
      info.total = total;
      const now = Date.now();
      if (now - lastEmit > 200) {
        lastEmit = now;
        this.emit('changed', info);
      }
    };
    try {
      await this.getPool(task.spec.serverId).use((client) => task.spec.run(client, progress));
      info.status = 'done';
      task.resolve();
    } catch (e) {
      const cancelled = this.cancelledServers.has(task.spec.serverId) || (e instanceof RemoteError && e.code === 'Cancelled');
      info.status = cancelled ? 'cancelled' : 'failed';
      info.error = cancelled ? 'Cancelled' : errorMessage(e);
      task.reject(cancelled ? new RemoteError('Cancelled', 'Transfer cancelled.', info.target, e) : e);
    } finally {
      info.finishedAt = Date.now();
      this.running.delete(task);
      this.emit('changed', info);
      this.pump();
    }
  }

  /** Cancels queued tasks and aborts in-flight transfers by dropping their connections. */
  async cancel(serverId?: string): Promise<void> {
    const match = (t: Task) => serverId === undefined || t.spec.serverId === serverId;
    for (const task of this.queued.filter(match)) {
      this.queued.splice(this.queued.indexOf(task), 1);
      task.info.status = 'cancelled';
      task.info.error = 'Cancelled';
      task.info.finishedAt = Date.now();
      task.reject(new RemoteError('Cancelled', 'Transfer cancelled.', task.info.target));
      this.emit('changed', task.info);
    }
    const servers = new Set([...this.running].filter(match).map((t) => t.spec.serverId));
    for (const id of servers) {
      this.cancelledServers.add(id);
      await this.getPool(id).closeAll();
    }
    this.pump();
  }

  clearFinished(): void {
    this.history = this.history.filter((t) => t.status === 'queued' || t.status === 'running');
    this.emit('idle');
  }
}
