import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import type { ConfigStore, Project, ResolvedServer } from '../config/ConfigStore';
import type { Deployer, DeploymentTarget, TransferResult } from '../core/Deployer';
import { isRemoteError, errorMessage } from '../protocol/types';
import { log } from '../util/log';

const EDITOR_SAVE_WINDOW_MS = 3000;
const WATCH_DEBOUNCE_MS = 400;

/**
 * Implements PhpStorm's "Upload changed files automatically to the default server" together with
 * "Skip external changes" and "Delete remote files when local are deleted".
 */
export class AutoUploader implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private watchers: vscode.Disposable[] = [];
  private readonly saveReasons = new Map<string, vscode.TextDocumentSaveReason>();
  private readonly editorSaves = new Map<string, number>();
  private readonly pendingWatch = new Map<string, NodeJS.Timeout>();
  private readonly pendingDeleteTypes = new Map<string, boolean>();
  private readonly statusEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this.statusEmitter.event;

  constructor(
    private readonly config: ConfigStore,
    private readonly deployer: Deployer,
  ) {
    this.disposables.push(
      this.statusEmitter,
      vscode.workspace.onWillSaveTextDocument((e) => this.saveReasons.set(e.document.uri.toString(), e.reason)),
      vscode.workspace.onDidSaveTextDocument((doc) => void this.onSaved(doc)),
      vscode.workspace.onDidCreateFiles((e) => void this.onCreated(e.files)),
      vscode.workspace.onWillDeleteFiles((e) => e.waitUntil(this.captureDeleteTypes(e.files))),
      vscode.workspace.onDidDeleteFiles((e) => void this.onDeleted(e.files, false)),
      vscode.workspace.onDidRenameFiles((e) => void this.onRenamed(e.files)),
      config.onDidChange(() => this.rewatch()),
    );
    this.rewatch();
  }

  /** Default server target for a local file if auto-upload applies to it. */
  private targetFor(uri: vscode.Uri): { project: Project; server: ResolvedServer; target: DeploymentTarget } | undefined {
    if (uri.scheme !== 'file') return undefined;
    const project = this.config.projectFor(uri);
    if (!project || project.config.options.autoUpload === 'never') return undefined;
    const server = this.config.defaultServer(project);
    if (!server) return undefined;
    return { project, server, target: this.config.target(server) };
  }

  isEnabled(project: Project): boolean {
    return project.config.options.autoUpload !== 'never' && !!this.config.defaultServer(project);
  }

  private async onSaved(doc: vscode.TextDocument): Promise<void> {
    const key = doc.uri.toString();
    const reason = this.saveReasons.get(key) ?? vscode.TextDocumentSaveReason.Manual;
    this.saveReasons.delete(key);
    this.editorSaves.set(doc.uri.fsPath, Date.now());
    // A watcher event queued before this save (e.g. the file was just written) would upload it a second time.
    this.cancelPendingWatch(doc.uri.fsPath);
    const hit = this.targetFor(doc.uri);
    if (!hit) return;
    if (hit.project.config.options.autoUpload === 'onExplicitSave' && reason !== vscode.TextDocumentSaveReason.Manual) return;
    await this.upload(hit.target, [doc.uri.fsPath]);
  }

  private async upload(target: DeploymentTarget, paths: string[]): Promise<void> {
    const deployable = paths.filter((p) => target.mapper.isDeployable(p) && !this.deployer.isOwnLocalWrite(p));
    if (deployable.length === 0) return;
    const checkConflict = target.options.warnOnNewerRemote !== 'none';
    try {
      const result = deployable.length === 1 && (await fs.stat(deployable[0]).then((s) => s.isFile(), () => false))
        ? await this.deployer.uploadFile(target, deployable[0], checkConflict)
        : await this.deployer.upload(target, deployable, checkConflict);
      this.report(target, result);
    } catch (e) {
      if (!isRemoteError(e, 'Cancelled')) this.fail(target, `Automatic upload to ${target.server.name} failed`, e);
    }
  }

  private report(target: DeploymentTarget, result: TransferResult): void {
    if (result.transferred) log.info(`Automatic upload: ${result.transferred} file(s) → ${target.server.name}`);
    if (result.failed.length) {
      const first = result.failed[0];
      this.fail(target, `Automatic upload of ${result.failed.length} file(s) to ${target.server.name} failed`, first.error, first.path);
    }
  }

  private fail(target: DeploymentTarget, message: string, error: unknown, path?: string): void {
    log.error(`${message}${path ? ` (${path})` : ''}`, error);
    void vscode.window.showErrorMessage(`${message}: ${errorMessage(error)}`, 'Show Log', 'Retry').then((choice) => {
      if (choice === 'Show Log') log.show();
      if (choice === 'Retry' && path) void this.upload(target, [path]);
    });
  }

  private async onCreated(files: readonly vscode.Uri[]): Promise<void> {
    for (const uri of files) {
      const hit = this.targetFor(uri);
      if (!hit || hit.project.config.options.autoUpload !== 'always') continue;
      this.editorSaves.set(uri.fsPath, Date.now());
      await this.upload(hit.target, [uri.fsPath]);
    }
  }

  private async captureDeleteTypes(files: readonly vscode.Uri[]): Promise<void> {
    await Promise.all(
      files.map(async (uri) => {
        if (uri.scheme !== 'file') return;
        const isDir = await fs.stat(uri.fsPath).then((s) => s.isDirectory(), () => false);
        this.pendingDeleteTypes.set(uri.fsPath, isDir);
      }),
    );
  }

  private async onDeleted(files: readonly vscode.Uri[], external: boolean): Promise<void> {
    for (const uri of files) {
      const isDir = this.pendingDeleteTypes.get(uri.fsPath);
      this.pendingDeleteTypes.delete(uri.fsPath);
      const hit = this.targetFor(uri);
      if (!hit || !hit.project.config.options.deleteRemoteOnLocalDelete) continue;
      if (external && hit.project.config.options.skipExternalChanges) continue;
      const remote = hit.target.mapper.toRemote(uri.fsPath);
      if (!remote || hit.target.mapper.isLocalExcluded(uri.fsPath)) continue;
      try {
        await this.deployer.deleteRemote(hit.target, remote, isDir ?? (await this.remoteIsDir(hit.target, remote)));
        log.info(`Deleted ${remote} on ${hit.server.name}`);
      } catch (e) {
        if (!isRemoteError(e, 'Cancelled')) this.fail(hit.target, `Deleting ${remote} on ${hit.server.name} failed`, e);
      }
    }
  }

  private async remoteIsDir(target: DeploymentTarget, remote: string): Promise<boolean> {
    return this.deployer.withClient(target, async (c) => (await c.stat(remote))?.type === 'dir');
  }

  private async onRenamed(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
    for (const { oldUri, newUri } of files) {
      const hit = this.targetFor(newUri) ?? this.targetFor(oldUri);
      if (!hit) continue;
      const { mapper } = hit.target;
      const from = mapper.isLocalExcluded(oldUri.fsPath) ? undefined : mapper.toRemote(oldUri.fsPath);
      const to = mapper.isLocalExcluded(newUri.fsPath) ? undefined : mapper.toRemote(newUri.fsPath);
      this.editorSaves.set(newUri.fsPath, Date.now());
      try {
        if (from && to) {
          await this.deployer.renameRemote(hit.target, from, to);
          log.info(`Renamed ${from} → ${to} on ${hit.server.name}`);
        } else if (to) {
          await this.upload(hit.target, [newUri.fsPath]);
        } else if (from && hit.project.config.options.deleteRemoteOnLocalDelete) {
          const isDir = await fs.stat(newUri.fsPath).then((s) => s.isDirectory(), () => false);
          await this.deployer.deleteRemote(hit.target, from, isDir);
        }
      } catch (e) {
        if (!isRemoteError(e, 'Cancelled')) this.fail(hit.target, `Renaming on ${hit.server.name} failed`, e);
      }
    }
  }

  /** External changes (git, build tools) are only deployed when "Skip external changes" is off and mode is Always. */
  private rewatch(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    for (const project of this.config.projects) {
      const o = project.config.options;
      if (o.autoUpload !== 'always' || o.skipExternalChanges || !this.config.defaultServer(project)) continue;
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project.folder, '**/*'));
      w.onDidChange((u) => this.onExternal(u));
      w.onDidCreate((u) => this.onExternal(u));
      w.onDidDelete((u) => void this.onDeleted([u], true));
      this.watchers.push(w);
    }
    this.statusEmitter.fire();
  }

  private cancelPendingWatch(path: string): void {
    const pending = this.pendingWatch.get(path);
    if (!pending) return;
    clearTimeout(pending);
    this.pendingWatch.delete(path);
  }

  private onExternal(uri: vscode.Uri): void {
    const path = uri.fsPath;
    const saved = this.editorSaves.get(path);
    if (saved && Date.now() - saved < EDITOR_SAVE_WINDOW_MS) return;
    if (this.deployer.isOwnLocalWrite(path)) return;
    const existing = this.pendingWatch.get(path);
    if (existing) clearTimeout(existing);
    this.pendingWatch.set(
      path,
      setTimeout(() => {
        this.pendingWatch.delete(path);
        const hit = this.targetFor(uri);
        if (!hit) return;
        void fs.stat(path).then(
          (s) => (s.isFile() ? this.upload(hit.target, [path]) : undefined),
          () => undefined,
        );
      }, WATCH_DEBOUNCE_MS),
    );
  }

  dispose(): void {
    this.pendingWatch.forEach((t) => clearTimeout(t));
    this.watchers.forEach((w) => w.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}
