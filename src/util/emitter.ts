/** Host-neutral event emitter; `event` has the same shape as vscode.Event so callers can push the result to subscriptions. */
export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (e: T) => unknown) => Disposable;

export class Emitter<T> implements Disposable {
  private listeners = new Set<(e: T) => unknown>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }

  dispose(): void {
    this.listeners.clear();
  }
}
