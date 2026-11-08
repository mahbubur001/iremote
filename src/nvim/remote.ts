/**
 * Remote Host for Neovim (phase 2): browse a server, open remote files for editing (saved back on :write with a
 * "changed on the server" check), new file/folder, rename/move, delete, chmod, download and upload into a folder.
 */
import { promises as fs } from 'node:fs';
import { basename, posix } from 'node:path';
import { PathMapper } from '../core/PathMapper';
import type { DeploymentTarget } from '../core/Deployer';
import { log } from '../util/log';
import { confirm } from './NvimCredentials';
import type { NvimServer } from './NvimConfig';
import { fetchToTemp, projectFor, summary, tempPathFor, type Context } from './context';
import type { Rpc } from './rpc';

/** Remote files opened for editing: temp path → what was read, to detect changes on the server before saving. */
interface OpenRemote {
  serverId: string;
  remotePath: string;
  mtime: number;
  size: number;
}

/** Target for files outside the server's mappings (uploading into an arbitrary remote folder). */
const adHocTarget = (base: DeploymentTarget, pairs: { local: string; remote: string }[]): DeploymentTarget => {
  const server = { ...base.server, rootPath: '/', mappings: pairs.map((p) => ({ local: p.local, remote: p.remote, web: '/' })), excludedLocal: [], excludedRemote: [] };
  return { ...base, server, mapper: new PathMapper(base.projectRoot, server, base.options.excludeNames) };
};

export const registerRemote = (rpc: Rpc, getCtx: () => Context): void => {
  const open = new Map<string, OpenRemote>();

  const serverTarget = async (path: string, serverId: string): Promise<{ server: NvimServer; target: DeploymentTarget }> => {
    const ctx = getCtx();
    const project = await projectFor(ctx, path);
    const server = ctx.config.findServer(serverId, project);
    if (!server) throw new Error(`Unknown server "${serverId}".`);
    return { server, target: ctx.config.target(server) };
  };

  rpc.on('remoteRoot', async ({ path, serverId }: { path: string; serverId?: string }) => {
    const ctx = getCtx();
    const project = await projectFor(ctx, path);
    const server = serverId ? ctx.config.findServer(serverId, project) : ctx.config.defaultServer(project) ?? ctx.config.servers(project)[0];
    if (!server) throw new Error('No servers configured for this project.');
    return {
      serverId: server.id,
      name: server.name,
      type: server.type,
      host: server.type === 'local' ? server.rootPath : server.host,
      root: posix.normalize(server.rootPath || '/'),
      isDefault: project.config.defaultServer === server.id,
      openBehavior: 'localIfMapped',
    };
  });

  rpc.on('remoteList', async ({ path, serverId, remotePath }: { path: string; serverId: string; remotePath: string }) => {
    const { target } = await serverTarget(path, serverId);
    const entries = await getCtx().deployer.withClient(target, (c) => c.list(remotePath));
    return entries
      .filter((e) => e.name !== '.' && e.name !== '..')
      .map((e) => {
        const full = posix.join(remotePath, e.name);
        const dir = e.type === 'dir' || (e.type === 'symlink' && e.targetType === 'dir');
        return {
          name: e.name,
          path: full,
          type: dir ? 'directory' : 'file',
          size: e.size,
          mtime: e.mtime,
          mode: e.mode ?? null,
          link: e.type === 'symlink',
          excluded: target.mapper.isRemoteExcluded(full),
          local: target.mapper.toLocal(full) ?? null,
        };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  });

  /** Opens a remote file: the mapped local copy when asked and present, else a temp copy edited in place. */
  rpc.on('remoteOpen', async ({ path, serverId, remotePath, preferLocal }: { path: string; serverId: string; remotePath: string; preferLocal?: boolean }) => {
    const ctx = getCtx();
    const { target } = await serverTarget(path, serverId);
    const local = target.mapper.toLocal(remotePath);
    if (preferLocal && local && (await fs.stat(local).then((s) => s.isFile(), () => false))) return { path: local, remote: false };
    const fetched = await fetchToTemp(ctx, target, remotePath);
    open.set(fetched.tmpPath, { serverId, remotePath, mtime: fetched.mtime, size: fetched.size });
    return { path: fetched.tmpPath, remote: true, remotePath, server: target.server.name };
  });

  /** :write on a remote buffer: refuses to silently overwrite a file that changed on the server meanwhile. */
  rpc.on('remoteSave', async ({ path, tmpPath }: { path: string; tmpPath: string }) => {
    const ctx = getCtx();
    const entry = open.get(tmpPath);
    if (!entry) throw new Error('This buffer is not a remote file opened by iRemote.');
    const { server, target } = await serverTarget(path, entry.serverId);
    const data = await fs.readFile(tmpPath);
    return ctx.deployer.withClient(target, async (c) => {
      const st = await c.stat(entry.remotePath);
      const changed = st && (st.size !== entry.size || (st.mtime > 0 && entry.mtime > 0 && Math.abs(st.mtime - entry.mtime) >= 2000));
      if (changed) {
        const choice = await confirm(
          ctx.rpc,
          `${basename(entry.remotePath)} changed on ${server.name} since it was opened.`,
          `Remote: ${entry.remotePath}\nSaving will overwrite the server version.`,
          ['Overwrite', 'Cancel'],
        );
        if (choice !== 'Overwrite') return { saved: false };
      }
      await c.writeFile(entry.remotePath, data);
      const after = await c.stat(entry.remotePath);
      entry.mtime = after?.mtime ?? Date.now();
      entry.size = after?.size ?? data.length;
      log.info(`Saved ${entry.remotePath} on ${server.name}`);
      return { saved: true, server: server.name };
    });
  });

  /** Remote change monitor: which open remote buffers changed on the server (checked on FocusGained). */
  rpc.on('remoteCheck', async ({ path, tmpPaths }: { path: string; tmpPaths: string[] }) => {
    const ctx = getCtx();
    const changed: string[] = [];
    for (const tmp of tmpPaths) {
      const entry = open.get(tmp);
      if (!entry) continue;
      try {
        const { target } = await serverTarget(path, entry.serverId);
        const st = await ctx.deployer.withClient(target, (c) => c.stat(entry.remotePath));
        if (st && (st.size !== entry.size || (st.mtime > 0 && entry.mtime > 0 && Math.abs(st.mtime - entry.mtime) >= 2000))) changed.push(tmp);
      } catch {
        // Offline / server gone: nothing to report.
      }
    }
    return changed;
  });

  /** Reloads a remote buffer's temp copy from the server. */
  rpc.on('remoteReload', async ({ path, tmpPath }: { path: string; tmpPath: string }) => {
    const entry = open.get(tmpPath);
    if (!entry) throw new Error('Not a remote buffer.');
    const { target } = await serverTarget(path, entry.serverId);
    const fetched = await fetchToTemp(getCtx(), target, entry.remotePath);
    entry.mtime = fetched.mtime;
    entry.size = fetched.size;
    return true;
  });

  rpc.on('remoteMkdir', async ({ path, serverId, remotePath }: { path: string; serverId: string; remotePath: string }) => {
    const { target } = await serverTarget(path, serverId);
    await getCtx().deployer.mkdir(target, remotePath);
    return true;
  });

  rpc.on('remoteNewFile', async ({ path, serverId, remotePath }: { path: string; serverId: string; remotePath: string }) => {
    const { target } = await serverTarget(path, serverId);
    await getCtx().deployer.withClient(target, async (c) => {
      if (await c.stat(remotePath)) throw new Error(`${remotePath} already exists.`);
      await c.mkdirp(posix.dirname(remotePath));
      await c.writeFile(remotePath, Buffer.alloc(0));
    });
    return true;
  });

  rpc.on('remoteRename', async ({ path, serverId, from, to }: { path: string; serverId: string; from: string; to: string }) => {
    const { target } = await serverTarget(path, serverId);
    await getCtx().deployer.renameRemote(target, from, to);
    return true;
  });

  rpc.on('remoteDelete', async ({ path, serverId, remotePaths }: { path: string; serverId: string; remotePaths: { path: string; isDir: boolean }[] }) => {
    const { target } = await serverTarget(path, serverId);
    for (const r of remotePaths) await getCtx().deployer.deleteRemote(target, r.path, r.isDir);
    return true;
  });

  rpc.on('remoteChmod', async ({ path, serverId, remotePaths, mode, recursive }: { path: string; serverId: string; remotePaths: string[]; mode: string; recursive?: boolean }) => {
    if (!/^[0-7]{3,4}$/.test(mode)) throw new Error(`Invalid permissions "${mode}". Use octal, e.g. 644.`);
    const ctx = getCtx();
    const { target } = await serverTarget(path, serverId);
    const m = parseInt(mode, 8);
    for (const rp of remotePaths) {
      await ctx.deployer.chmod(target, rp, m);
      if (recursive) {
        const all = await ctx.deployer.withClient(target, (c) => ctx.deployer.collectRemote(c, target, rp));
        for (const p of [...all.dirs.filter((d) => d !== rp), ...all.files.map((f) => f.path)]) await ctx.deployer.chmod(target, p, m);
      }
    }
    return true;
  });

  /** Downloads remote entries to their mapped local paths (files or folders). */
  rpc.on('remoteDownload', async ({ path, serverId, remotePaths }: { path: string; serverId: string; remotePaths: string[] }) => {
    const { server, target } = await serverTarget(path, serverId);
    const unmapped = remotePaths.filter((r) => !target.mapper.toLocal(r));
    if (unmapped.length) throw new Error(`${unmapped[0]} is not inside a mapping of ${server.name}; there is no local path to download to.`);
    return summary(server, await getCtx().deployer.download(target, remotePaths));
  });

  /** Uploads local files or folders into a remote folder, regardless of mappings (Remote Host: Upload Here). */
  rpc.on('remoteUploadHere', async ({ path, serverId, localPaths, remoteDir }: { path: string; serverId: string; localPaths: string[]; remoteDir: string }) => {
    const { server, target: base } = await serverTarget(path, serverId);
    const pairs = localPaths.map((l) => ({ local: l, remote: posix.join(remoteDir, basename(l)) }));
    const target = adHocTarget(base, pairs);
    return summary(server, await getCtx().deployer.upload(target, localPaths, base.options.warnOnNewerRemote !== 'none'));
  });

  rpc.on('remoteWebUrl', async ({ path, serverId, remotePath }: { path: string; serverId: string; remotePath: string }) => {
    const { target } = await serverTarget(path, serverId);
    return target.mapper.webUrlForRemote(remotePath) ?? null;
  });

  rpc.on('remoteTempPath', ({ serverId, remotePath }: { serverId: string; remotePath: string }) => tempPathFor(getCtx(), serverId, remotePath));
};
