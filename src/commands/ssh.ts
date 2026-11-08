import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Services } from '../services';
import type { ServerConfig } from '../config/schema';
import { findIdeOptionsDirs, parseSshConfigs, type ImportedSshConfig } from '../config/PhpStormImporter';
import {
  authorizedKeysCommand,
  describe,
  fromDestination,
  fromServer,
  fromSshConfigAlias,
  hostKey,
  phpStormSshToServer,
  mergeHosts,
  parseDestination,
  parseOpenSshHosts,
  parsePublicKey,
  type Destination,
  type SshHost,
} from '../ssh/hosts';
import { SshTerminal } from '../ssh/SshTerminal';
import { isDirStat, nodePath, type RemoteNode } from '../views/RemoteHostTree';
import { posix } from 'node:path';
import { guarded } from './helpers';

const RECENT_KEY = 'iremote.ssh.recent';
const KEYS_KEY = 'iremote.ssh.installedKeys';
const MAX_RECENT = 20;
export const SSH_PROFILE_ID = 'iremote.ssh';

const SOURCE_LABELS: Record<SshHost['source'], string> = {
  iremote: 'iRemote',
  sshconfig: '~/.ssh/config',
  recent: 'recent',
};

const readIf = (p: string): Promise<string | undefined> => fs.readFile(p, 'utf8').then((t) => t, () => undefined);

type PickItem = vscode.QuickPickItem & { host?: SshHost; action?: 'new' | 'settings' | 'import' };

export class SshSessions {
  private readonly keyButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('key'), tooltip: 'Install Public Key on Host…' };
  private readonly forgetButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: 'Remove from Recent' };

  constructor(private readonly s: Services) {}

  private get state(): vscode.Memento {
    return this.s.context.globalState;
  }

  /** PhpStorm SSH configurations: .idea/sshConfigs.xml of open folders plus the newest IDE's options/sshConfigs.xml. */
  private async phpStormSshConfigs(): Promise<ImportedSshConfig[]> {
    const files = (vscode.workspace.workspaceFolders ?? []).map((f) => join(f.uri.fsPath, '.idea', 'sshConfigs.xml'));
    for (const dir of await findIdeOptionsDirs()) {
      const file = join(dir, 'sshConfigs.xml');
      if (await readIf(file)) {
        files.push(file);
        break;
      }
    }
    const configs: ImportedSshConfig[] = [];
    for (const file of files) {
      const xml = await readIf(file);
      if (xml) for (const c of parseSshConfigs(xml)) if (!configs.some((x) => x.id === c.id)) configs.push(c);
    }
    return configs;
  }

  /** One-time copy of PhpStorm's SSH configurations into iRemote's global servers (skips hosts already there). */
  async importPhpStorm(): Promise<void> {
    const configs = await this.phpStormSshConfigs();
    if (configs.length === 0) {
      void vscode.window.showInformationMessage('No PhpStorm SSH configurations found.');
      return;
    }
    const existing = this.s.config.globalServers;
    const taken = new Set(existing.flatMap((sv) => [sv.id, hostKey(sv.username, sv.host, sv.port)]));
    const added = configs.map(phpStormSshToServer).filter((sv) => !taken.has(sv.id) && !taken.has(hostKey(sv.username, sv.host, sv.port)));
    if (added.length === 0) {
      void vscode.window.showInformationMessage('All PhpStorm SSH configurations are already in iRemote.');
      return;
    }
    await this.s.config.saveGlobal({ version: 1, servers: [...existing, ...added] });
    void vscode.window.showInformationMessage(
      `Imported ${added.length} PhpStorm SSH configuration${added.length === 1 ? '' : 's'} as global servers. Each password is asked once and saved in the keychain.`,
    );
  }

  async hosts(): Promise<SshHost[]> {
    const configured = new Map<string, { server: ServerConfig; scope: 'project' | 'global' }>();
    // Global servers are listed even when no open project uses them; a session needs no mappings.
    const global = this.s.config.globalServers.map((sv): ServerConfig => ({ ...sv, mappings: [], excludedLocal: [], excludedRemote: [] }));
    const projectServers = this.s.config.uniqueServers().filter((sv) => sv.scope === 'project');
    for (const [list, scope] of [[projectServers, 'project'], [global, 'global']] as const) {
      for (const sv of list) if (sv.type === 'sftp' && !configured.has(sv.id)) configured.set(sv.id, { server: sv, scope });
    }
    const sshConfig = await readIf(join(homedir(), '.ssh', 'config'));
    const recent = this.state.get<Destination[]>(RECENT_KEY, []);
    return mergeHosts(
      [
        [...configured.values()].map((c) => fromServer(c.server, c.scope)),
        sshConfig ? parseOpenSshHosts(sshConfig).map(fromSshConfigAlias) : [],
        recent.map(fromDestination),
      ],
      this.state.get<Record<string, string>>(KEYS_KEY, {}),
    );
  }

  /** The Start SSH Session list. Resolves to a host, or undefined when cancelled. */
  async pickHost(title = 'Start SSH Session'): Promise<SshHost | undefined> {
    const qp = vscode.window.createQuickPick<PickItem>();
    qp.title = title;
    qp.placeholder = 'Select a host, or type user@host:port';
    qp.matchOnDescription = true;
    qp.busy = true;
    qp.show();

    const build = async () => {
      const hosts = await this.hosts();
      qp.items = [
        ...hosts.map((h): PickItem => {
          const where = describe(h.server);
          return {
            label: `$(${h.server.auth === 'key' || h.server.auth === 'agent' ? 'key' : 'remote'}) ${h.label}`,
            description: [h.label === where ? '' : where, h.scope ?? SOURCE_LABELS[h.source]].filter(Boolean).join(' · '),
            host: h,
            buttons: h.source === 'recent' ? [this.keyButton, this.forgetButton] : h.server.auth === 'openssh' ? [] : [this.keyButton],
          };
        }),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        ...(hosts.some((h) => h.source === 'iremote')
          ? []
          : [{ label: '$(cloud-download) Import PhpStorm SSH Configurations…', action: 'import' as const, alwaysShow: true }]),
        { label: '$(add) New SSH Session…', action: 'new', alwaysShow: true },
        { label: '$(gear) Deployment Settings…', action: 'settings', alwaysShow: true },
      ];
      qp.busy = false;
    };
    await build();

    return new Promise<SshHost | undefined>((resolve) => {
      let done = false;
      const finish = (h: SshHost | undefined) => {
        if (done) return;
        done = true;
        resolve(h);
        qp.dispose();
      };
      qp.onDidTriggerItemButton(async ({ item, button }) => {
        if (!item.host) return;
        if (button === this.forgetButton) {
          const recent = this.state.get<Destination[]>(RECENT_KEY, []).filter((d) => fromDestination(d).key !== item.host?.key);
          await this.state.update(RECENT_KEY, recent);
          await build();
          return;
        }
        const host = item.host;
        finish(undefined);
        void guarded('Install public key', () => this.installKey(host))();
      });
      qp.onDidAccept(async () => {
        const item = qp.selectedItems[0];
        if (item?.host) return finish(item.host);
        if (item?.action === 'import') {
          qp.busy = true;
          await guarded('Import PhpStorm SSH configurations', () => this.importPhpStorm())();
          await build();
          return;
        }
        if (item?.action === 'settings') {
          finish(undefined);
          void vscode.commands.executeCommand('iremote.openSettings');
          return;
        }
        const typed = item?.action === 'new' ? await this.askDestination(qp.value) : parseDestination(qp.value);
        if (!typed) {
          if (item?.action === 'new') finish(undefined);
          return;
        }
        finish(await this.remember(typed));
      });
      qp.onDidHide(() => finish(undefined));
    });
  }

  private async askDestination(value: string): Promise<Destination | undefined> {
    const input = await vscode.window.showInputBox({
      title: 'New SSH Session',
      prompt: 'user@host:port (port defaults to 22)',
      value: parseDestination(value) ? value : '',
      ignoreFocusOut: true,
      validateInput: (v) => (parseDestination(v) ? undefined : 'Use user@host or user@host:port'),
    });
    return input === undefined ? undefined : parseDestination(input);
  }

  /** Adds a typed destination to the recent list (unless it matches a known host) and returns its host entry. */
  private async remember(d: Destination): Promise<SshHost> {
    const typed = fromDestination(d);
    const known = (await this.hosts()).find((h) => h.key === typed.key);
    if (known) return known;
    const recent = this.state.get<Destination[]>(RECENT_KEY, []).filter((r) => fromDestination(r).key !== typed.key);
    await this.state.update(RECENT_KEY, [d, ...recent].slice(0, MAX_RECENT));
    return typed;
  }

  terminal(host: SshHost, cwd?: string): SshTerminal {
    return new SshTerminal(host.server, this.s.servers, cwd);
  }

  /**
   * Opens next to the user's other terminals: as a tab in the active group when a terminal tab is active (the editor
   * title button), else in the group that already holds terminal tabs, else wherever terminals open by default.
   */
  private location(): vscode.ExtensionTerminalOptions['location'] {
    const isTerminal = (t: vscode.Tab | undefined) => t?.input instanceof vscode.TabInputTerminal;
    const { activeTabGroup, all } = vscode.window.tabGroups;
    if (isTerminal(activeTabGroup.activeTab)) return { viewColumn: activeTabGroup.viewColumn };
    const group = [...all].reverse().find((g) => g.tabs.some(isTerminal));
    if (group) return { viewColumn: group.viewColumn };
    return vscode.workspace.getConfiguration('terminal.integrated').get<string>('defaultLocation') === 'editor' ? vscode.TerminalLocation.Editor : undefined;
  }

  open(host: SshHost, cwd?: string): void {
    const location = this.location();
    const term = vscode.window.createTerminal({ name: host.label, pty: this.terminal(host, cwd), iconPath: new vscode.ThemeIcon('remote'), location });
    term.show();
  }

  async start(): Promise<void> {
    const host = await this.pickHost();
    if (host) this.open(host);
  }

  /** Opens a session for an iRemote server (Remote Host view), optionally in a remote directory. */
  async startOn(server: ServerConfig, cwd?: string): Promise<void> {
    const host = (await this.hosts()).find((h) => h.source === 'iremote' && h.server.id === server.id) ?? fromServer(server);
    this.open(host, cwd);
  }

  /** Public keys in ~/.ssh, ed25519 first. */
  private async publicKeys(): Promise<{ path: string; privatePath: string; key: string }[]> {
    const dir = join(homedir(), '.ssh');
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const found: { path: string; privatePath: string; key: string }[] = [];
    for (const name of names.filter((n) => n.endsWith('.pub'))) {
      const path = join(dir, name);
      const privatePath = path.slice(0, -'.pub'.length);
      const key = parsePublicKey((await readIf(path)) ?? '');
      const hasPrivate = await fs.access(privatePath).then(() => true, () => false);
      if (key && hasPrivate) found.push({ path, privatePath, key });
    }
    return found.sort((a, b) => Number(!a.key.startsWith('ssh-ed25519')) - Number(!b.key.startsWith('ssh-ed25519')));
  }

  /**
   * Installs a local public key in the host's ~/.ssh/authorized_keys (logging in with the current method, usually the
   * saved password), verifies a key login, then makes the SSH session list use that key for the host.
   */
  async installKey(host?: SshHost): Promise<void> {
    const target = host ?? (await this.pickHost('Install Public Key on SSH Host'));
    if (!target) return;
    const keys = await this.publicKeys();
    if (keys.length === 0) {
      void vscode.window.showErrorMessage('No SSH key pair found in ~/.ssh. Create one with: ssh-keygen -t ed25519');
      return;
    }
    const key =
      keys.length === 1
        ? keys[0]
        : (
            await vscode.window.showQuickPick(
              keys.map((k) => ({ label: k.path.replace(homedir(), '~'), description: k.key.split(' ')[0], k })),
              { title: `Install Public Key on ${target.label}` },
            )
          )?.k;
    if (!key) return;

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing ${key.path.replace(homedir(), '~')} on ${target.label}` }, async () => {
      const { client, cleanup } = await this.s.servers.connectShell(target.server);
      try {
        const res = await client.exec(authorizedKeysCommand(key.key));
        if (res.code !== 0) throw new Error(`the server rejected the command (exit ${res.code}): ${(res.stderr || res.stdout).trim() || 'no output'}`);
      } finally {
        await client.close();
        cleanup?.();
      }
      const keyServer: ServerConfig = { ...target.server, auth: 'key', privateKeyPath: key.privatePath };
      const check = await this.s.servers.connectShell(keyServer).catch((e: Error) => {
        throw new Error(`the key was added, but logging in with it failed: ${e.message}`);
      });
      await check.client.close();
      check.cleanup?.();
    });

    const installed = this.state.get<Record<string, string>>(KEYS_KEY, {});
    await this.state.update(KEYS_KEY, { ...installed, [target.key]: key.privatePath });
    const hasPassword = (await this.s.credentials.getStored(target.server.id, 'password')) !== undefined;
    const note = target.source === 'iremote' ? ' Deployment keeps its own authentication setting (Deployment Settings).' : '';
    const choice = await vscode.window.showInformationMessage(
      `SSH sessions to ${target.label} now log in with ${key.path.replace(homedir(), '~').replace(/\.pub$/, '')}.${note}`,
      ...(hasPassword && target.source !== 'iremote' ? ['Forget Saved Password'] : []),
    );
    if (choice === 'Forget Saved Password') await this.s.credentials.forget(target.server.id, 'password');
  }
}

export const registerSshCommands = (s: Services): { sessions: SshSessions; disposables: vscode.Disposable[] } => {
  const sessions = new SshSessions(s);
  const disposables = [
    vscode.commands.registerCommand('iremote.ssh.startSession', guarded('Start SSH session', () => sessions.start())),
    vscode.commands.registerCommand('iremote.ssh.importPhpStorm', guarded('Import PhpStorm SSH configurations', () => sessions.importPhpStorm())),
    vscode.commands.registerCommand('iremote.ssh.installPublicKey', guarded('Install public key', () => sessions.installKey())),
    vscode.commands.registerCommand(
      'iremote.remote.openSshSession',
      guarded('Start SSH session', async (node?: RemoteNode) => {
        const n = node ?? s.tree.treeView.selection[0];
        if (!n || n.kind === 'error') return;
        const dir = n.kind === 'server' || isDirStat(n.stat) ? nodePath(n) : posix.dirname(n.path);
        await sessions.startOn(n.server, dir);
      }),
    ),
    // "SSH Session…" in the terminal panel's new-terminal dropdown.
    vscode.window.registerTerminalProfileProvider(SSH_PROFILE_ID, {
      provideTerminalProfile: async () => {
        const host = await sessions.pickHost();
        if (!host) return undefined;
        return new vscode.TerminalProfile({ name: host.label, pty: sessions.terminal(host), iconPath: new vscode.ThemeIcon('remote') });
      },
    }),
  ];
  return { sessions, disposables };
};
