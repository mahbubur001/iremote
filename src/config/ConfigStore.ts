import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { PathMapper } from '../core/PathMapper';
import type { DeploymentTarget } from '../core/Deployer';
import { normalizeGlobalConfig, normalizeProjectConfig, toJson } from './normalize';
import { defaultOptions, type GlobalConfigFile, type ProjectConfigFile, type ServerConfig } from './schema';

export const CONFIG_RELATIVE_PATH = '.vscode/iremote.json';

export interface Project {
  folder: vscode.WorkspaceFolder;
  root: string;
  configUri: vscode.Uri;
  config: ProjectConfigFile;
  exists: boolean;
  errors: string[];
}

export interface ResolvedServer extends ServerConfig {
  scope: 'project' | 'global';
  project: Project;
}

const emptyProjectConfig = (): ProjectConfigFile => ({ version: 1, options: defaultOptions(), servers: [], globalServerData: {} });

export class ConfigStore implements vscode.Disposable {
  private _projects: Project[] = [];
  private global: GlobalConfigFile = { version: 1, servers: [] };
  private globalErrors: string[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly createdEmitter = new vscode.EventEmitter<Project>();
  private readonly disposables: vscode.Disposable[] = [];
  private watchers: vscode.Disposable[] = [];
  private reloadTimer?: NodeJS.Timeout;
  /** Path mappers are rebuilt only when the configuration changes; they are hit for every tree item and decoration. */
  private readonly mappers = new Map<string, PathMapper>();

  readonly onDidChange = this.emitter.event;
  /** Fires when saving creates a project's .vscode/iremote.json for the first time. */
  readonly onDidCreateProjectConfig = this.createdEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      this.emitter,
      this.createdEmitter,
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.reload()),
    );
  }

  private get globalUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'servers.json');
  }

  get projects(): readonly Project[] {
    return this._projects;
  }

  get globalServers(): GlobalConfigFile['servers'] {
    return this.global.servers;
  }

  get problems(): string[] {
    return [...this.globalErrors, ...this._projects.flatMap((p) => p.errors.map((e) => `${p.folder.name}: ${e}`))];
  }

  async initialize(): Promise<void> {
    await this.reload();
  }

  /**
   * Config files always live on the local disk (workspace folders are filtered to the file scheme and global storage
   * is local), so Node's fs is used directly: it settles reliably, while workspace.fs may not resolve for a missing file
   * under a not-yet-created global storage folder.
   */
  private async readJson(uri: vscode.Uri): Promise<{ raw: unknown; exists: boolean; error?: string }> {
    let text: string;
    try {
      text = await fs.readFile(uri.fsPath, 'utf8');
    } catch {
      return { raw: undefined, exists: false };
    }
    try {
      return { raw: JSON.parse(text), exists: true };
    } catch (e) {
      return { raw: undefined, exists: true, error: `${uri.fsPath} is not valid JSON: ${(e as Error).message}` };
    }
  }

  /** Atomic write (temp file + rename) so watchers never see a half-written config. */
  private async writeJson(uri: vscode.Uri, content: string): Promise<void> {
    await fs.mkdir(dirname(uri.fsPath), { recursive: true });
    const tmp = `${uri.fsPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, uri.fsPath);
  }

  async reload(): Promise<void> {
    const g = await this.readJson(this.globalUri);
    this.globalErrors = g.error ? [g.error] : [];
    this.global = normalizeGlobalConfig(g.raw, this.globalErrors);

    const folders = vscode.workspace.workspaceFolders ?? [];
    this._projects = await Promise.all(
      folders
        .filter((f) => f.uri.scheme === 'file')
        .map(async (folder) => {
          const configUri = vscode.Uri.joinPath(folder.uri, CONFIG_RELATIVE_PATH);
          const { raw, exists, error } = await this.readJson(configUri);
          const errors = error ? [error] : [];
          const config = exists && !error ? normalizeProjectConfig(raw, errors) : emptyProjectConfig();
          return { folder, root: folder.uri.fsPath, configUri, config, exists, errors };
        }),
    );
    this.mappers.clear();
    this.rewatch();
    await vscode.commands.executeCommand('setContext', 'iremote.hasServers', this.allServers().length > 0);
    await vscode.commands.executeCommand('setContext', 'iremote.hasDefaultServer', this._projects.some((p) => !!this.defaultServer(p)));
    this.emitter.fire();
  }

  private rewatch(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = this._projects.map((p) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(p.folder, CONFIG_RELATIVE_PATH));
      const schedule = () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => void this.reload(), 300);
      };
      w.onDidChange(schedule);
      w.onDidCreate(schedule);
      w.onDidDelete(schedule);
      return w;
    });
  }

  /** Servers usable in a project: its own plus global (IDE-level) ones with project-specific mappings. */
  servers(project: Project): ResolvedServer[] {
    const own = project.config.servers.map((s): ResolvedServer => ({ ...s, scope: 'project', project }));
    const global = this.global.servers.map((s): ResolvedServer => {
      const data = project.config.globalServerData?.[s.id] ?? { mappings: [], excludedLocal: [], excludedRemote: [] };
      return { ...s, ...data, scope: 'global', project };
    });
    return [...own, ...global];
  }

  allServers(): ResolvedServer[] {
    return this._projects.flatMap((p) => this.servers(p));
  }

  /** Unique servers by id, preferring the project-scoped definition (connections are shared across projects). */
  uniqueServers(): ResolvedServer[] {
    const map = new Map<string, ResolvedServer>();
    for (const s of this.allServers()) if (!map.has(s.id) || s.scope === 'project') map.set(s.id, s);
    return [...map.values()];
  }

  findServer(id: string, project?: Project): ResolvedServer | undefined {
    if (project) return this.servers(project).find((s) => s.id === id);
    return this.uniqueServers().find((s) => s.id === id);
  }

  projectFor(uri: vscode.Uri): Project | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? this._projects.find((p) => p.folder.uri.toString() === folder.uri.toString()) : undefined;
  }

  defaultServer(project: Project): ResolvedServer | undefined {
    const id = project.config.defaultServer;
    return id ? this.servers(project).find((s) => s.id === id) : undefined;
  }

  target(server: ResolvedServer): DeploymentTarget {
    const { project } = server;
    const key = `${project.root}\u0000${server.id}`;
    let mapper = this.mappers.get(key);
    if (!mapper) {
      mapper = new PathMapper(project.root, server, project.config.options.excludeNames);
      this.mappers.set(key, mapper);
    }
    return { server, projectRoot: project.root, options: project.config.options, mapper };
  }

  async saveProject(project: Project, config: ProjectConfigFile): Promise<void> {
    const errors: string[] = [];
    const clean = normalizeProjectConfig(config, errors);
    // Keep only mapping data for global servers that still exist.
    const globalIds = new Set(this.global.servers.map((s) => s.id));
    clean.globalServerData = Object.fromEntries(Object.entries(clean.globalServerData ?? {}).filter(([id]) => globalIds.has(id)));
    if (clean.defaultServer && !clean.servers.some((s) => s.id === clean.defaultServer) && !globalIds.has(clean.defaultServer)) {
      clean.defaultServer = undefined;
    }
    const created = !(await fs.stat(project.configUri.fsPath).then(() => true, () => false));
    await this.writeJson(project.configUri, toJson(clean));
    await this.reload();
    if (created) this.createdEmitter.fire(this._projects.find((p) => p.root === project.root) ?? project);
  }

  async saveGlobal(config: GlobalConfigFile): Promise<void> {
    const clean = normalizeGlobalConfig(config);
    await this.writeJson(this.globalUri, toJson(clean));
    await this.reload();
  }

  dispose(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watchers.forEach((w) => w.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}
