/**
 * Deployment settings dialog for Neovim (PhpStorm: Settings → Deployment): read the project configuration, save an
 * edited copy (validated by the same normalizer as VS Code), test a server before saving, and manage its secrets.
 */
import { normalizeProjectConfig, normalizeServer } from '../config/normalize';
import { SERVER_TYPE_LABELS, defaultOptions, defaultPort, type ProjectConfigFile } from '../config/schema';
import { errorMessage } from '../protocol/types';
import type { SecretKind } from '../config/CredentialProvider';
import type { Context } from './context';
import type { Rpc } from './rpc';

export const registerSettings = (rpc: Rpc, getCtx: () => Context): void => {
  rpc.on('configGet', async ({ path }: { path: string }) => {
    const ctx = getCtx();
    const project = (await ctx.config.projectFor(path)) ?? (await ctx.config.ensureProject(path));
    const globals = ctx.config.servers(project).filter((s) => s.scope === 'global');
    return {
      root: project.root,
      configPath: project.configPath,
      config: project.config,
      // Global (IDE-level) servers: connection is edited in VS Code; mappings/excludes are per project.
      globalServers: globals.map(({ project: _p, scope: _s, ...rest }) => rest),
      problems: project.errors,
      typeLabels: SERVER_TYPE_LABELS,
      defaultOptions: defaultOptions(),
      defaultPorts: Object.fromEntries(Object.keys(SERVER_TYPE_LABELS).map((t) => [t, defaultPort(t as never) ?? null])),
    };
  });

  rpc.on('configSave', async ({ root, config }: { root: string; config: ProjectConfigFile }) => {
    const ctx = getCtx();
    const project = await ctx.config.ensureProject(root);
    const errors: string[] = [];
    normalizeProjectConfig(config, errors);
    if (errors.length) return { saved: false, errors };
    await ctx.config.saveProject(project, config);
    return { saved: true, errors: [], configPath: project.configPath };
  });

  /** Connects with the (possibly unsaved) server definition and lists its root path. */
  rpc.on('testConnection', async ({ server }: { server: Record<string, unknown> }) => {
    const ctx = getCtx();
    const errors: string[] = [];
    const s = normalizeServer(server, 0, errors);
    if (!s) return { ok: false, message: errors.join('; ') || 'Invalid server definition.' };
    let conn: Awaited<ReturnType<typeof ctx.servers.connectClient>> | undefined;
    try {
      conn = await ctx.servers.connectClient(s);
      const root = s.rootPath || '/';
      const st = await conn.client.stat(root);
      if (!st) return { ok: false, message: `Connected, but the root path ${root} does not exist.` };
      const entries = await conn.client.list(root);
      return { ok: true, message: `Connected to ${s.name}: ${root} (${entries.length} entries).` };
    } catch (e) {
      return { ok: false, message: errorMessage(e) };
    } finally {
      await conn?.client.close().catch(() => undefined);
      conn?.cleanup?.();
    }
  });

  rpc.on('setSecret', async ({ serverId, kind, value }: { serverId: string; kind: SecretKind; value: string }) => {
    return getCtx().credentials.store(serverId, kind, value);
  });

  rpc.on('hasSecret', async ({ serverId, kind }: { serverId: string; kind: SecretKind }) => {
    return (await getCtx().credentials.getStored(serverId, kind)) !== undefined;
  });

  rpc.on('forgetSecret', async ({ serverId }: { serverId: string }) => {
    await getCtx().credentials.forget(serverId);
    return true;
  });
};
