import { promises as fs } from 'node:fs';
import type { RemoteClient, RemoteStat } from '../protocol/types';
import type { Deployer, DeploymentTarget } from './Deployer';
import { sha1Buffer, sha1File } from './Deployer';
import type { StateCache, SyncRecord } from './StateCache';

export type SyncState = 'same' | 'localOnly' | 'remoteOnly' | 'localNewer' | 'remoteNewer' | 'conflict';
export type SyncAction = 'upload' | 'download' | 'deleteRemote' | 'deleteLocal' | 'skip';

export interface SyncItem {
  id: number;
  remotePath: string;
  localPath: string;
  local?: { size: number; mtime: number };
  remote?: RemoteStat;
  state: SyncState;
  action: SyncAction;
  /** True when the file was transferred before (lets the UI explain "deleted on the other side"). */
  wasSynced: boolean;
}

export interface CompareOptions {
  /** Compare file contents when metadata is inconclusive (PhpStorm: "Compare content"). */
  compareContents: boolean;
  /** Upper bound for downloading a file just to compare it when hashing over SSH is unavailable. */
  maxDownloadCompareBytes: number;
}

const sameTime = (a: number, b: number) => Math.abs(a - b) < 2000;

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const defaultAction = (state: SyncState): SyncAction => {
  switch (state) {
    case 'localOnly':
    case 'localNewer':
      return 'upload';
    case 'remoteOnly':
    case 'remoteNewer':
      return 'download';
    case 'same':
    case 'conflict':
      return 'skip';
  }
};

/** Pure classification of one file pair; exported for unit tests. */
export const classify = (
  local: { size: number; mtime: number } | undefined,
  remote: RemoteStat | undefined,
  record: SyncRecord | undefined,
): SyncState => {
  if (local && !remote) return 'localOnly';
  if (!local && remote) return 'remoteOnly';
  if (!local || !remote) return 'same';
  if (record) {
    const localChanged = local.size !== record.localSize || !sameTime(local.mtime, record.localMtime);
    const timeKnown = remote.mtime > 0 && record.remoteMtime > 0;
    const remoteChanged = remote.size !== record.remoteSize || (timeKnown && !sameTime(remote.mtime, record.remoteMtime));
    if (!localChanged && !remoteChanged) return 'same';
    if (localChanged && !remoteChanged) return 'localNewer';
    if (!localChanged && remoteChanged) return 'remoteNewer';
    return 'conflict';
  }
  if (remote.mtime === 0) return local.size === remote.size ? 'same' : 'conflict';
  if (local.size === remote.size && sameTime(local.mtime, remote.mtime)) return 'same';
  if (local.mtime > remote.mtime + 2000) return 'localNewer';
  if (remote.mtime > local.mtime + 2000) return 'remoteNewer';
  return 'conflict';
};

export class SyncEngine {
  constructor(
    private readonly deployer: Deployer,
    private readonly cache: StateCache,
  ) {}

  /** Builds the comparison between local paths and their deployed counterparts. */
  async compare(client: RemoteClient, t: DeploymentTarget, localRoots: string[], opts: CompareOptions): Promise<SyncItem[]> {
    const { files: localFiles } = await this.deployer.collectLocal(t, localRoots);
    const byRemote = new Map<string, { localPath: string; local?: { size: number; mtime: number }; remote?: RemoteStat }>();

    for (const lp of localFiles) {
      const rp = t.mapper.toRemote(lp);
      if (!rp) continue;
      const st = await fs.stat(lp);
      byRemote.set(rp, { localPath: lp, local: { size: st.size, mtime: st.mtimeMs } });
    }

    const remoteRoots = [...new Set(localRoots.map((r) => t.mapper.toRemote(r)).filter((r): r is string => !!r))];
    for (const rr of remoteRoots) {
      const { files } = await this.deployer.collectRemote(client, t, rr);
      for (const f of files) {
        const existing = byRemote.get(f.path);
        if (existing) {
          existing.remote = f.stat;
          continue;
        }
        const lp = t.mapper.toLocal(f.path);
        if (!lp || t.mapper.isLocalExcluded(lp)) continue;
        byRemote.set(f.path, { localPath: lp, remote: f.stat });
      }
    }

    let id = 0;
    const items: SyncItem[] = [];
    for (const [remotePath, e] of byRemote) {
      const record = this.cache.get(t.server.id, remotePath);
      const state = classify(e.local, e.remote, record);
      const action = state === 'same' && t.options.overwriteUpToDate ? 'upload' : defaultAction(state);
      items.push({ id: id++, remotePath, localPath: e.localPath, local: e.local, remote: e.remote, state, action, wasSynced: !!record });
    }

    if (opts.compareContents) await this.refineByContent(client, t, items, opts);
    return items.sort((a, b) => a.remotePath.localeCompare(b.remotePath));
  }

  /** Files that differ only by metadata but have identical content are reclassified as "same". */
  private async refineByContent(client: RemoteClient, t: DeploymentTarget, items: SyncItem[], opts: CompareOptions): Promise<void> {
    const candidates = items.filter((i) => i.local && i.remote && i.state !== 'same' && i.local.size === i.remote.size);
    if (candidates.length === 0) return;
    const remoteHashes = new Map<string, string>();
    if (client.capabilities.exec && t.server.allowShellCommands) {
      for (let i = 0; i < candidates.length; i += 50) {
        const chunk = candidates.slice(i, i + 50);
        const res = await client.exec(`sha1sum -- ${chunk.map((c) => shellQuote(c.remotePath)).join(' ')}`).catch(() => undefined);
        if (!res || res.code !== 0) break;
        for (const line of res.stdout.split('\n')) {
          const m = /^\\?([0-9a-f]{40}) [ *](.+)$/.exec(line.trim());
          if (m) remoteHashes.set(m[2], m[1]);
        }
      }
    }
    for (const item of candidates) {
      let remoteHash = remoteHashes.get(item.remotePath);
      if (!remoteHash && item.remote!.size <= opts.maxDownloadCompareBytes) {
        remoteHash = sha1Buffer(await client.readFile(item.remotePath));
      }
      if (!remoteHash) continue;
      const localHash = await sha1File(item.localPath);
      if (localHash === remoteHash) {
        item.state = 'same';
        item.action = 'skip';
        this.cache.set(t.server.id, item.remotePath, {
          remoteMtime: item.remote!.mtime,
          remoteSize: item.remote!.size,
          localMtime: item.local!.mtime,
          localSize: item.local!.size,
          sha1: localHash,
        });
      }
    }
  }
}
