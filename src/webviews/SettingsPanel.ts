import * as vscode from 'vscode';
import { relative, isAbsolute, sep } from 'node:path';
import type { Services } from '../services';
import type { Project, ResolvedServer } from '../config/ConfigStore';
import type { GlobalServer, ProjectConfigFile, ServerConfig } from '../config/schema';
import type { RemoteClient } from '../protocol/types';
import { errorMessage } from '../protocol/types';
import { log } from '../util/log';
import { webviewHtml } from './html';
import type { SecretChange, SettingsToHost, SettingsToWebview, UiProject, UiServer } from '../../webview/shared/protocol';

const projectKey = (p: Project) => p.folder.uri.toString();

const toUi = (s: ResolvedServer): UiServer => {
  const { project: _p, ...rest } = s;
  return rest;
};

const fromUi = (s: UiServer): ServerConfig => {
  const { scope: _s, ...rest } = s;
  return rest;
};

const connectionOnly = (s: UiServer): GlobalServer => {
  const { scope: _s, mappings: _m, excludedLocal: _l, excludedRemote: _r, ...rest } = s;
  return rest;
};

/** PhpStorm-style "Deployment" settings dialog: servers (Connection / Mappings / Excluded Paths) and Options. */
export class SettingsPanel {
  private static current?: SettingsPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(s: Services, serverId?: string): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      void SettingsPanel.current.sendInit(serverId);
      return;
    }
    const panel = vscode.window.createWebviewPanel('iremote.settings', 'Deployment', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(s.context.extensionUri, 'dist', 'webview')],
    });
    SettingsPanel.current = new SettingsPanel(s, panel, serverId);
    if (vscode.workspace.getConfiguration('iremote').get<string>('settings.openIn', 'window') === 'window') void SettingsPanel.float(panel);
  }

  /**
   * PhpStorm shows Deployment as a dialog. Extensions cannot open modal windows, so the panel moves into its own
   * floating window (it closes with OK / Cancel, as its only editor). The webview reloads on the move and re-sends
   * "ready", which re-initializes it. The window is then made compact (no tab bar / title chrome) and kept on top so
   * it reads as a dialog. Older VS Code without auxiliary windows (or these commands) keeps what it supports.
   */
  private static async float(panel: vscode.WebviewPanel): Promise<void> {
    for (let i = 0; i < 25 && !panel.active; i++) await new Promise((r) => setTimeout(r, 20));
    if (!panel.active) return;
    const run = (cmd: string) => Promise.resolve(vscode.commands.executeCommand(cmd)).then(() => true, () => false);
    if (!(await run('workbench.action.moveEditorToNewWindow'))) return;
    await run('workbench.action.enableCompactAuxiliaryWindow');
    await run('workbench.action.enableWindowAlwaysOnTop');
  }

  private constructor(
    private readonly s: Services,
    private readonly panel: vscode.WebviewPanel,
    private initialServer?: string,
  ) {
    panel.iconPath = {
      light: vscode.Uri.joinPath(s.context.extensionUri, 'media', 'settings-light.svg'),
      dark: vscode.Uri.joinPath(s.context.extensionUri, 'media', 'settings-dark.svg'),
    };
    panel.webview.html = webviewHtml(panel.webview, s.context.extensionUri, 'settings', 'Deployment');
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: SettingsToHost) => void this.onMessage(m)),
    );
  }

  private post(msg: SettingsToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  private activeProjectKey(): string {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const p = (uri && this.s.config.projectFor(uri)) ?? this.s.config.projects[0];
    return p ? projectKey(p) : '';
  }

  private async sendInit(selectedServer?: string): Promise<void> {
    const { config, credentials } = this.s;
    const projects: UiProject[] = config.projects.map((p) => ({
      key: projectKey(p),
      name: p.folder.name,
      root: p.root,
      defaultServer: p.config.defaultServer,
      options: p.config.options,
      servers: config.servers(p).map(toUi),
    }));
    const secrets: Record<string, { hasPassword: boolean; hasPassphrase: boolean }> = {};
    for (const sv of config.uniqueServers()) {
      secrets[sv.id] = {
        hasPassword: (await credentials.getStored(sv.id, 'password')) !== undefined,
        hasPassphrase: (await credentials.getStored(sv.id, 'passphrase')) !== undefined,
      };
    }
    let active = this.activeProjectKey();
    if (selectedServer) {
      const owner = config.projects.find((p) => config.servers(p).some((x) => x.id === selectedServer));
      if (owner) active = projectKey(owner);
    }
    this.post({ type: 'init', projects, activeProject: active, selectedServer, secrets, problems: config.problems, pathSeparator: sep });
  }

  private project(key: string): Project | undefined {
    return this.s.config.projects.find((p) => projectKey(p) === key);
  }

  private async onMessage(m: SettingsToHost): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.sendInit(this.initialServer);
        this.initialServer = undefined;
        return;
      case 'cancel':
        this.panel.dispose();
        return;
      case 'save':
        return this.save(m.projects, m.secrets, m.close);
      case 'importPhpStorm':
        await vscode.commands.executeCommand('iremote.importPhpStorm');
        await this.sendInit();
        return;
      case 'test':
        return this.withTempClient(m.requestId, m.server, m.secret, async (c) => {
          const root = m.server.rootPath || '/';
          const st = await c.stat(root);
          if (!st) return { ok: false, message: `Connected, but the root path "${root}" does not exist.` };
          if (st.type !== 'dir' && st.targetType !== 'dir') return { ok: false, message: `Connected, but "${root}" is not a directory.` };
          await c.list(root);
          return { ok: true, message: `Connected to ${m.server.name || m.server.host} successfully.` };
        });
      case 'detectRoot':
        return this.withTempClient(m.requestId, m.server, m.secret, async (c) => ({ ok: true, path: await c.homeDir() }));
      case 'browseRemote':
        return this.withTempClient(m.requestId, m.server, m.secret, async (c) => {
          const path = m.path || (await c.homeDir());
          const entries = (await c.list(path))
            .map((e) => ({ name: e.name, isDir: e.type === 'dir' || e.targetType === 'dir' }))
            .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
          return { ok: true, path, entries };
        });
      case 'browseLocal': {
        const project = this.project(m.projectKey);
        const base = project?.folder.uri;
        const start = m.current && isAbsolute(m.current) ? vscode.Uri.file(m.current) : base && m.current ? vscode.Uri.joinPath(base, m.current) : base;
        const picked = await vscode.window.showOpenDialog({
          defaultUri: start,
          canSelectFiles: !m.folders,
          canSelectFolders: m.folders,
          canSelectMany: false,
          openLabel: 'Select',
        });
        if (!picked?.[0]) return this.post({ type: 'result', requestId: m.requestId, ok: false });
        let path = picked[0].fsPath;
        if (m.relative && project) {
          const rel = relative(project.root, path);
          if (!rel.startsWith('..') && !isAbsolute(rel)) path = rel.split(sep).join('/');
        }
        return this.post({ type: 'result', requestId: m.requestId, ok: true, path });
      }
    }
  }

  private async withTempClient(
    requestId: number,
    ui: UiServer,
    secret: SecretChange | undefined,
    fn: (c: RemoteClient) => Promise<{ ok: boolean; message?: string; path?: string; entries?: { name: string; isDir: boolean }[] }>,
  ): Promise<void> {
    const server = fromUi(ui);
    if (secret?.password !== undefined) this.s.credentials.setSession(server.id, 'password', secret.password);
    if (secret?.passphrase !== undefined) this.s.credentials.setSession(server.id, 'passphrase', secret.passphrase);
    let client: RemoteClient | undefined;
    let cleanup: (() => void) | undefined;
    try {
      ({ client, cleanup } = await this.s.servers.connectClient(server));
      const result = await fn(client);
      this.post({ type: 'result', requestId, ...result });
    } catch (e) {
      log.error(`Connection test for ${server.name}`, e);
      this.post({ type: 'result', requestId, ok: false, message: errorMessage(e) });
    } finally {
      await client?.close().catch(() => undefined);
      cleanup?.();
    }
  }

  private async save(projects: UiProject[], secrets: Record<string, SecretChange>, close: boolean): Promise<void> {
    const { config, credentials, cache, servers } = this.s;
    const before = new Set(config.allServers().map((x) => x.id));
    try {
      const globalById = new Map<string, GlobalServer>();
      for (const p of projects) for (const sv of p.servers) if (sv.scope === 'global' && !globalById.has(sv.id)) globalById.set(sv.id, connectionOnly(sv));
      await config.saveGlobal({ version: 1, servers: [...globalById.values()] });

      for (const p of projects) {
        const project = this.project(p.key);
        if (!project) continue;
        const touched = project.exists || p.servers.length > 0;
        if (!touched) continue;
        const file: ProjectConfigFile = {
          version: 1,
          defaultServer: p.defaultServer,
          options: p.options,
          servers: p.servers.filter((x) => x.scope === 'project').map(fromUi),
          globalServerData: Object.fromEntries(
            p.servers.filter((x) => x.scope === 'global').map((x) => [x.id, { mappings: x.mappings, excludedLocal: x.excludedLocal, excludedRemote: x.excludedRemote }]),
          ),
        };
        await config.saveProject(project, file);
      }

      for (const [id, change] of Object.entries(secrets)) {
        for (const kind of ['password', 'passphrase'] as const) {
          const value = change[kind];
          const persist = kind === 'password' ? change.savePassword : change.savePassphrase;
          if (value !== undefined) {
            if (persist) await credentials.store(id, kind, value);
            else {
              await credentials.forget(id, kind);
              credentials.setSession(id, kind, value);
            }
          } else if (!persist) {
            await credentials.forget(id, kind);
          }
        }
      }

      const after = new Set(config.allServers().map((x) => x.id));
      for (const id of before) {
        if (after.has(id)) continue;
        await credentials.forget(id);
        cache.forgetServer(id);
        await servers.disconnect(id);
      }
      this.post({ type: 'saved', ok: true, problems: config.problems });
      if (close) this.panel.dispose();
      else await this.sendInit();
    } catch (e) {
      log.error('Saving deployment settings failed', e);
      this.post({ type: 'saved', ok: false, message: errorMessage(e) });
    }
  }

  private dispose(): void {
    SettingsPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}
