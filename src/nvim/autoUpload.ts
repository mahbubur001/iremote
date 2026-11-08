/**
 * PhpStorm's "Upload changed files automatically to the default server" for Neovim, mirroring the VS Code
 * AutoUploader: uploads on :write, new files, delete/rename propagation, and — when the mode is "Always" and "Skip
 * external changes" is off — a recursive watcher for changes made outside Neovim (git checkout, build tools).
 */
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import type { DeploymentTarget } from '../core/Deployer';
import { isRemoteError } from '../protocol/types';
import { log } from '../util/log';
import type { NvimProject, NvimServer } from './NvimConfig';
import { summary, type Context } from './context';
import type { Rpc } from './rpc';

const EDITOR_SAVE_WINDOW_MS = 3000;
const WATCH_DEBOUNCE_MS = 400;

export const registerAutoUpload = (rpc: Rpc, getCtx: () => Context): { rewatch(): void; dispose(): void } => {
  const watchers = new Map<string, FSWatcher>();
  const pending = new Map<string, NodeJS.Timeout>();

  /** Default-server target for a local path when automatic upload applies to its project. */
  const targetFor = async (path: string): Promise<{ project: NvimProject; server: NvimServer; target: DeploymentTarget } | undefined> => {
    const ctx = getCtx();
    const project = await ctx.config.projectFor(path);
    if (!project || project.config.options.autoUpload === 'never') return undefined;
    const server = ctx.config.defaultServer(project);
    if (!server) return undefined;
    return { project, server, target: ctx.config.target(server) };
  };

  const upload = async (target: DeploymentTarget, server: NvimServer, path: string) => {
    const ctx = getCtx();
    if (!target.mapper.isDeployable(path) || ctx.deployer.isOwnLocalWrite(path)) return null;
    try {
      const result = await ctx.deployer.uploadFile(target, path, target.options.warnOnNewerRemote !== 'none');
      if (result.transferred) log.info(`Automatic upload: ${basename(path)} → ${server.name}`);
      if (result.failed.length) log.error(`Automatic upload of ${path} to ${server.name} failed`, result.failed[0].error);
      return summary(server, result);
    } catch (e) {
      if (isRemoteError(e, 'Cancelled')) return null;
      throw e;
    }
  };

  const remoteIsDir = async (target: DeploymentTarget, remote: string) =>
    getCtx().deployer.withClient(target, async (c) => (await c.stat(remote))?.type === 'dir');

  const deleted = async (path: string, isDir: boolean | undefined, external: boolean) => {
    const hit = await targetFor(path);
    if (!hit || !hit.project.config.options.deleteRemoteOnLocalDelete) return false;
    if (external && hit.project.config.options.skipExternalChanges) return false;
    const { mapper } = hit.target;
    const remote = mapper.toRemote(path);
    if (!remote || mapper.isLocalExcluded(path)) return false;
    await getCtx().deployer.deleteRemote(hit.target, remote, isDir ?? (await remoteIsDir(hit.target, remote)));
    log.info(`Deleted ${remote} on ${hit.server.name}`);
    return true;
  };

  /** :write from Neovim. */
  rpc.on('fileSaved', async ({ path }: { path: string }) => {
    getCtx().editorSaves.set(path, Date.now());
    cancelPending(path);
    const hit = await targetFor(path);
    return hit ? upload(hit.target, hit.server, path) : null;
  });

  /** File created from Neovim (e.g. neo-tree "add"): uploaded in "Always" mode only, as in PhpStorm. */
  rpc.on('fileCreated', async ({ path }: { path: string }) => {
    getCtx().editorSaves.set(path, Date.now());
    const hit = await targetFor(path);
    if (!hit || hit.project.config.options.autoUpload !== 'always') return null;
    if (!(await fs.stat(path).then((s) => s.isFile(), () => false))) return null;
    return upload(hit.target, hit.server, path);
  });

  rpc.on('fileDeleted', async ({ path, isDir }: { path: string; isDir?: boolean }) => {
    getCtx().editorSaves.set(path, Date.now());
    return deleted(path, isDir, false);
  });

  rpc.on('fileRenamed', async ({ from, to }: { from: string; to: string }) => {
    const ctx = getCtx();
    ctx.editorSaves.set(from, Date.now());
    ctx.editorSaves.set(to, Date.now());
    const hit = (await targetFor(to)) ?? (await targetFor(from));
    if (!hit) return null;
    const { mapper } = hit.target;
    const remoteFrom = mapper.isLocalExcluded(from) ? undefined : mapper.toRemote(from);
    const remoteTo = mapper.isLocalExcluded(to) ? undefined : mapper.toRemote(to);
    if (remoteFrom && remoteTo) {
      await ctx.deployer.renameRemote(hit.target, remoteFrom, remoteTo);
      log.info(`Renamed ${remoteFrom} → ${remoteTo} on ${hit.server.name}`);
      return true;
    }
    if (remoteTo) {
      const isFile = await fs.stat(to).then((s) => s.isFile(), () => false);
      if (isFile) await upload(hit.target, hit.server, to);
      else await ctx.deployer.upload(hit.target, [to], hit.target.options.warnOnNewerRemote !== 'none');
      return true;
    }
    if (remoteFrom && hit.project.config.options.deleteRemoteOnLocalDelete) {
      const isDir = await fs.stat(to).then((s) => s.isDirectory(), () => false);
      await ctx.deployer.deleteRemote(hit.target, remoteFrom, isDir);
      return true;
    }
    return null;
  });

  const cancelPending = (path: string) => {
    const t = pending.get(path);
    if (t) clearTimeout(t);
    pending.delete(path);
  };

  const onExternal = (path: string) => {
    const ctx = getCtx();
    const saved = ctx.editorSaves.get(path);
    if (saved && Date.now() - saved < EDITOR_SAVE_WINDOW_MS) return;
    if (ctx.deployer.isOwnLocalWrite(path)) return;
    cancelPending(path);
    pending.set(
      path,
      setTimeout(() => {
        pending.delete(path);
        void (async () => {
          const hit = await targetFor(path);
          if (!hit || !hit.target.mapper.toRemote(path) || hit.target.mapper.isLocalExcluded(path)) return;
          const st = await fs.stat(path).catch(() => undefined);
          try {
            if (st?.isFile()) await upload(hit.target, hit.server, path);
            else if (!st) await deleted(path, undefined, true);
          } catch (e) {
            if (!isRemoteError(e, 'Cancelled')) log.error(`Automatic upload of external change ${path} failed`, e);
          }
        })();
      }, WATCH_DEBOUNCE_MS),
    );
  };

  /** (Re)creates watchers for projects in "Always" mode with "Skip external changes" off. */
  const rewatch = () => {
    const ctx = getCtx();
    const wanted = new Set<string>();
    for (const project of ctx.config.loadedProjects) {
      const o = project.config.options;
      if (o.autoUpload !== 'always' || o.skipExternalChanges || !ctx.config.defaultServer(project)) continue;
      wanted.add(project.root);
      if (watchers.has(project.root)) continue;
      try {
        const w = watch(project.root, { recursive: true }, (_event, name) => {
          if (!name) return;
          const rel = String(name);
          if (rel.split(/[\\/]/).includes('.git')) return;
          onExternal(join(project.root, rel));
        });
        watchers.set(project.root, w);
        log.info(`Watching ${project.root} for external changes`);
      } catch (e) {
        log.error(`Cannot watch ${project.root} for external changes`, e);
      }
    }
    for (const [root, w] of watchers) {
      if (wanted.has(root)) continue;
      w.close();
      watchers.delete(root);
    }
  };

  return {
    rewatch,
    dispose: () => {
      pending.forEach((t) => clearTimeout(t));
      watchers.forEach((w) => w.close());
    },
  };
};
