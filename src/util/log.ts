export type LogLevel = 'errors' | 'brief' | 'details';

const rank: Record<LogLevel, number> = { errors: 0, brief: 1, details: 2 };

/** Where log lines go: VS Code's output channel, or the Neovim host's log. */
export interface LogSink {
  error(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  show?(): void;
  level(): LogLevel;
}

/** Single logger for the extension; verbosity follows `iremote.log.level` (PhpStorm: Operations logging). */
class Logger {
  private sink?: LogSink;

  attach(sink: LogSink): void {
    this.sink = sink;
  }

  private get level(): LogLevel {
    return this.sink?.level() ?? 'brief';
  }

  error(message: string, err?: unknown): void {
    const detail = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : '';
    this.sink?.error(`${message}${detail}`);
  }

  info(message: string): void {
    if (rank[this.level] >= rank.brief) this.sink?.info(message);
  }

  detail(message: string): void {
    if (rank[this.level] >= rank.details) this.sink?.debug(message);
  }

  get wantsDetails(): boolean {
    return rank[this.level] >= rank.details;
  }

  show(): void {
    this.sink?.show?.();
  }
}

export const log = new Logger();
