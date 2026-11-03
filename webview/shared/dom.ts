type Child = Node | string | number | false | null | undefined;
type Props = Record<string, unknown> & { class?: string; on?: Partial<Record<keyof HTMLElementEventMap, (e: Event) => void>> };

/** Minimal element factory: h('div', { class: 'x', on: { click } }, child...). Strings are inserted as text (never HTML). */
export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'on') {
      for (const [evt, fn] of Object.entries(value as Record<string, EventListener>)) el.addEventListener(evt, fn);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (key === 'value' && 'value' in el) {
      (el as HTMLInputElement).value = String(value);
    } else if (key === 'checked' && 'checked' in el) {
      (el as HTMLInputElement).checked = Boolean(value);
    } else if (key === 'selected' && 'selected' in el) {
      (el as HTMLOptionElement).selected = Boolean(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const c of children.flat()) {
    if (c === false || c === null || c === undefined) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
};

export const icon = (name: string, title?: string): HTMLElement => h('i', { class: `codicon codicon-${name}`, 'aria-hidden': title ? undefined : 'true', title });

export const iconButton = (name: string, title: string, onClick: () => void, disabled = false): HTMLButtonElement =>
  h('button', { class: 'icon-button', title, 'aria-label': title, disabled, on: { click: (e) => (e.preventDefault(), onClick()) } }, icon(name));

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };

/** acquireVsCodeApi may only be called once per webview. */
export const vscode = acquireVsCodeApi();

export const formatSize = (n?: number): string => {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export const formatTime = (ms?: number): string => (ms ? new Date(ms).toLocaleString() : '');
