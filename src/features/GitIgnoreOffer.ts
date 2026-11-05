import * as vscode from 'vscode';
import type { ConfigStore, Project } from '../config/ConfigStore';
import { CONFIG_RELATIVE_PATH } from '../config/ConfigStore';
import { addToGitignore, gitFileStatus } from '../util/git';
import { log } from '../util/log';

const SETTING = 'git.offerToIgnoreConfig';
const decisionKey = (project: Project) => `iremote.gitignoreDecision:${project.root}`;

/**
 * When iRemote creates .vscode/iremote.json inside a git repository, asks once whether to ignore it — like deciding
 * whether to share PhpStorm's .idea/deployment.xml. The file holds mappings and server settings, never passwords.
 */
export class GitIgnoreOffer implements vscode.Disposable {
  private readonly disposable: vscode.Disposable;

  constructor(
    config: ConfigStore,
    private readonly state: vscode.Memento,
  ) {
    this.disposable = config.onDidCreateProjectConfig((p) => void this.offer(p));
  }

  private async offer(project: Project): Promise<void> {
    if (!vscode.workspace.getConfiguration('iremote').get<boolean>(SETTING, true)) return;
    if (this.state.get(decisionKey(project))) return;
    const file = project.configUri.fsPath;
    const status = await gitFileStatus(file);
    if (!status || status.ignored || status.tracked) return;

    const choice = await vscode.window.showInformationMessage(
      `iRemote saved its settings to ${CONFIG_RELATIVE_PATH} in "${project.folder.name}". Add it to .gitignore?`,
      {
        detail:
          'The file holds mappings and server settings (host, user, paths) but never passwords. Commit it to share the setup with your team, or ignore it to keep it private.',
      },
      'Add to .gitignore',
      'Keep in Git',
      "Don't Ask Again",
    );
    if (choice === 'Add to .gitignore') {
      try {
        const entry = await addToGitignore(status.root, file);
        await this.state.update(decisionKey(project), 'ignore');
        log.info(`Added ${entry} to ${status.root}/.gitignore`);
      } catch (e) {
        void vscode.window.showErrorMessage(`Could not update .gitignore: ${(e as Error).message}`);
      }
    } else if (choice === 'Keep in Git') {
      await this.state.update(decisionKey(project), 'keep');
    } else if (choice === "Don't Ask Again") {
      await vscode.workspace.getConfiguration('iremote').update(SETTING, false, vscode.ConfigurationTarget.Global);
    }
  }

  dispose(): void {
    this.disposable.dispose();
  }
}
