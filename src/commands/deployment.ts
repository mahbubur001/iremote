import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import type { Services } from '../services';
import type { Project } from '../config/ConfigStore';
import type { AutoUploadMode } from '../config/schema';
import { remoteUri } from '../fs/uri';
import { defaultOrPick, groupByProject, guarded, pickServer, reportResult, resolveTargets } from './helpers';
import { SyncPanel } from '../webviews/SyncPanel';
import { SettingsPanel } from '../webviews/SettingsPanel';

const noTargets = () => void vscode.window.showInformationMessage('Select a file or folder inside a workspace folder first.');

export const registerDeploymentCommands = (s: Services): vscode.Disposable[] => {
  const { config, deployer, queue, servers, tree } = s;

  const upload = async (useDefault: boolean, uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const groups = groupByProject(config, resolveTargets(uri, uris));
    if (groups.size === 0) return noTargets();
    for (const [project, paths] of groups) {
      const server = useDefault ? await defaultOrPick(config, project, 'Upload to…') : await pickServer(config, project, 'Upload to…');
      if (!server) continue;
      const target = config.target(server);
      const unmapped = paths.filter((p) => !target.mapper.toRemote(p));
      if (unmapped.length === paths.length) {
        void vscode.window.showWarningMessage(`${basename(paths[0])} is not mapped on ${server.name}. Check the Mappings tab in Deployment Settings.`, 'Open Settings').then(
          (c) => c && vscode.commands.executeCommand('iremote.openSettings', server.id),
        );
        continue;
      }
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Uploading to ${server.name}` },
        () => deployer.upload(target, paths, target.options.warnOnNewerRemote !== 'none'),
      );
      reportResult('Uploaded', server, result);
    }
  };

  const download = async (useDefault: boolean, uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const groups = groupByProject(config, resolveTargets(uri, uris));
    if (groups.size === 0) return noTargets();
    for (const [project, paths] of groups) {
      const server = useDefault ? await defaultOrPick(config, project, 'Download from…') : await pickServer(config, project, 'Download from…');
      if (!server) continue;
      const target = config.target(server);
      const remotes = paths.map((p) => target.mapper.toRemote(p)).filter((r): r is string => !!r);
      if (remotes.length === 0) {
        void vscode.window.showWarningMessage(`The selection is not mapped on ${server.name}.`);
        continue;
      }
      const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && paths.some((p) => d.uri.fsPath === p || d.uri.fsPath.startsWith(`${p}/`) || d.uri.fsPath.startsWith(`${p}\\`)));
      if (dirty.length) {
        const ok = await vscode.window.showWarningMessage(
          `${dirty.length} file(s) have unsaved changes that will be overwritten by the download.`,
          { modal: true },
          'Download Anyway',
        );
        if (!ok) continue;
      }
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Downloading from ${server.name}` },
        () => deployer.download(target, remotes),
      );
      reportResult('Downloaded', server, result);
    }
  };

  const compare = async (useDefault: boolean, uri?: vscode.Uri) => {
    const [local] = resolveTargets(uri);
    if (!local) return noTargets();
    const project = config.projectFor(local);
    if (!project) return noTargets();
    const server = useDefault ? await defaultOrPick(config, project, 'Compare with…') : await pickServer(config, project, 'Compare with…');
    if (!server) return;
    const target = config.target(server);
    const remote = target.mapper.toRemote(local.fsPath);
    if (!remote) return void vscode.window.showWarningMessage(`${basename(local.fsPath)} is not mapped on ${server.name}.`);
    const isDir = await fs.stat(local.fsPath).then((st) => st.isDirectory(), () => false);
    if (isDir) return SyncPanel.show(s, server, [local.fsPath]);
    await vscode.commands.executeCommand(
      'vscode.diff',
      remoteUri(server.id, remote),
      local,
      `${basename(local.fsPath)} (${server.name} ↔ Local)`,
    );
  };

  const setAutoUpload = async (project: Project, mode: AutoUploadMode) => {
    await config.saveProject(project, { ...project.config, options: { ...project.config.options, autoUpload: mode } });
  };

  const pickProject = async (placeHolder: string): Promise<Project | undefined> => {
    const active = vscode.window.activeTextEditor?.document.uri;
    const fromEditor = active && config.projectFor(active);
    if (fromEditor) return fromEditor;
    const projects = config.projects;
    if (projects.length <= 1) return projects[0];
    const picked = await vscode.window.showQuickPick(projects.map((p) => ({ label: p.folder.name, description: p.root, project: p })), { placeHolder });
    return picked?.project;
  };

  return [
    vscode.commands.registerCommand('iremote.uploadToDefault', guarded('Upload', (u?: vscode.Uri, us?: vscode.Uri[]) => upload(true, u, us))),
    vscode.commands.registerCommand('iremote.uploadTo', guarded('Upload', (u?: vscode.Uri, us?: vscode.Uri[]) => upload(false, u, us))),
    vscode.commands.registerCommand('iremote.downloadFromDefault', guarded('Download', (u?: vscode.Uri, us?: vscode.Uri[]) => download(true, u, us))),
    vscode.commands.registerCommand('iremote.downloadFrom', guarded('Download', (u?: vscode.Uri, us?: vscode.Uri[]) => download(false, u, us))),
    vscode.commands.registerCommand('iremote.compareWithDeployed', guarded('Compare', (u?: vscode.Uri) => compare(true, u))),
    vscode.commands.registerCommand('iremote.compareWithDeployedOn', guarded('Compare', (u?: vscode.Uri) => compare(false, u))),

    vscode.commands.registerCommand(
      'iremote.syncWithDeployed',
      guarded('Sync', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        let targets = resolveTargets(uri, uris);
        if (!uri && !uris?.length) {
          const project = await pickProject('Synchronize which project?');
          if (!project) return;
          targets = [project.folder.uri];
        }
        const groups = groupByProject(config, targets);
        if (groups.size === 0) return noTargets();
        for (const [project, paths] of groups) {
          const server = await pickServer(config, project, 'Sync with deployed to…');
          if (server) SyncPanel.show(s, server, paths);
        }
      }),
    ),

    vscode.commands.registerCommand(
      'iremote.toggleAutoUpload',
      guarded('Automatic upload', async () => {
        const project = await pickProject('Configure automatic upload for…');
        if (!project) return;
        if (!config.defaultServer(project)) {
          const c = await vscode.window.showWarningMessage('Automatic upload needs a default server.', 'Set Default Server…');
          if (c) await vscode.commands.executeCommand('iremote.setDefaultServer');
          if (!config.defaultServer(project)) return;
        }
        const current = project.config.options.autoUpload;
        const items: { label: string; mode: AutoUploadMode; description?: string }[] = [
          { label: 'Always', mode: 'always', description: 'Upload on every save, including auto-save' },
          { label: 'On explicit save action', mode: 'onExplicitSave', description: 'Upload only on Ctrl/Cmd+S' },
          { label: 'Never', mode: 'never' },
        ];
        const picked = await vscode.window.showQuickPick(
          items.map((i) => ({ ...i, label: `${i.mode === current ? '$(check) ' : ''}${i.label}` })),
          { placeHolder: `Automatic upload to ${config.defaultServer(project)?.name}` },
        );
        if (picked) await setAutoUpload(project, picked.mode);
      }),
    ),

    vscode.commands.registerCommand(
      'iremote.setDefaultServer',
      guarded('Default server', async () => {
        const project = await pickProject('Set the default server for…');
        if (!project) return;
        const all = config.servers(project);
        if (all.length === 0) return vscode.commands.executeCommand('iremote.openSettings');
        const picked = await vscode.window.showQuickPick(
          [
            ...all.map((sv) => ({ label: `${sv.id === project.config.defaultServer ? '$(star-full) ' : ''}${sv.name}`, description: sv.host, id: sv.id as string | undefined })),
            { label: '$(close) No default server', description: '', id: undefined },
          ],
          { placeHolder: 'Default deployment server (target of automatic upload)' },
        );
        if (!picked) return;
        await config.saveProject(project, { ...project.config, defaultServer: picked.id });
      }),
    ),

    vscode.commands.registerCommand(
      'iremote.browseRemoteHost',
      guarded('Browse Remote Host', async (uri?: vscode.Uri) => {
        await vscode.commands.executeCommand('iremote.remoteHost.focus');
        const [local] = uri ? resolveTargets(uri) : [];
        const project = local && config.projectFor(local);
        if (!local || !project) return;
        const server = await defaultOrPick(config, project, 'Browse which server?');
        if (!server) return;
        const remote = config.target(server).mapper.toRemote(local.fsPath);
        if (!remote) return;
        const st = await servers.pool(server).use((c) => c.stat(remote));
        if (st) {
          await tree.selectServer(server.id);
          await tree.reveal(server, remote, st);
        }
      }),
    ),

    vscode.commands.registerCommand(
      'iremote.openInBrowser',
      guarded('Open in browser', async (uri?: vscode.Uri) => {
        const [local] = resolveTargets(uri);
        const project = local && config.projectFor(local);
        if (!local || !project) return noTargets();
        const server = await defaultOrPick(config, project, 'Open on which server?');
        if (!server) return;
        const url = config.target(server).mapper.webUrlForLocal(local.fsPath);
        if (!url) return void vscode.window.showWarningMessage(`No web URL for this file on ${server.name}. Set the Web server URL and web path mapping.`);
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }),
    ),

    vscode.commands.registerCommand('iremote.showTransferLog', () => vscode.commands.executeCommand('iremote.transfers.focus')),
    vscode.commands.registerCommand('iremote.cancelTransfers', guarded('Cancel transfers', () => queue.cancel())),
    vscode.commands.registerCommand('iremote.clearTransfers', () => queue.clearFinished()),
    vscode.commands.registerCommand('iremote.disconnectAll', guarded('Disconnect', () => servers.disconnect())),

    vscode.commands.registerCommand(
      'iremote.forgetCredentials',
      guarded('Forget credentials', async () => {
        const all = config.uniqueServers();
        const picked = await vscode.window.showQuickPick(all.map((sv) => ({ label: sv.name, description: sv.host, server: sv })), {
          placeHolder: 'Forget saved password, passphrase and trusted host key for…',
        });
        if (!picked) return;
        await s.credentials.forget(picked.server.id);
        if (picked.server.type === 'sftp') await s.credentials.forgetHostKeys(picked.server.host, picked.server.port ?? 22);
        await servers.disconnect(picked.server.id);
        void vscode.window.showInformationMessage(`Saved credentials for ${picked.server.name} were removed.`);
      }),
    ),

    SettingsPanel.register(s),
    vscode.commands.registerCommand('iremote.openSettings', (serverId?: string) => SettingsPanel.show(s, typeof serverId === 'string' ? serverId : undefined)),
  ];
};
