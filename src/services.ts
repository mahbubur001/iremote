import type * as vscode from 'vscode';
import type { ConfigStore } from './config/ConfigStore';
import type { Credentials } from './config/Credentials';
import type { ServerManager } from './core/ServerManager';
import type { TransferQueue } from './core/TransferQueue';
import type { StateCache } from './core/StateCache';
import type { Deployer } from './core/Deployer';
import type { SyncEngine } from './core/SyncEngine';
import type { RemoteFileSystemProvider } from './fs/RemoteFileSystemProvider';
import type { RemoteHostTree } from './views/RemoteHostTree';

export interface Services {
  context: vscode.ExtensionContext;
  config: ConfigStore;
  credentials: Credentials;
  servers: ServerManager;
  queue: TransferQueue;
  cache: StateCache;
  deployer: Deployer;
  sync: SyncEngine;
  fsProvider: RemoteFileSystemProvider;
  tree: RemoteHostTree;
}
