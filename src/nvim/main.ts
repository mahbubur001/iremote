/**
 * iRemote server for Neovim: runs the same protocol/core layers as the VS Code extension and is driven by the Lua
 * plugin over stdio (see ./rpc.ts). Only VS-Code-free modules may be imported here; the build fails otherwise.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ServerManager } from '../core/ServerManager';
import { TransferQueue } from '../core/TransferQueue';
import { StateCache } from '../core/StateCache';
import { Deployer, type ConflictDecision, type ConflictInfo } from '../core/Deployer';
import { SyncEngine } from '../core/SyncEngine';
import type { AutoUploadMode } from '../config/schema';
import { RemoteError } from '../protocol/types';
import { log, type LogLevel } from '../util/log';
import { detectKeychain } from './keychain';
import { NvimConfig, defaultGlobalServersFile, type NvimServer } from './NvimConfig';
import { NvimCredentials, confirm } from './NvimCredentials';
import { Rpc } from './rpc';
import { fetchToTemp, projectFor, remotePathFor, resolveTarget, summary, type Context } from './context';
import { registerRemote } from './remote';
import { registerSync } from './sync';
import { registerAutoUpload } from './autoUpload';
import { registerImport } from './import';
import { registerSettings } from './settings';

// stdout is the protocol channel: anything a dependency prints must not corrupt it.
// eslint-disable-next-line no-console
console.log = console.info = console.warn = console.debug = (...args: unknown[]) => process.stderr.write(`${args.map(String).join(' ')}\n`);

interface InitParams {
  stateDir: string;
  globalServersFile?: string;
  knownHostsFiles?: string[];
  logLevel?: LogLevel;
  timeoutSeconds?: number;
  idleCloseSeconds?: number;
}

const rpc = new Rpc(process.stdin, process.stdout);

let ctx: Context | undefined;

const ready = (): Context => {
  if (!ctx) throw new Error('iRemote server is not initialized.');
  return ctx;
};

/** Conflict prompts are shown one at a time even when several uploads run in parallel (as in VS Code). */
const createConflictPrompt = (queue: TransferQueue) => {
  let chain: Promise<unknown> = Promise.resolve();
  const ask = async (info: ConflictInfo): Promise<ConflictDecision> => {
    const name = basename(info.localPath);
    for (;;) {
      const modified = info.remote.mtime ? new Date(info.remote.mtime).toLocaleString() : 'unknown';
      const choice = await confirm(
        rpc,
        `"${name}" on ${info.target.server.name} has changed.`,
        `${info.reason}\nRemote: ${info.remotePath}\nModified: ${modified}, ${info.remote.size} bytes\nUploading will overwrite the remote version.`,
        ['Overwrite', 'Compare', 'Skip'],
      );
      if (choice === 'Compare') {
        const { tmpPath } = await fetchToTemp(ready(), info.target, info.remotePath);
        await rpc.request('diff', { local: info.localPath, remote: tmpPath, title: `${name} (${info.target.server.name} ↔ Local)` });
        continue;
      }
      if (choice === 'Overwrite') return 'overwrite';
      if (choice === 'Skip') return 'skip';
      void queue.cancel(info.target.server.id);
      throw new RemoteError('Cancelled', 'Upload cancelled.');
    }
  };
  return (info: ConflictInfo): Promise<ConflictDecision> => {
    const next = chain.then(() => ask(info));
    chain = next.catch(() => undefined);
    return next;
  };
};

registerRemote(rpc, ready);
registerSync(rpc, ready);
registerImport(rpc, ready);
registerSettings(rpc, ready);
const autoUpload = registerAutoUpload(rpc, ready);

rpc.on('initialize', async (p: InitParams) => {
  const level = p.logLevel ?? 'brief';
  log.attach({
    error: (message) => rpc.notify('log', { level: 'error', message }),
    info: (message) => rpc.notify('log', { level: 'info', message }),
    debug: (message) => rpc.notify('log', { level: 'debug', message }),
    level: () => level,
  });
  const config = new NvimConfig(p.globalServersFile ?? defaultGlobalServersFile());
  await config.loadGlobal();
  const keychain = await detectKeychain();
  const credentials = new NvimCredentials(rpc, keychain, join(p.stateDir, 'known_hosts.json'), () => p.knownHostsFiles ?? []);
  const servers = new ServerManager(config, credentials, () => ({
    timeoutMs: (p.timeoutSeconds ?? 20) * 1000,
    idleCloseMs: (p.idleCloseSeconds ?? 300) * 1000,
  }));
  const queue = new TransferQueue(
    (id) => servers.poolById(id),
    (id) => (config.findServer(id) as NvimServer | undefined)?.project.config.options.concurrency ?? 4,
  );
  // Progress updates are throttled by the queue (≤ 5/s per task); the plugin's File Transfer view shows them live.
  queue.on('changed', (t) => {
    rpc.notify('transfer', {
      id: t.id,
      kind: t.kind,
      server: t.serverName,
      source: t.source,
      target: t.target,
      status: t.status,
      error: t.error,
      bytes: t.bytes,
      total: t.total,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      pending: queue.pendingCount,
    });
  });
  queue.on('idle', () => rpc.notify('idle', {}));
  const cache = new StateCache(join(p.stateDir, 'sync-state.json'));
  await cache.load();
  const deployer = new Deployer(queue, cache, { onConflict: createConflictPrompt(queue), log: (m) => log.info(m) }, (id) => servers.poolById(id));
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'iremote-nvim-'));
  ctx = { rpc, config, credentials, servers, queue, cache, deployer, sync: new SyncEngine(deployer, cache), tmpRoot, editorSaves: new Map() };
  config.onDidChange(() => {
    autoUpload.rewatch();
    rpc.notify('configChanged', {});
  });
  return { keychain: keychain.persistent, problems: config.problems };
});

rpc.on('status', async ({ path }: { path: string }) => {
  const { config } = ready();
  const project = await config.projectFor(path);
  if (!project) return { project: null };
  const server = config.defaultServer(project);
  const mapped = server ? config.target(server).mapper.isDeployable(path) : false;
  return {
    project: project.root,
    server: server ? { id: server.id, name: server.name, type: server.type } : null,
    autoUpload: project.config.options.autoUpload,
    mapped,
    problems: project.errors,
  };
});

rpc.on('servers', async ({ path }: { path: string }) => {
  const c = ready();
  const project = await projectFor(c, path);
  return {
    project: project.root,
    defaultServer: project.config.defaultServer ?? null,
    servers: c.config.servers(project).map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      host: s.type === 'local' ? s.rootPath : s.host,
      scope: s.scope,
      connected: c.servers.isConnected(s.id),
    })),
  };
});

rpc.on('setDefaultServer', async ({ path, serverId }: { path: string; serverId: string | null }) => {
  const c = ready();
  const project = await projectFor(c, path);
  if (serverId && !c.config.findServer(serverId, project)) throw new Error(`Unknown server "${serverId}".`);
  await c.config.setDefaultServer(project, serverId ?? undefined);
  return true;
});

rpc.on('setAutoUpload', async ({ path, mode }: { path: string; mode: AutoUploadMode }) => {
  if (!['always', 'onExplicitSave', 'never'].includes(mode)) throw new Error(`Invalid mode "${mode}".`);
  await ready().config.setAutoUpload(await projectFor(ready(), path), mode);
  return true;
});

rpc.on('upload', async ({ paths, serverId }: { paths: string[]; serverId?: string }) => {
  const c = ready();
  const { server, target } = await resolveTarget(c, paths[0], serverId);
  paths.forEach((p) => remotePathFor(target, p));
  const checkConflict = target.options.warnOnNewerRemote !== 'none';
  const single = paths.length === 1 && (await fs.stat(paths[0]).then((s) => s.isFile(), () => false));
  const result = single ? await c.deployer.uploadFile(target, paths[0], checkConflict) : await c.deployer.upload(target, paths, checkConflict);
  return summary(server, result);
});

rpc.on('download', async ({ paths, serverId }: { paths: string[]; serverId?: string }) => {
  const c = ready();
  const { server, target } = await resolveTarget(c, paths[0], serverId);
  const result = await c.deployer.download(target, paths.map((p) => remotePathFor(target, p)));
  return summary(server, result);
});

rpc.on('fetchRemote', async ({ path, serverId }: { path: string; serverId?: string }) => {
  const c = ready();
  const { server, target } = await resolveTarget(c, path, serverId);
  const remotePath = remotePathFor(target, path);
  const { tmpPath, exists } = await fetchToTemp(c, target, remotePath);
  return { tmpPath, remotePath, exists, server: server.name };
});

rpc.on('webUrl', async ({ path, serverId }: { path: string; serverId?: string }) => {
  const { target } = await resolveTarget(ready(), path, serverId);
  return target.mapper.webUrlForLocal(path) ?? null;
});

rpc.on('reload', async () => {
  await ready().config.reload();
  return ready().config.problems;
});

rpc.on('cancel', async ({ serverId }: { serverId?: string }) => {
  await ready().queue.cancel(serverId);
  return true;
});

rpc.on('disconnect', async ({ serverId }: { serverId?: string }) => {
  await ready().servers.disconnect(serverId);
  return true;
});

rpc.on('forgetCredentials', async ({ path, serverId }: { path: string; serverId?: string }) => {
  const c = ready();
  const { server } = await resolveTarget(c, path, serverId);
  await c.credentials.forget(server.id);
  if (server.type === 'sftp') await c.credentials.forgetHostKeys(server.host, server.port ?? 22);
  return server.name;
});

const shutdown = async () => {
  autoUpload.dispose();
  if (ctx) {
    await ctx.cache.flush().catch(() => undefined);
    ctx.servers.dispose();
    ctx.config.dispose();
    await fs.rm(ctx.tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  process.exit(0);
};

rpc.on('shutdown', () => {
  setImmediate(() => void shutdown());
  return true;
});

rpc.start(() => void shutdown());
