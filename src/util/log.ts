import * as vscode from 'vscode';

export type LogLevel = 'errors' | 'brief' | 'details';

const rank: Record<LogLevel, number> = { errors: 0, brief: 1, details: 2 };

/** Single output channel for the extension; verbosity follows `iremote.log.level` (PhpStorm: Operations logging). */
class Logger {
  private channel?: vscode.LogOutputChannel;

  init(context: vscode.ExtensionContext): void {
    this.channel = vscode.window.createOutputChannel('iRemote', { log: true });
    context.subscriptions.push(this.channel);
  }

  private get level(): LogLevel {
    return vscode.workspace.getConfiguration('iremote').get<LogLevel>('log.level', 'brief');
  }

  error(message: string, err?: unknown): void {
    const detail = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : '';
    this.channel?.error(`${message}${detail}`);
  }

  info(message: string): void {
    if (rank[this.level] >= rank.brief) this.channel?.info(message);
  }

  detail(message: string): void {
    if (rank[this.level] >= rank.details) this.channel?.debug(message);
  }

  get wantsDetails(): boolean {
    return rank[this.level] >= rank.details;
  }

  show(): void {
    this.channel?.show(true);
  }
}

export const log = new Logger();
