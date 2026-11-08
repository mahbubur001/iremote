import { promises as fs, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { PathMapper } from '../core/PathMapper';
import type { DeploymentTarget } from '../core/Deployer';
import type { ServerSource } from '../core/ServerManager';
import { normalizeGlobalConfig, normalizeProjectConfig, toJson } from '../config/normalize';
import type { GlobalConfigFile, ProjectConfigFile, ServerConfig } from '../config/schema';
import { Emitter } from '../util/emitter';

export const CONFIG_RELATIVE_PATH = join('.vscode', 'iremote.json');

export interface NvimProject {
  root: string;
  configPath: string;
  config: ProjectConfigFile;
  errors: string[];
}

export interface NvimServer extends ServerConfig {
  scope: 'project' | 'global';
  project: NvimProject;
}

/** Where VS Code keeps iRemote's global (IDE-level) servers, so Neovim sees the same list. */
export const defaultGlobalServersFile = (): string => {
  const ext = join('User', 'globalStorage', 'itemcoder.iremote', 'servers.json');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Code', ext);
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code', ext);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Code', ext);
};

const readJson = async (path: string): Promise<{ raw: unknown; exists: boolean; error?: string }> => {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch {
    return { raw: undefined, exists: false };
  }
  try {
    return { raw: JSON.parse(text), exists: true };
  } catch (e) {
    return { raw: undefined, exists: true, error: `${path} is not valid JSON: ${(e as Error).message}` };
  }
};

const writeJson = async (path: string, content: string): Promise<void> => {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, path);
};

const isInside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Project configuration for the Neovim server: the same `.vscode/iremote.json` files VS Code uses, discovered by
 * walking up from any file Neovim asks about, plus VS Code's global servers (read-only unless a TLS pin is saved).
 */
export class NvimConfig implements ServerSource {
  private readonly projects = new Map<string, NvimProject>();
  private global: GlobalConfigFile = { version: 1, servers: [] };
  private globalErrors: string[] = [];
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly mappers = new Map<string, PathMapper>();
  private reloadTimer?: NodeJS.Timeout;
  private readonly emitter = new Emitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly globalServersFile: string) {}

  get problems(): string[] {
    return [...this.globalErrors, ...[...this.projects.values()].flatMap((p) => p.errors.map((e) => `${p.root}: ${e}`))];
  }

  async loadGlobal(): Promise<void> {
    const g = await readJson(this.globalServersFile);
    this.globalErrors = g.error ? [g.error] : [];
    this.global = normalizeGlobalConfig(g.raw, this.globalErrors);
  }

  /** Finds (and loads) the project whose `.vscode/iremote.json` is nearest above `path`. */
  async projectFor(path: string): Promise<NvimProject | undefined> {
    const abs = resolve(path);
    const known = [...this.projects.values()].filter((p) => isInside(p.root, abs)).sort((a, b) => b.root.length - a.root.length)[0];
    if (known) return known;
    for (let dir = abs; ; dir = dirname(dir)) {
      const configPath = join(dir, CONFIG_RELATIVE_PATH);
      if (await fs.stat(configPath).then((s) => s.isFile(), () => false)) return this.loadProject(dir);
      if (dirname(dir) === dir) return undefined;
    }
  }

  private async loadProject(root: string): Promise<NvimProject> {
    const configPath = join(root, CONFIG_RELATIVE_PATH);
    const { raw, exists, error } = await readJson(configPath);
    const errors = error ? [error] : [];
    const config = exists && !error ? normalizeProjectConfig(raw, errors) : normalizeProjectConfig({ version: 1, servers: [] });
    const project: NvimProject = { root, configPath, config, errors };
    this.projects.set(root, project);
    this.watch(project);
    return project;
  }

  private watch(project: NvimProject): void {
    if (this.watchers.has(project.root)) return;
    try {
      // Watch the directory: editors replace the file on save, which ends a watch on the file itself.
      const w = watch(dirname(project.configPath), (_event, name) => {
        if (name && String(name) !== 'iremote.json') return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => void this.reload(), 300);
      });
      this.watchers.set(project.root, w);
    } catch {
      // Not watchable (e.g. network drive): `reload` can still be called explicitly.
    }
  }

  async reload(): Promise<void> {
    await this.loadGlobal();
    for (const root of [...this.projects.keys()]) await this.loadProject(root);
    this.mappers.clear();
    this.emitter.fire();
  }

  servers(project: NvimProject): NvimServer[] {
    const own = project.config.servers.map((s): NvimServer => ({ ...s, scope: 'project', project }));
    const global = this.global.servers.map((s): NvimServer => {
      const data = project.config.globalServerData?.[s.id] ?? { mappings: [], excludedLocal: [], excludedRemote: [] };
      return { ...s, ...data, scope: 'global', project };
    });
    return [...own, ...global];
  }

  uniqueServers(): NvimServer[] {
    const map = new Map<string, NvimServer>();
    for (const p of this.projects.values()) for (const s of this.servers(p)) if (!map.has(s.id) || s.scope === 'project') map.set(s.id, s);
    return [...map.values()];
  }

  findServer(id: string, project?: NvimProject): NvimServer | undefined {
    if (project) return this.servers(project).find((s) => s.id === id);
    return this.uniqueServers().find((s) => s.id === id);
  }

  defaultServer(project: NvimProject): NvimServer | undefined {
    const id = project.config.defaultServer;
    return id ? this.servers(project).find((s) => s.id === id) : undefined;
  }

  target(server: NvimServer): DeploymentTarget {
    const { project } = server;
    const key = `${project.root}\u0000${server.id}`;
    let mapper = this.mappers.get(key);
    if (!mapper) {
      mapper = new PathMapper(project.root, server, project.config.options.excludeNames);
      this.mappers.set(key, mapper);
    }
    return { server, projectRoot: project.root, options: project.config.options, mapper };
  }

  async saveProject(project: NvimProject, config: ProjectConfigFile): Promise<void> {
    await writeJson(project.configPath, toJson(normalizeProjectConfig(config)));
    await this.reload();
  }

  async setDefaultServer(project: NvimProject, serverId: string | undefined): Promise<void> {
    await this.saveProject(project, { ...project.config, defaultServer: serverId });
  }

  async setAutoUpload(project: NvimProject, mode: ProjectConfigFile['options']['autoUpload']): Promise<void> {
    await this.saveProject(project, { ...project.config, options: { ...project.config.options, autoUpload: mode } });
  }

  async pinCertificate(serverId: string, fingerprint: string): Promise<void> {
    const server = this.findServer(serverId);
    if (!server) return;
    if (server.scope === 'global') {
      const servers = this.global.servers.map((s) => (s.id === serverId ? { ...s, trustedCertificateFingerprint: fingerprint } : s));
      await writeJson(this.globalServersFile, toJson(normalizeGlobalConfig({ version: 1, servers })));
      await this.reload();
    } else {
      const { project } = server;
      const servers = project.config.servers.map((s) => (s.id === serverId ? { ...s, trustedCertificateFingerprint: fingerprint } : s));
      await this.saveProject(project, { ...project.config, servers });
    }
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watchers.forEach((w) => w.close());
    this.emitter.dispose();
  }
}
