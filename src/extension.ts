import * as vscode from 'vscode';
import { basename } from 'node:path';
import { ConfigStore } from './config/ConfigStore';
import { Credentials } from './config/Credentials';
import { ServerManager } from './core/ServerManager';
import { TransferQueue } from './core/TransferQueue';
import { StateCache } from './core/StateCache';
import { Deployer, type ConflictDecision, type ConflictInfo } from './core/Deployer';
import { SyncEngine } from './core/SyncEngine';
import { RemoteFileSystemProvider } from './fs/RemoteFileSystemProvider';
import { remoteUri } from './fs/uri';
import { RemoteHostTree } from './views/RemoteHostTree';
import { TransferView } from './views/TransferView';
import { StatusBar } from './views/StatusBar';
import { Decorations } from './views/Decorations';
import { AutoUploader } from './features/AutoUploader';
import { RemoteChangeMonitor } from './features/RemoteChangeMonitor';
import { GitIgnoreOffer } from './features/GitIgnoreOffer';
import { registerDeploymentCommands } from './commands/deployment';
import { registerRemoteCommands } from './commands/remote';
import { RemoteError } from './protocol/types';
import { log } from './util/log';
import type { Services } from './services';

let cache: StateCache | undefined;

/** Conflict prompts are shown one at a time even when several uploads run in parallel. */
const createConflictPrompt = (queue: TransferQueue) => {
  let chain: Promise<unknown> = Promise.resolve();
  const ask = async (info: ConflictInfo): Promise<ConflictDecision> => {
    const name = basename(info.localPath);
    for (;;) {
      const choice = await vscode.window.showWarningMessage(
        `"${name}" on ${info.target.server.name} has changed.`,
        {
          modal: true,
          detail: `${info.reason}\n\nRemote: ${info.remotePath}\nModified: ${info.remote.mtime ? new Date(info.remote.mtime).toLocaleString() : 'unknown'}, ${info.remote.size} bytes\n\nUploading will overwrite the remote version.`,
        },
        'Overwrite',
        'Compare',
        'Skip',
      );
      if (choice === 'Compare') {
        await vscode.commands.executeCommand(
          'vscode.diff',
          remoteUri(info.target.server.id, info.remotePath),
          vscode.Uri.file(info.localPath),
          `${name} (${info.target.server.name} ↔ Local)`,
        );
        continue;
      }
      if (choice === 'Overwrite') return 'overwrite';
      if (choice === 'Skip') return 'skip';
      void queue.cancel(info.target.server.id);
      throw new RemoteError('Cancelled', 'Upload cancelled.');
    }
  };
  return (info: ConflictInfo): Promise<ConflictDecision> => {
    const next = chain.then(() => ask(info));
    chain = next.catch(() => undefined);
    return next;
  };
};

const reportProblems = (config: ConfigStore): void => {
  const problems = config.problems;
  if (problems.length === 0) return;
  problems.forEach((p) => log.error(`Configuration: ${p}`));
  void vscode.window
    .showWarningMessage(`iRemote configuration: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}`, 'Show Log')
    .then((c) => c && log.show());
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log.init(context);

  const config = new ConfigStore(context);
  const credentials = new Credentials(context);
  const servers = new ServerManager(config, credentials);
  const queue = new TransferQueue(
    (id) => servers.poolById(id),
    (id) => config.findServer(id)?.project.config.options.concurrency ?? 4,
  );
  cache = new StateCache(vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'sync-state.json').fsPath);
  await Promise.all([config.initialize(), cache.load()]);

  const deployer = new Deployer(queue, cache, { onConflict: createConflictPrompt(queue), log: (m) => log.info(m) }, (id) => servers.poolById(id));
  const sync = new SyncEngine(deployer, cache);
  const fsProvider = new RemoteFileSystemProvider(servers, config);
  RemoteFileSystemProvider.register(context, fsProvider);
  const tree = new RemoteHostTree(context, config, servers);

  const services: Services = { context, config, credentials, servers, queue, cache, deployer, sync, fsProvider, tree };

  context.subscriptions.push(
    config,
    servers,
    tree,
    new TransferView(queue),
    new StatusBar(config, queue),
    new Decorations(config),
    new AutoUploader(config, deployer),
    new RemoteChangeMonitor(config, servers, fsProvider),
    new GitIgnoreOffer(config, context.workspaceState),
    ...registerDeploymentCommands(services),
    ...registerRemoteCommands(services),
    config.onDidChange(() => reportProblems(config)),
  );
  reportProblems(config);

  log.info(`iRemote activated (${config.allServers().length} server(s))`);
}

export async function deactivate(): Promise<void> {
  await cache?.flush();
}
