import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { posix, basename } from 'node:path';
import type { Services } from '../services';
import type { ResolvedServer } from '../config/ConfigStore';
import { SERVER_TYPE_LABELS } from '../config/schema';
import { remoteUri } from '../fs/uri';
import { isDirStat, nodePath, type RemoteNode } from '../views/RemoteHostTree';
import { adHocTarget, guarded, remoteBasename, reportResult } from './helpers';
import { SyncPanel } from '../webviews/SyncPanel';

type EntryNode = Extract<RemoteNode, { kind: 'entry' }>;
type PathNode = Exclude<RemoteNode, { kind: 'error' }>;

const validName = (v: string) =>
  !v.trim() ? 'Name cannot be empty' : v.includes('\\') || v.split('/').some((seg) => seg === '.' || seg === '..') ? 'Invalid name' : undefined;

export const registerRemoteCommands = (s: Services): vscode.Disposable[] => {
  const { config, deployer, tree, servers } = s;

  /** Context-menu commands receive (clicked, selection); fall back to the tree selection for keybindings. */
  const selection = (node?: RemoteNode, nodes?: RemoteNode[]): PathNode[] => {
    const list = nodes?.length ? nodes : node ? [node] : [...tree.treeView.selection];
    return list.filter((n): n is PathNode => n.kind !== 'error');
  };

  const parentOf = (node: PathNode): RemoteNode | undefined => tree.getParent(node);

  const uploadInto = async (server: ResolvedServer, targetDir: string, files: vscode.Uri[]) => {
    const base = config.target(server);
    const pairs = files.map((f) => ({ local: f.fsPath, remote: posix.join(targetDir, basename(f.fsPath)) }));
    const target = adHocTarget(base, pairs);
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Uploading to ${server.name}` },
      () => deployer.upload(target, files.map((f) => f.fsPath), base.options.warnOnNewerRemote !== 'none'),
    );
    reportResult('Uploaded', server, result);
  };

  const moveInto = async (server: ResolvedServer, sources: string[], targetDir: string) => {
    const target = config.target(server);
    await Promise.all(sources.map((src) => deployer.renameRemote(target, src, posix.join(targetDir, posix.basename(src)))));
    tree.refresh();
  };

  tree.setHandlers({ dropFiles: uploadInto, move: moveInto });

  const openEntry = async (node: EntryNode, preferLocal: boolean) => {
    const local = config.target(node.server).mapper.toLocal(node.path);
    if (preferLocal && local && (await fs.stat(local).then((st) => st.isFile(), () => false))) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(local));
      return;
    }
    await vscode.commands.executeCommand('vscode.open', remoteUri(node.server.id, node.path));
  };

  return [
    vscode.commands.registerCommand(
      'iremote.remote.switchServer',
      guarded('Choose server', async () => {
        const sel = tree.currentServer?.id;
        const picked = await vscode.window.showQuickPick(
          config.uniqueServers().map((sv) => ({
            label: `${sv.id === sel ? '$(check) ' : ''}${sv.name}`,
            description: `${SERVER_TYPE_LABELS[sv.type]} · ${sv.type === 'local' ? sv.rootPath : sv.host}`,
            id: sv.id,
          })),
          { placeHolder: 'Show which server in Remote Host?' },
        );
        if (picked) await tree.selectServer(picked.id);
      }),
    ),

    vscode.commands.registerCommand('iremote.remote.refresh', (node?: RemoteNode) => tree.refresh(node && node.kind !== 'error' ? node : undefined)),
    vscode.commands.registerCommand('iremote.remote.collapseAll', () =>
      vscode.commands.executeCommand('workbench.actions.treeView.iremote.remoteHost.collapseAll'),
    ),

    vscode.commands.registerCommand(
      'iremote.remote.open',
      guarded('Open remote file', async (node?: RemoteNode) => {
        const [n] = selection(node);
        if (n?.kind !== 'entry' || isDirStat(n.stat)) return;
        const behavior = vscode.workspace.getConfiguration('iremote').get<string>('remoteHost.openBehavior', 'remote');
        await openEntry(n, behavior === 'localIfMapped');
      }),
    ),

    vscode.commands.registerCommand(
      'iremote.remote.openLocal',
      guarded('Open local file', async (node?: RemoteNode) => {
        const [n] = selection(node);
        if (n?.kind !== 'entry') return;
        const local = config.target(n.server).mapper.toLocal(n.path);
        if (!local) return;
        if (!(await fs.stat(local).then(() => true, () => false))) {
          const c = await vscode.window.showInformationMessage(`${basename(local)} does not exist locally.`, 'Download');
          if (c) await vscode.commands.executeCommand('iremote.remote.download', n);
          return;
        }
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(local));
      }),
    ),

    vscode.commands.registerCommand(
      'iremote.remote.newFile',
      guarded('New file', async (node?: RemoteNode) => {
        const [n] = selection(node);
        if (!n) return;
        const dir = n.kind === 'server' || isDirStat(n.stat) ? nodePath(n) : posix.dirname(n.path);
        const name = await vscode.window.showInputBox({ prompt: `New file in ${dir}`, validateInput: validName });
        if (!name) return;
        const uri = remoteUri(n.server.id, posix.join(dir, name));
        const parentDir = posix.dirname(uri.path);
        if (parentDir !== dir) await vscode.workspace.fs.createDirectory(remoteUri(n.server.id, parentDir));
        await vscode.workspace.fs.writeFile(uri, new Uint8Array());
        tree.refresh(n.kind === 'server' || isDirStat(n.stat) ? n : parentOf(n));
        await vscode.commands.executeCommand('vscode.open', uri);
      }),
    ),

    vscode.commands.registerCommand(
      'iremote.remote.newFolder',
      guarded('New folder', async (node?: RemoteNode) => {
        const [n] = selection(node);
        if (!n) return;
        const dir = n.kind === 'server' || isDirStat(n.stat) ? nodePath(n) : posix.dirname(n.path);
        const name = await vscode.window.showInputBox({ prompt: `New folder in ${dir}`, validateInput: validName });
        if (!name) return;
        await deployer.mkdir(config.target(n.server), posix.join(dir, name));
        tree.refresh(n.kind === 'server' || isDirStat(n.stat) ? n : parentOf(n));
      }),
    ),

    vscode.commands.registerCommand(
      'iremote.remote.rename',
      guarded('Rename', async (node?: RemoteNode) => {
        const [n] = selection(node);
        if (n?.kind !== 'entry') return;
        const oldName = posix.basename(n.path);
        const name = await vscode.window.showInputBox({
          prompt: `Rename ${n.path}`,
          value: oldName,
          valueSelection: [0, oldName.lastIndexOf('.') > 0 ? oldName.lastIndexOf('.') : oldName.length],
          validateInput: (v) => (v.includes('/') ? 'Use the Remote Host drag and drop to move files' : validName(v)),
        });
        if (!name || name === oldName) return;
        const to = posix.join(posix.dirname(n.path), name);
        const exists = await servers.pool(n.server).use((c) => c.stat(to));
        if (exists) {
          const ok = await vscode.window.showWarningMessage(`${name} already exists. Replace it?`, { modal: true }, 'Replace');
          if (!ok) return;
        }
        await deployer.renameRemote(config.target(n.server), n.path, to);
        s.fsProvider.notifyChanged([remoteUri(n.server.id, n.path), remoteUri(n.server.id, to)]);
        tree.refresh(parentOf(n));
      }),
    ),

    vscode.commands.registerCommand(
      'iremote.remote.delete',
      guarded('Delete', async (node?: RemoteNode, nodes?: RemoteNode[]) => {
        const items = selection(node, nodes).filter((n): n is EntryNode => n.kind === 'entry');
        if (items.length === 0) return;
        const server = items[0].server;
        if (server.project.config.options.confirmRemoteDelete) {
          const what = items.length === 1 ? `"${items[0].path}"` : `${items.length} items`;
          const ok = await vscode.window.showWarningMessage(
            `Delete ${what} on ${server.name}?`,
            { modal: true, detail: items.some((i) => isDirStat(i.stat)) ? 'Folders are deleted with all their contents. This cannot be undone.' : 'This cannot be undone.' },
            'Delete',
          );
          if (!ok) return;
        }
        await Promise.all(items.map((i) => deployer.deleteRemote(config.target(i.server), i.path, i.stat.type === 'dir')));
        s.fsProvider.notifyChanged(items.map((i) => remoteUri(i.server.id, i.path)));
        new Set(items.map((i) => parentOf(i))).forEach((p) => tree.refresh(p));
      }),
    ),

    vscode.commands.registerCommand(
      'iremote.remote.download',
      guarded('Download', async (node?: RemoteNode, nodes?: RemoteNode[]) => {
        const items = selection(node, nodes);
        if (items.length === 0) return;
        const server = items[0].server;
        const base = config.target(server);
        const paths = items.map(nodePath);
        const mapped = paths.filter((p) => base.mapper.toLocal(p));
        if (mapped.length) {
          const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Downloading from ${server.name}` }, () =>
            deployer.download(base, mapped),
          );
          reportResult('Downloaded', server, result);
        }
        const unmapped = paths.filter((p) => !base.mapper.toLocal(p));
        if (unmapped.length) {
          const dest = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: 'Download Here',
            title: `${unmapped.length} item(s) are not mapped — choose a local folder`,
            defaultUri: server.project.folder.uri,
          });
          if (!dest?.[0]) return;
          const target = adHocTarget(base, unmapped.map((r) => ({ local: posix.join(dest[0].fsPath.replace(/\\/g, '/'), remoteBasename(r)), remote: r })));
          const result = await deployer.download(target, unmapped);
          reportResult('Downloaded', server, result);
        }
      }),
    ),

    vscode.commands.registerCommand(
      'iremote.remote.uploadHere',
      guarded('Upload', async (node?: RemoteNode) => {
        const [n] = selection(node);
        if (!n) return;
        const dir = n.kind === 'server' || isDirStat(n.stat) ? nodePath(n) : posix.dirname(n.path);
        const files = await vscode.window.showOpenDialog({
          canSelectMany: true,
          canSelectFiles: true,
          canSelectFolders: true,
          openLabel: 'Upload',
          title: `Upload to ${n.server.name}:${dir}`,
          defaultUri: n.server.project.folder.uri,
        });
        if (!files?.length) return;
        await uploadInto(n.server, dir, files);
        tree.refresh(n.kind === 'server' || isDirStat(n.stat) ? n : parentOf(n));
      }),
    ),

    vscode.commands.registerCommand(
      'iremote.remote.compareWithLocal',
      guarded('Compare', async (node?: RemoteNode) => {
        const [n] = selection(node);
        if (n?.kind !== 'entry') return;
        const local = config.target(n.server).mapper.toLocal(n.path);
        if (!local) return;
        if (!(await fs.stat(local).then(() => true, () => false))) {
          return void vscode.window.showInformationMessage(`${basename(local)} does not exist locally.`);
        }
        await vscode.commands.executeCommand('vscode.diff', remoteUri(n.server.id, n.path), vscode.Uri.file(local), `${posix.basename(n.path)} (${n.server.name} ↔ Local)`);
      }),
    ),

    vscode.commands.registerCommand(
      'iremote.remote.syncWithLocal',
      guarded('Sync', async (node?: RemoteNode) => {
        const [n] = selection(node);
        if (!n) return;
        const target = config.target(n.server);
        const localRoots = n.kind === 'server' ? target.mapper.localRoots : [target.mapper.toLocal(n.path)].filter((p): p is string => !!p);
        if (localRoots.length === 0) return void vscode.window.showWarningMessage('This remote folder is not mapped to a local folder.');
        SyncPanel.show(s, n.server, localRoots);
      }),
    ),

    vscode.commands.registerCommand('iremote.remote.copyPath', async (node?: RemoteNode, nodes?: RemoteNode[]) => {
      const items = selection(node, nodes);
      if (items.length) await vscode.env.clipboard.writeText(items.map(nodePath).join('\n'));
    }),

    vscode.commands.registerCommand('iremote.remote.copyWebUrl', async (node?: RemoteNode) => {
      const [n] = selection(node);
      const url = n && config.target(n.server).mapper.webUrlForRemote(nodePath(n));
      if (url) await vscode.env.clipboard.writeText(url);
    }),

    vscode.commands.registerCommand('iremote.remote.openInBrowser', async (node?: RemoteNode) => {
      const [n] = selection(node);
      const url = n && config.target(n.server).mapper.webUrlForRemote(nodePath(n));
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand(
      'iremote.remote.chmod',
      guarded('Change permissions', async (node?: RemoteNode, nodes?: RemoteNode[]) => {
        const items = selection(node, nodes).filter((n): n is EntryNode => n.kind === 'entry');
        if (items.length === 0) return;
        const current = items[0].stat.mode;
        const value = await vscode.window.showInputBox({
          prompt: `Permissions (octal) for ${items.length === 1 ? items[0].path : `${items.length} items`}`,
          value: current !== undefined ? current.toString(8).padStart(3, '0') : '644',
          validateInput: (v) => (/^[0-7]{3,4}$/.test(v.trim()) ? undefined : 'Enter an octal mode such as 644 or 0755'),
        });
        if (!value) return;
        const mode = parseInt(value.trim(), 8);
        let recursive = false;
        if (items.some((i) => isDirStat(i.stat))) {
          const scope = await vscode.window.showQuickPick(['Only the selected items', 'Selected items and everything inside folders'], {
            placeHolder: 'Apply to…',
          });
          if (!scope) return;
          recursive = scope.startsWith('Selected items and');
        }
        for (const item of items) {
          const target = config.target(item.server);
          await deployer.chmod(target, item.path, mode);
          if (recursive && isDirStat(item.stat)) {
            const { files, dirs } = await deployer.withClient(target, (c) => deployer.collectRemote(c, target, item.path));
            await Promise.all([...dirs.filter((d) => d !== item.path), ...files.map((f) => f.path)].map((p) => deployer.chmod(target, p, mode)));
          }
        }
        new Set(items.map((i) => parentOf(i))).forEach((p) => tree.refresh(p));
      }),
    ),

    vscode.commands.registerCommand('iremote.remote.revealLocal', async (node?: RemoteNode) => {
      const [n] = selection(node);
      if (!n) return;
      const local = config.target(n.server).mapper.toLocal(nodePath(n));
      if (local) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(local));
    }),

    vscode.commands.registerCommand(
      'iremote.remote.mountWorkspace',
      guarded('Add workspace folder', async (node?: RemoteNode) => {
        const [n] = selection(node);
        if (!n) return;
        const path = nodePath(n);
        const uri = remoteUri(n.server.id, path);
        const count = vscode.workspace.workspaceFolders?.length ?? 0;
        if (vscode.workspace.workspaceFolders?.some((f) => f.uri.toString() === uri.toString())) return;
        vscode.workspace.updateWorkspaceFolders(count, 0, { uri, name: `${n.server.name}: ${path}` });
      }),
    ),
  ];
};
