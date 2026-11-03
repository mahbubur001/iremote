import * as vscode from 'vscode';
import type { ConfigStore } from '../config/ConfigStore';
import { parseRemoteUri, SCHEME } from '../fs/uri';

/** Greys out remote paths that are excluded from deployment or not mapped to the project. */
export class Decorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly config: ConfigStore) {
    this.disposables.push(this.emitter, vscode.window.registerFileDecorationProvider(this), config.onDidChange(() => this.emitter.fire(undefined)));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SCHEME) return undefined;
    const { serverId, path } = parseRemoteUri(uri);
    const server = this.config.findServer(serverId);
    if (!server) return undefined;
    const mapper = this.config.target(server).mapper;
    if (!mapper.hasMappings) return undefined;
    if (mapper.isRemoteExcluded(path)) {
      return { tooltip: 'Excluded from deployment', color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground') };
    }
    if (!mapper.toLocal(path)) {
      return { tooltip: 'Not mapped to a local path', color: new vscode.ThemeColor('disabledForeground') };
    }
    return undefined;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
