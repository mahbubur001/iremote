/** Sync with Deployed (phase 3): compare a local folder with the server and apply per-file actions. */
import { relative } from 'node:path';
import type { DeploymentTarget } from '../core/Deployer';
import type { SyncAction, SyncItem } from '../core/SyncEngine';
import { errorMessage, isRemoteError } from '../protocol/types';
import { log } from '../util/log';
import { confirm } from './NvimCredentials';
import type { NvimServer } from './NvimConfig';
import { resolveTarget, type Context } from './context';
import { moveToTrash } from './trash';
import type { Rpc } from './rpc';

const MAX_DOWNLOAD_COMPARE = 2 * 1024 * 1024;
const ACTIONS: SyncAction[] = ['upload', 'download', 'deleteRemote', 'deleteLocal', 'skip'];

interface Session {
  server: NvimServer;
  target: DeploymentTarget;
  items: SyncItem[];
}

export const registerSync = (rpc: Rpc, getCtx: () => Context): void => {
  const sessions = new Map<number, Session>();
  let nextToken = 1;

  rpc.on('syncCompare', async ({ paths, serverId, compareContents }: { paths: string[]; serverId?: string; compareContents?: boolean }) => {
    const ctx = getCtx();
    const { server, target, project } = await resolveTarget(ctx, paths[0], serverId);
    const items = await ctx.deployer.withClient(target, (c) =>
      ctx.sync.compare(c, target, paths, { compareContents: !!compareContents, maxDownloadCompareBytes: MAX_DOWNLOAD_COMPARE }),
    );
    const token = nextToken++;
    sessions.set(token, { server, target, items });
    return {
      token,
      server: server.name,
      serverId: server.id,
      root: project.root,
      items: items.map((i) => ({
        id: i.id,
        state: i.state,
        action: i.action,
        localPath: i.localPath,
        remotePath: i.remotePath,
        rel: relative(project.root, i.localPath),
        local: i.local ?? null,
        remote: i.remote ? { size: i.remote.size, mtime: i.remote.mtime } : null,
        wasSynced: i.wasSynced,
      })),
    };
  });

  rpc.on('syncRun', async ({ token, actions }: { token: number; actions: { id: number; action: SyncAction }[] }) => {
    const ctx = getCtx();
    const session = sessions.get(token);
    if (!session) throw new Error('This comparison has expired; compare again.');
    const { server, target } = session;
    const work = actions
      .filter((a) => ACTIONS.includes(a.action) && a.action !== 'skip')
      .map((a) => ({ item: session.items.find((i) => i.id === a.id), action: a.action }))
      .filter((w): w is { item: SyncItem; action: SyncAction } => !!w.item);
    if (work.length === 0) return [];

    const deletesRemote = work.filter((w) => w.action === 'deleteRemote').length;
    const deletesLocal = work.filter((w) => w.action === 'deleteLocal').length;
    if (deletesRemote || deletesLocal) {
      const parts = [deletesRemote ? `${deletesRemote} file(s) on ${server.name}` : '', deletesLocal ? `${deletesLocal} local file(s) (moved to trash)` : '']
        .filter(Boolean)
        .join(' and ');
      if ((await confirm(rpc, `Synchronization will delete ${parts}.`, '', ['Synchronize', 'Cancel'])) !== 'Synchronize') return null;
    }

    const results: { id: number; status: 'done' | 'failed'; error?: string }[] = [];
    await Promise.all(
      work.map(async ({ item, action }) => {
        try {
          switch (action) {
            case 'upload': {
              const r = await ctx.deployer.uploadFile(target, item.localPath, false);
              if (r.failed.length) throw r.failed[0].error;
              break;
            }
            case 'download': {
              const r = await ctx.deployer.downloadFile(target, item.remotePath, item.localPath);
              if (r.failed.length) throw r.failed[0].error;
              break;
            }
            case 'deleteRemote':
              await ctx.deployer.deleteRemote(target, item.remotePath, false);
              break;
            case 'deleteLocal':
              await moveToTrash(item.localPath);
              ctx.cache.delete(server.id, item.remotePath);
              break;
            case 'skip':
              break;
          }
          results.push({ id: item.id, status: 'done' });
        } catch (e) {
          log.error(`Sync ${action} ${item.remotePath}`, e);
          results.push({ id: item.id, status: 'failed', error: errorMessage(e) });
          if (isRemoteError(e, 'Cancelled')) throw e;
        }
      }),
    );
    return results;
  });

  rpc.on('syncClose', ({ token }: { token: number }) => sessions.delete(token));
};
