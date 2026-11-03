import * as vscode from 'vscode';
import type { ConfigStore, Project } from '../config/ConfigStore';
import type { TransferQueue } from '../core/TransferQueue';

/** Shows the default server and auto-upload mode for the active project, plus a live transfer counter. */
export class StatusBar implements vscode.Disposable {
  private readonly server: vscode.StatusBarItem;
  private readonly transfers: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly config: ConfigStore,
    private readonly queue: TransferQueue,
  ) {
    this.server = vscode.window.createStatusBarItem('iremote.server', vscode.StatusBarAlignment.Left, 50);
    this.server.name = 'iRemote Default Server';
    this.transfers = vscode.window.createStatusBarItem('iremote.transfers', vscode.StatusBarAlignment.Left, 49);
    this.transfers.name = 'iRemote Transfers';
    this.transfers.command = 'iremote.showTransferLog';
    const update = () => this.update();
    queue.on('changed', update);
    queue.on('idle', update);
    this.disposables.push(
      this.server,
      this.transfers,
      new vscode.Disposable(() => {
        queue.off('changed', update);
        queue.off('idle', update);
      }),
      config.onDidChange(update),
      vscode.window.onDidChangeActiveTextEditor(update),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('iremote.statusBar') && update()),
    );
    this.update();
  }

  private activeProject(): Project | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && this.config.projectFor(uri)) ?? this.config.projects.find((p) => p.exists) ?? this.config.projects[0];
  }

  private update(): void {
    const enabled = vscode.workspace.getConfiguration('iremote').get<boolean>('statusBar.enabled', true);
    const project = this.activeProject();
    if (!enabled || !project || this.config.servers(project).length === 0) {
      this.server.hide();
      this.transfers.hide();
      return;
    }
    const def = this.config.defaultServer(project);
    const mode = project.config.options.autoUpload;
    const auto = def && mode !== 'never';
    this.server.text = `$(${auto ? 'cloud-upload' : 'cloud'}) ${def ? def.name : 'No default server'}`;
    this.server.tooltip = new vscode.MarkdownString(
      `**iRemote** — ${project.folder.name}\n\nDefault server: ${def ? def.name : '—'}\n\nAutomatic upload: ${
        mode === 'always' ? 'Always' : mode === 'onExplicitSave' ? 'On explicit save' : 'Never'
      }\n\nClick to change the default server.`,
    );
    this.server.command = 'iremote.setDefaultServer';
    this.server.show();

    const pending = this.queue.pendingCount;
    const failed = this.queue.tasks.filter((t) => t.status === 'failed').length;
    if (pending) {
      this.transfers.text = `$(sync~spin) ${pending}`;
      this.transfers.tooltip = `${pending} transfer(s) in progress`;
      this.transfers.backgroundColor = undefined;
      this.transfers.show();
    } else if (failed) {
      this.transfers.text = `$(error) ${failed}`;
      this.transfers.tooltip = `${failed} failed transfer(s) — click to view`;
      this.transfers.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.transfers.show();
    } else {
      this.transfers.hide();
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
