import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/** What we last knew about a file after a successful transfer in either direction. */
export interface SyncRecord {
  remoteMtime: number;
  remoteSize: number;
  localMtime: number;
  localSize: number;
  /** SHA-1 of the content at the time of the transfer. */
  sha1?: string;
  at: number;
}

interface FileShape {
  version: 1;
  servers: Record<string, Record<string, SyncRecord>>;
}

/**
 * Persistent record of the last synchronized state per server and remote path.
 * Used to detect "remote file changed since last upload/download" (PhpStorm: warn when uploading over newer file)
 * and to classify files during sync without clock-skew problems.
 */
export class StateCache {
  private data: FileShape = { version: 1, servers: {} };
  private saveTimer?: NodeJS.Timeout;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as FileShape;
      if (parsed?.version === 1 && parsed.servers && typeof parsed.servers === 'object') this.data = parsed;
    } catch {
      this.data = { version: 1, servers: {} };
    }
  }

  get(serverId: string, remotePath: string): SyncRecord | undefined {
    return this.data.servers[serverId]?.[remotePath];
  }

  set(serverId: string, remotePath: string, record: Omit<SyncRecord, 'at'>): void {
    (this.data.servers[serverId] ??= {})[remotePath] = { ...record, at: Date.now() };
    this.scheduleSave();
  }

  delete(serverId: string, remotePath: string, recursive = false): void {
    const map = this.data.servers[serverId];
    if (!map) return;
    delete map[remotePath];
    if (recursive) {
      const prefix = remotePath.endsWith('/') ? remotePath : `${remotePath}/`;
      for (const key of Object.keys(map)) if (key.startsWith(prefix)) delete map[key];
    }
    this.scheduleSave();
  }

  rename(serverId: string, from: string, to: string): void {
    const map = this.data.servers[serverId];
    if (!map) return;
    const prefix = from.endsWith('/') ? from : `${from}/`;
    for (const key of Object.keys(map)) {
      if (key === from) map[to] = map[key];
      else if (key.startsWith(prefix)) map[to + key.slice(from.length)] = map[key];
      else continue;
      delete map[key];
    }
    this.scheduleSave();
  }

  forgetServer(serverId: string): void {
    delete this.data.servers[serverId];
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 1000);
    this.saveTimer.unref?.();
  }

  /** Writes atomically (temp file + rename) so a crash cannot leave a truncated cache. */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const snapshot = JSON.stringify(this.data);
    this.saving = this.saving.catch(() => undefined).then(async () => {
      await fs.mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, this.file);
    });
    await this.saving.catch(() => undefined);
  }
}
