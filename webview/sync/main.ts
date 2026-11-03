import './style.css';
import { formatSize, formatTime, h, icon, iconButton, vscode } from '../shared/dom';
import type { SyncAction, SyncState, SyncToHost, SyncToWebview, UiSyncItem } from '../shared/protocol';

const post = (m: SyncToHost) => vscode.postMessage(m);

let serverName = '';
let scope = '';
let items: UiSyncItem[] = [];
let loading = 'Comparing…';
let error: string | undefined;
let running = false;
let summary: string | undefined;
let compareContents = false;
const selected = new Set<number>();
let lastClicked: number | undefined;
const filters: Record<SyncState, boolean> = {
  same: false,
  localOnly: true,
  remoteOnly: true,
  localNewer: true,
  remoteNewer: true,
  conflict: true,
};

const STATE_LABELS: Record<SyncState, string> = {
  same: 'Identical',
  localOnly: 'Only local',
  remoteOnly: 'Only remote',
  localNewer: 'Changed locally',
  remoteNewer: 'Changed remotely',
  conflict: 'Conflict',
};

const ACTIONS: Record<SyncAction, { icon: string; label: string }> = {
  upload: { icon: 'arrow-right', label: 'Upload' },
  download: { icon: 'arrow-left', label: 'Download' },
  deleteRemote: { icon: 'trash', label: 'Delete remote' },
  deleteLocal: { icon: 'trash', label: 'Delete local' },
  skip: { icon: 'circle-slash', label: 'Skip' },
};

const allowedActions = (i: UiSyncItem): SyncAction[] => {
  const hasLocal = i.localSize !== undefined;
  const hasRemote = i.remoteSize !== undefined;
  if (hasLocal && hasRemote) return ['upload', 'download', 'skip'];
  if (hasLocal) return ['upload', 'deleteLocal', 'skip'];
  return ['download', 'deleteRemote', 'skip'];
};

const visible = () => items.filter((i) => filters[i.state] || selected.has(i.id));

const root = document.getElementById('app')!;

const setAction = (ids: Iterable<number>, action: SyncAction) => {
  for (const id of ids) {
    const item = items.find((i) => i.id === id);
    if (item && allowedActions(item).includes(action)) item.action = action;
  }
  render();
};

const run = (onlySelected: boolean) => {
  const list = (onlySelected ? items.filter((i) => selected.has(i.id)) : visible()).filter((i) => i.action !== 'skip' && i.status !== 'done');
  if (list.length === 0) return;
  running = true;
  summary = undefined;
  post({ type: 'run', items: list.map((i) => ({ id: i.id, action: i.action })) });
  render();
};

const toolbar = (): HTMLElement => {
  const sel = [...selected];
  const counts = new Map<SyncState, number>();
  for (const i of items) counts.set(i.state, (counts.get(i.state) ?? 0) + 1);
  return h(
    'div',
    { class: 'toolbar' },
    h(
      'div',
      { class: 'filters', role: 'group', 'aria-label': 'Show' },
      ...(Object.keys(STATE_LABELS) as SyncState[]).map((s) => {
        const id = `f-${s}`;
        return h(
          'label',
          { class: `filter state-${s}`, for: id },
          h('input', { type: 'checkbox', id, checked: filters[s], on: { change: (e) => ((filters[s] = (e.target as HTMLInputElement).checked), render()) } }),
          `${STATE_LABELS[s]} (${counts.get(s) ?? 0})`,
        );
      }),
    ),
    h(
      'div',
      { class: 'actions' },
      h('span', { class: 'muted' }, sel.length ? `${sel.length} selected:` : 'Selection:'),
      iconButton('arrow-right', 'Upload selected', () => setAction(sel, 'upload'), !sel.length || running),
      iconButton('arrow-left', 'Download selected', () => setAction(sel, 'download'), !sel.length || running),
      iconButton('circle-slash', 'Skip selected', () => setAction(sel, 'skip'), !sel.length || running),
      h('span', { class: 'separator' }),
      h(
        'label',
        { class: 'filter', for: 'cmp', title: 'Hash or download files whose metadata differs to detect identical content' },
        h('input', { type: 'checkbox', id: 'cmp', checked: compareContents, on: { change: (e) => (compareContents = (e.target as HTMLInputElement).checked) } }),
        'Compare contents',
      ),
      iconButton('refresh', 'Compare again', () => post({ type: 'refresh', compareContents }), running),
    ),
  );
};

const actionCell = (i: UiSyncItem): HTMLElement => {
  const allowed = allowedActions(i);
  const current = ACTIONS[i.action];
  const cycle = () => {
    if (running) return;
    const next = allowed[(allowed.indexOf(i.action) + 1) % allowed.length];
    setAction([i.id], next);
  };
  return h(
    'button',
    {
      class: `action action-${i.action}`,
      title: `${current.label} — click to change (${allowed.map((a) => ACTIONS[a].label).join(' / ')})`,
      'aria-label': current.label,
      disabled: running,
      on: { click: (e) => (e.stopPropagation(), cycle()) },
    },
    icon(current.icon),
  );
};

const statusCell = (i: UiSyncItem): HTMLElement | string => {
  if (i.status === 'running') return h('span', { class: 'st running' }, icon('loading codicon-modifier-spin'));
  if (i.status === 'done') return h('span', { class: 'st done', title: 'Done' }, icon('pass'));
  if (i.status === 'failed') return h('span', { class: 'st failed', title: i.error ?? 'Failed' }, icon('error'));
  return '';
};

const onRowClick = (e: MouseEvent, i: UiSyncItem, list: UiSyncItem[]) => {
  if (e.shiftKey && lastClicked !== undefined) {
    const a = list.findIndex((x) => x.id === lastClicked);
    const b = list.findIndex((x) => x.id === i.id);
    for (const x of list.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(x.id);
  } else if (e.metaKey || e.ctrlKey) {
    if (selected.has(i.id)) selected.delete(i.id);
    else selected.add(i.id);
  } else {
    selected.clear();
    selected.add(i.id);
  }
  lastClicked = i.id;
  render();
};

const table = (): HTMLElement => {
  const list = visible();
  if (list.length === 0) {
    return h('div', { class: 'empty' }, items.length ? 'Everything visible is in sync. Enable "Identical" to see all files.' : 'No files found in the mapped folders.');
  }
  const allSelected = list.every((i) => selected.has(i.id));
  return h(
    'table',
    { class: 'sync-table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { class: 'chk' }, h('input', { type: 'checkbox', 'aria-label': 'Select all', checked: allSelected, on: { change: () => (allSelected ? selected.clear() : list.forEach((i) => selected.add(i.id)), render()) } })),
        h('th', {}, 'Path'),
        h('th', { class: 'side' }, 'Local'),
        h('th', { class: 'act' }, ''),
        h('th', { class: 'side' }, serverName),
        h('th', { class: 'st' }, ''),
      ),
    ),
    h(
      'tbody',
      {},
      ...list.map((i) =>
        h(
          'tr',
          {
            class: `${selected.has(i.id) ? 'selected' : ''} state-${i.state}`,
            title: `${STATE_LABELS[i.state]}${i.wasSynced && (i.state === 'localOnly' || i.state === 'remoteOnly') ? ' (was synchronized before — possibly deleted on the other side)' : ''}\n${i.remotePath}`,
            on: { click: (e) => onRowClick(e as MouseEvent, i, list), dblclick: () => post({ type: 'diff', id: i.id }) },
          },
          h('td', { class: 'chk' }, h('input', { type: 'checkbox', checked: selected.has(i.id), on: { click: (e) => e.stopPropagation(), change: () => (selected.has(i.id) ? selected.delete(i.id) : selected.add(i.id), render()) } })),
          h('td', { class: 'path' }, h('span', { class: `badge state-${i.state}` }, STATE_LABELS[i.state]), h('span', { class: 'rel' }, i.rel)),
          h(
            'td',
            { class: 'side' },
            i.localSize !== undefined
              ? h('a', { href: '#', on: { click: (e) => (e.preventDefault(), e.stopPropagation(), post({ type: 'open', id: i.id, side: 'local' })) } }, `${formatSize(i.localSize)} · ${formatTime(i.localMtime)}`)
              : h('span', { class: 'muted' }, '—'),
          ),
          h('td', { class: 'act' }, actionCell(i)),
          h(
            'td',
            { class: 'side' },
            i.remoteSize !== undefined
              ? h('a', { href: '#', on: { click: (e) => (e.preventDefault(), e.stopPropagation(), post({ type: 'open', id: i.id, side: 'remote' })) } }, `${formatSize(i.remoteSize)} · ${formatTime(i.remoteMtime) || 'time unknown'}`)
              : h('span', { class: 'muted' }, '—'),
          ),
          h('td', { class: 'st' }, statusCell(i)),
        ),
      ),
    ),
  );
};

const footer = (): HTMLElement => {
  const pendingCount = visible().filter((i) => i.action !== 'skip' && i.status !== 'done').length;
  const selCount = items.filter((i) => selected.has(i.id) && i.action !== 'skip' && i.status !== 'done').length;
  return h(
    'footer',
    { class: 'footer' },
    h('div', { class: 'muted' }, summary ?? (running ? 'Synchronizing…' : `${pendingCount} operation(s) pending. Double-click a row to compare.`)),
    h(
      'div',
      { class: 'buttons' },
      h('button', { class: 'button', disabled: running || !selCount, on: { click: () => run(true) } }, `Synchronize Selected (${selCount})`),
      h('button', { class: 'button primary', disabled: running || !pendingCount, on: { click: () => run(false) } }, `Synchronize All (${pendingCount})`),
    ),
  );
};

const render = () => {
  const header = h('header', { class: 'header' }, h('h1', {}, icon('sync'), `Sync with ${serverName}`), h('span', { class: 'muted' }, scope));
  let body: HTMLElement;
  if (error) {
    body = h('div', { class: 'message error' }, icon('error'), error, h('button', { class: 'button', on: { click: () => ((error = undefined), post({ type: 'refresh', compareContents })) } }, 'Retry'));
  } else if (loading) {
    body = h('div', { class: 'message' }, icon('loading codicon-modifier-spin'), loading);
  } else {
    body = h('div', { class: 'table-wrap' }, table());
  }
  const scrollTop = root.querySelector('.table-wrap')?.scrollTop ?? 0;
  root.replaceChildren(h('div', { class: 'layout' }, header, loading || error ? h('div') : toolbar(), body, loading || error ? h('div') : footer()));
  const wrap = root.querySelector('.table-wrap');
  if (wrap) wrap.scrollTop = scrollTop;
};

window.addEventListener('message', (event: MessageEvent<SyncToWebview>) => {
  const m = event.data;
  switch (m.type) {
    case 'init':
      serverName = m.serverName;
      scope = m.scope;
      break;
    case 'loading':
      loading = m.message;
      error = undefined;
      break;
    case 'items':
      items = m.items;
      loading = '';
      selected.clear();
      summary = undefined;
      break;
    case 'error':
      error = m.message;
      loading = '';
      break;
    case 'itemStatus': {
      const item = items.find((i) => i.id === m.id);
      if (item) {
        item.status = m.status;
        item.error = m.error;
      }
      break;
    }
    case 'finished':
      running = false;
      summary = `Finished: ${m.transferred} succeeded${m.failed ? `, ${m.failed} failed (hover the red icons for details)` : ''}.`;
      break;
  }
  render();
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    visible().forEach((i) => selected.add(i.id));
    render();
  }
});

render();
post({ type: 'ready' });
