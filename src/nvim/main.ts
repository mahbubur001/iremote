/**
 * iRemote server for Neovim: runs the same protocol/core layers as the VS Code extension and is driven by the Lua
 * plugin over stdio (see ./rpc.ts). Only VS-Code-free modules may be imported here; the build fails otherwise.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, posix } from 'node:path';
import { ServerManager } from '../core/ServerManager';
import { TransferQueue } from '../core/TransferQueue';
import { StateCache } from '../core/StateCache';
import { Deployer, type ConflictDecision, type ConflictInfo, type DeploymentTarget, type TransferResult } from '../core/Deployer';
import type { AutoUploadMode } from '../config/schema';
import { RemoteError, errorMessage, isRemoteError } from '../protocol/types';
import { log, type LogLevel } from '../util/log';
import { detectKeychain } from './keychain';
import { NvimConfig, defaultGlobalServersFile, type NvimProject, type NvimServer } from './NvimConfig';
import { NvimCredentials, confirm } from './NvimCredentials';
import { Rpc } from './rpc';

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

interface Summary {
  server: string;
  transferred: number;
  skipped: number;
  failed: { path: string; error: string }[];
}

const summary = (server: NvimServer, r: TransferResult): Summary => ({
  server: server.name,
  transferred: r.transferred,
  skipped: r.skipped,
  failed: r.failed.map((f) => ({ path: f.path, error: errorMessage(f.error) })),
});

const rpc = new Rpc(process.stdin, process.stdout);

let state:
  | {
      config: NvimConfig;
      credentials: NvimCredentials;
      servers: ServerManager;
      queue: TransferQueue;
      cache: StateCache;
      deployer: Deployer;
      tmpRoot: string;
    }
  | undefined;

const ready = () => {
  if (!state) throw new Error('iRemote server is not initialized.');
  return state;
};

const projectFor = async (path: string): Promise<NvimProject> => {
  const project = await ready().config.projectFor(path);
  if (!project) throw new Error(`No .vscode/iremote.json found above ${path}.`);
  return project;
};

/** The server to use for `path`: an explicit id, else the project's default server. */
const resolveTarget = async (path: string, serverId?: string): Promise<{ project: NvimProject; server: NvimServer; target: DeploymentTarget }> => {
  const { config } = ready();
  const project = await projectFor(path);
  const server = serverId ? config.findServer(serverId, project) : config.defaultServer(project);
  if (!server) throw new Error(serverId ? `Unknown server "${serverId}".` : 'No default server. Run :IRemote server to pick one.');
  return { project, server, target: config.target(server) };
};

const remotePathFor = (target: DeploymentTarget, localPath: string): string => {
  const remote = target.mapper.toRemote(localPath);
  if (!remote) throw new Error(`${localPath} is not inside a mapping of ${target.server.name}.`);
  if (target.mapper.isLocalExcluded(localPath)) throw new Error(`${localPath} is excluded from deployment to ${target.server.name}.`);
  return remote;
};

/** Downloads a remote file into a temp location named like the original (keeps filetype detection working). */
const fetchToTemp = async (target: DeploymentTarget, remotePath: string): Promise<{ tmpPath: string; exists: boolean }> => {
  const { deployer, tmpRoot } = ready();
  const tmpPath = join(tmpRoot, target.server.id, ...remotePath.split(posix.sep).filter(Boolean));
  await fs.mkdir(join(tmpPath, '..'), { recursive: true });
  const data = await deployer.withClient(target, async (c) => ((await c.stat(remotePath)) ? c.readFile(remotePath) : undefined));
  await fs.writeFile(tmpPath, data ?? '');
  return { tmpPath, exists: data !== undefined };
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
        const { tmpPath } = await fetchToTemp(info.target, info.remotePath);
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
  queue.on('changed', (t) => {
    if (t.status === 'queued') return;
    rpc.notify('transfer', { kind: t.kind, server: t.serverName, source: t.source, target: t.target, status: t.status, error: t.error, pending: queue.pendingCount });
  });
  queue.on('idle', () => rpc.notify('idle', {}));
  const cache = new StateCache(join(p.stateDir, 'sync-state.json'));
  await cache.load();
  const deployer = new Deployer(queue, cache, { onConflict: createConflictPrompt(queue), log: (m) => log.info(m) }, (id) => servers.poolById(id));
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'iremote-nvim-'));
  state = { config, credentials, servers, queue, cache, deployer, tmpRoot };
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
  const { config, servers } = ready();
  const project = await projectFor(path);
  return {
    project: project.root,
    defaultServer: project.config.defaultServer ?? null,
    servers: config.servers(project).map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      host: s.host,
      scope: s.scope,
      connected: servers.isConnected(s.id),
    })),
  };
});

rpc.on('setDefaultServer', async ({ path, serverId }: { path: string; serverId: string | null }) => {
  const { config } = ready();
  const project = await projectFor(path);
  if (serverId && !config.findServer(serverId, project)) throw new Error(`Unknown server "${serverId}".`);
  await config.setDefaultServer(project, serverId ?? undefined);
  return true;
});

rpc.on('setAutoUpload', async ({ path, mode }: { path: string; mode: AutoUploadMode }) => {
  if (!['always', 'onExplicitSave', 'never'].includes(mode)) throw new Error(`Invalid mode "${mode}".`);
  await ready().config.setAutoUpload(await projectFor(path), mode);
  return true;
});

rpc.on('upload', async ({ paths, serverId }: { paths: string[]; serverId?: string }) => {
  const { deployer } = ready();
  const { server, target } = await resolveTarget(paths[0], serverId);
  paths.forEach((p) => remotePathFor(target, p));
  const checkConflict = target.options.warnOnNewerRemote !== 'none';
  const single = paths.length === 1 && (await fs.stat(paths[0]).then((s) => s.isFile(), () => false));
  const result = single ? await deployer.uploadFile(target, paths[0], checkConflict) : await deployer.upload(target, paths, checkConflict);
  return summary(server, result);
});

rpc.on('download', async ({ paths, serverId }: { paths: string[]; serverId?: string }) => {
  const { deployer } = ready();
  const { server, target } = await resolveTarget(paths[0], serverId);
  const result = await deployer.download(target, paths.map((p) => remotePathFor(target, p)));
  return summary(server, result);
});

/** Auto-upload hook, called by the plugin after an explicit :write (BufWritePost). */
rpc.on('fileSaved', async ({ path }: { path: string }) => {
  const { config, deployer } = ready();
  const project = await config.projectFor(path);
  if (!project || project.config.options.autoUpload === 'never') return null;
  const server = config.defaultServer(project);
  if (!server) return null;
  const target = config.target(server);
  if (!target.mapper.isDeployable(path) || deployer.isOwnLocalWrite(path)) return null;
  try {
    const result = await deployer.uploadFile(target, path, target.options.warnOnNewerRemote !== 'none');
    if (result.transferred) log.info(`Automatic upload: ${basename(path)} → ${server.name}`);
    return summary(server, result);
  } catch (e) {
    if (isRemoteError(e, 'Cancelled')) return null;
    throw e;
  }
});

rpc.on('fetchRemote', async ({ path, serverId }: { path: string; serverId?: string }) => {
  const { server, target } = await resolveTarget(path, serverId);
  const remotePath = remotePathFor(target, path);
  const { tmpPath, exists } = await fetchToTemp(target, remotePath);
  return { tmpPath, remotePath, exists, server: server.name };
});

rpc.on('webUrl', async ({ path, serverId }: { path: string; serverId?: string }) => {
  const { target } = await resolveTarget(path, serverId);
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
  const { server } = await resolveTarget(path, serverId);
  await ready().credentials.forget(server.id);
  if (server.type === 'sftp') await ready().credentials.forgetHostKeys(server.host, server.port ?? 22);
  return server.name;
});

const shutdown = async () => {
  if (state) {
    await state.cache.flush().catch(() => undefined);
    state.servers.dispose();
    state.config.dispose();
    await fs.rm(state.tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  process.exit(0);
};

rpc.on('shutdown', () => {
  setImmediate(() => void shutdown());
  return true;
});

rpc.start(() => void shutdown());
