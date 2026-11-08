import { promises as fs } from 'node:fs';
import { join, posix } from 'node:path';
import type { ServerManager } from '../core/ServerManager';
import type { TransferQueue } from '../core/TransferQueue';
import type { StateCache } from '../core/StateCache';
import type { Deployer, DeploymentTarget, TransferResult } from '../core/Deployer';
import type { SyncEngine } from '../core/SyncEngine';
import { errorMessage } from '../protocol/types';
import type { NvimConfig, NvimProject, NvimServer } from './NvimConfig';
import type { NvimCredentials } from './NvimCredentials';
import type { Rpc } from './rpc';

/** Everything the RPC handlers share once `initialize` ran. */
export interface Context {
  rpc: Rpc;
  config: NvimConfig;
  credentials: NvimCredentials;
  servers: ServerManager;
  queue: TransferQueue;
  cache: StateCache;
  deployer: Deployer;
  sync: SyncEngine;
  tmpRoot: string;
  /** Local paths saved from Neovim, with the time; the external-change watcher ignores them for a short while. */
  editorSaves: Map<string, number>;
}

export interface Summary {
  server: string;
  transferred: number;
  skipped: number;
  failed: { path: string; error: string }[];
}

export const summary = (server: NvimServer, r: TransferResult): Summary => ({
  server: server.name,
  transferred: r.transferred,
  skipped: r.skipped,
  failed: r.failed.map((f) => ({ path: f.path, error: errorMessage(f.error) })),
});

export const projectFor = async (ctx: Context, path: string): Promise<NvimProject> => {
  const project = await ctx.config.projectFor(path);
  if (!project) throw new Error(`No .vscode/iremote.json found above ${path}.`);
  return project;
};

/** The server to use for `path`: an explicit id, else the project's default server. */
export const resolveTarget = async (
  ctx: Context,
  path: string,
  serverId?: string,
): Promise<{ project: NvimProject; server: NvimServer; target: DeploymentTarget }> => {
  const project = await projectFor(ctx, path);
  const server = serverId ? ctx.config.findServer(serverId, project) : ctx.config.defaultServer(project);
  if (!server) throw new Error(serverId ? `Unknown server "${serverId}".` : 'No default server. Run :IRemote server to pick one.');
  return { project, server, target: ctx.config.target(server) };
};

export const remotePathFor = (target: DeploymentTarget, localPath: string): string => {
  const remote = target.mapper.toRemote(localPath);
  if (!remote) throw new Error(`${localPath} is not inside a mapping of ${target.server.name}.`);
  if (target.mapper.isLocalExcluded(localPath)) throw new Error(`${localPath} is excluded from deployment to ${target.server.name}.`);
  return remote;
};

/** Temp file named like the remote file (keeps filetype detection working). */
export const tempPathFor = (ctx: Context, serverId: string, remotePath: string): string =>
  join(ctx.tmpRoot, serverId, ...remotePath.split(posix.sep).filter(Boolean));

/** Downloads a remote file into its temp location; a missing file yields an empty temp file. */
export const fetchToTemp = async (
  ctx: Context,
  target: DeploymentTarget,
  remotePath: string,
): Promise<{ tmpPath: string; exists: boolean; mtime: number; size: number }> => {
  const tmpPath = tempPathFor(ctx, target.server.id, remotePath);
  await fs.mkdir(join(tmpPath, '..'), { recursive: true });
  const got = await ctx.deployer.withClient(target, async (c) => {
    const st = await c.stat(remotePath);
    return st ? { data: await c.readFile(remotePath), mtime: st.mtime, size: st.size } : undefined;
  });
  await fs.writeFile(tmpPath, got?.data ?? '');
  return { tmpPath, exists: !!got, mtime: got?.mtime ?? 0, size: got?.size ?? 0 };
};
