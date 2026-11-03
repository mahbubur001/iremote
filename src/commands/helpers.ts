import * as vscode from 'vscode';
import { posix } from 'node:path';
import type { ConfigStore, Project, ResolvedServer } from '../config/ConfigStore';
import { SERVER_TYPE_LABELS } from '../config/schema';
import type { DeploymentTarget, TransferResult } from '../core/Deployer';
import { PathMapper } from '../core/PathMapper';
import { errorMessage, isRemoteError } from '../protocol/types';
import { log } from '../util/log';

/** Wraps a command so errors surface once, cancellations stay silent, and details land in the log. */
export const guarded =
  <A extends unknown[]>(name: string, fn: (...args: A) => Promise<unknown> | unknown) =>
  async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (e) {
      if (isRemoteError(e, 'Cancelled')) return;
      log.error(`${name} failed`, e);
      const choice = await vscode.window.showErrorMessage(`${name}: ${errorMessage(e)}`, 'Show Log');
      if (choice === 'Show Log') log.show();
    }
  };

/** Explorer passes (clicked, selection); editor menus pass the document URI; the palette passes nothing. */
export const resolveTargets = (uri?: vscode.Uri, uris?: vscode.Uri[]): vscode.Uri[] => {
  const list = uris?.length ? uris : uri ? [uri] : [];
  if (list.length) return list.filter((u) => u.scheme === 'file');
  const active = vscode.window.activeTextEditor?.document.uri;
  return active?.scheme === 'file' ? [active] : [];
};

export const groupByProject = (config: ConfigStore, uris: vscode.Uri[]): Map<Project, string[]> => {
  const map = new Map<Project, string[]>();
  for (const u of uris) {
    const p = config.projectFor(u);
    if (!p) continue;
    map.set(p, [...(map.get(p) ?? []), u.fsPath]);
  }
  return map;
};

export const pickServer = async (config: ConfigStore, project: Project, placeHolder: string): Promise<ResolvedServer | undefined> => {
  const servers = config.servers(project);
  if (servers.length === 0) {
    const choice = await vscode.window.showWarningMessage(`No deployment servers are configured for ${project.folder.name}.`, 'Configure…');
    if (choice) await vscode.commands.executeCommand('iremote.openSettings');
    return undefined;
  }
  if (servers.length === 1) return servers[0];
  const picked = await vscode.window.showQuickPick(
    servers.map((s) => ({
      label: s.name,
      description: `${SERVER_TYPE_LABELS[s.type]} · ${s.type === 'local' ? s.rootPath : s.host}`,
      detail: s.id === project.config.defaultServer ? '$(star-full) Default server' : undefined,
      server: s,
    })),
    { placeHolder, matchOnDescription: true },
  );
  return picked?.server;
};

export const defaultOrPick = async (config: ConfigStore, project: Project, placeHolder: string): Promise<ResolvedServer | undefined> =>
  config.defaultServer(project) ?? pickServer(config, project, placeHolder);

/** Report the outcome of a batch transfer without spamming notifications for routine success. */
export const reportResult = (verb: string, server: ResolvedServer, result: TransferResult): void => {
  const parts = [`${verb} ${result.transferred} file(s) ${verb === 'Uploaded' ? 'to' : 'from'} ${server.name}`];
  if (result.skipped) parts.push(`${result.skipped} skipped`);
  if (result.failed.length === 0) {
    vscode.window.setStatusBarMessage(`$(check) ${parts.join(', ')}`, 5000);
    log.info(parts.join(', '));
    return;
  }
  result.failed.forEach((f) => log.error(`${f.path}`, f.error));
  void vscode.window
    .showErrorMessage(`${parts.join(', ')}; ${result.failed.length} failed: ${errorMessage(result.failed[0].error)}`, 'Show Log')
    .then((c) => c && log.show());
};

/**
 * Builds a deployment target with ad-hoc mappings, used for transfers between arbitrary local folders and remote
 * folders that are not covered by the configured mappings (Remote Host "Upload here" / unmapped downloads).
 */
export const adHocTarget = (base: DeploymentTarget, pairs: { local: string; remote: string }[]): DeploymentTarget => {
  const server = { ...base.server, rootPath: '/', mappings: pairs.map((p) => ({ local: p.local, remote: p.remote, web: '/' })), excludedLocal: [], excludedRemote: [] };
  return { ...base, server, mapper: new PathMapper(base.projectRoot, server, base.options.excludeNames) };
};

export const remoteBasename = (p: string): string => posix.basename(p) || p;
