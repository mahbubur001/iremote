import * as vscode from 'vscode';
import { StringDecoder } from 'node:string_decoder';
import type { ClientChannel } from 'ssh2';
import type { ServerManager } from '../core/ServerManager';
import type { SftpClient } from '../protocol/SftpClient';
import type { ServerConfig } from '../config/schema';
import { RemoteError } from '../protocol/types';
import { log } from '../util/log';
import { shellQuote } from './hosts';

const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * An interactive SSH shell rendered in a VS Code terminal. Connects through ServerManager, so the session uses the
 * same keychain secrets, prompts, agent, jump host and host-key checks as file transfers.
 */
export class SshTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private dims = { cols: 80, rows: 24 };
  private client?: SftpClient;
  private cleanup?: () => void;
  private channel?: ClientChannel;
  /** Set after a failed connect: the next key press retries (Enter) or closes the terminal. */
  private failed = false;
  private disposed = false;

  constructor(
    private readonly server: ServerConfig,
    private readonly servers: ServerManager,
    /** Remote directory to `cd` into once the shell starts. */
    private readonly cwd?: string,
  ) {}

  open(dims: vscode.TerminalDimensions | undefined): void {
    if (dims) this.dims = { cols: dims.columns, rows: dims.rows };
    void this.connect();
  }

  private async connect(): Promise<void> {
    this.failed = false;
    const who = this.server.username ? `${this.server.username}@${this.server.host}` : this.server.host;
    this.writeEmitter.fire(`${DIM}Connecting to ${who}${this.server.port && this.server.port !== 22 ? `:${this.server.port}` : ''}...${RESET}\r\n`);
    try {
      const { client, cleanup } = await this.servers.connectShell(this.server);
      this.client = client;
      this.cleanup = cleanup;
      if (this.disposed) return this.teardown();
      const channel = await client.shell(this.dims);
      this.channel = channel;
      const out = new StringDecoder('utf8');
      const err = new StringDecoder('utf8');
      channel.on('data', (d: Buffer) => this.writeEmitter.fire(out.write(d)));
      channel.stderr.on('data', (d: Buffer) => this.writeEmitter.fire(err.write(d)));
      channel.on('close', () => {
        this.teardown();
        if (!this.disposed) this.closeEmitter.fire();
      });
      if (this.cwd) channel.write(`cd ${shellQuote(this.cwd)}\n`);
    } catch (e) {
      this.teardown();
      if (this.disposed) return;
      if (e instanceof RemoteError && e.code === 'Cancelled') {
        this.closeEmitter.fire();
        return;
      }
      log.error(`SSH session to ${this.server.name} failed`, e);
      this.failed = true;
      this.writeEmitter.fire(`${RED}${(e as Error).message}${RESET}\r\n${DIM}Press Enter to reconnect, any other key to close.${RESET}\r\n`);
    }
  }

  handleInput(data: string): void {
    if (this.failed) {
      if (data === '\r') void this.connect();
      else this.closeEmitter.fire();
      return;
    }
    this.channel?.write(data);
  }

  setDimensions(dims: vscode.TerminalDimensions): void {
    this.dims = { cols: dims.columns, rows: dims.rows };
    this.channel?.setWindow(dims.rows, dims.columns, 0, 0);
  }

  close(): void {
    this.disposed = true;
    this.teardown();
  }

  private teardown(): void {
    const { channel, client, cleanup } = this;
    this.channel = undefined;
    this.client = undefined;
    this.cleanup = undefined;
    channel?.end();
    void client?.close();
    cleanup?.();
  }
}
