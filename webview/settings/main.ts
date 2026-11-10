import './style.css';
import { h, icon, iconButton, vscode } from '../shared/dom';
import type {
  SecretChange,
  SecretState,
  ServerType,
  SettingsToHost,
  SettingsToWebview,
  UiOptions,
  UiProject,
  UiServer,
} from '../shared/protocol';

// ---- State ---------------------------------------------------------------------------------------

type Selection = { kind: 'server'; id: string } | { kind: 'options' } | undefined;
type Tab = 'connection' | 'mappings' | 'excluded';

let projects: UiProject[] = [];
let activeKey = '';
let selection: Selection;
let tab: Tab = 'connection';
let secrets: Record<string, SecretState> = {};
let secretChanges: Record<string, SecretChange> = {};
let problems: string[] = [];
let dirty = false;
let status: { kind: 'info' | 'error' | 'ok'; text: string } | undefined;
let requestSeq = 0;
const pending = new Map<number, (r: Extract<SettingsToWebview, { type: 'result' }>) => void>();
const testResults = new Map<string, { ok: boolean; message: string; running?: boolean }>();

const TYPE_LABELS: Record<ServerType, string> = {
  sftp: 'SFTP',
  ftp: 'FTP',
  ftps: 'FTPS (explicit)',
  'ftps-implicit': 'FTPS (implicit)',
  webdav: 'WebDAV',
  local: 'Local or mounted folder',
};
const TYPE_ICONS: Record<ServerType, string> = {
  sftp: 'send',
  ftp: 'send',
  ftps: 'send',
  'ftps-implicit': 'send',
  webdav: 'globe',
  local: 'device-desktop',
};
const DEFAULT_PORTS: Partial<Record<ServerType, number>> = { sftp: 22, ftp: 21, ftps: 21, 'ftps-implicit': 990 };
const ENCODINGS = ['utf8', 'latin1', 'ascii', 'utf16le'];

const post = (m: SettingsToHost) => vscode.postMessage(m);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RequestMessage = DistributiveOmit<Extract<SettingsToHost, { requestId: number }>, 'requestId'>;

const request = (m: RequestMessage): Promise<Extract<SettingsToWebview, { type: 'result' }>> => {
  const requestId = ++requestSeq;
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    post({ ...m, requestId } as SettingsToHost);
  });
};

const project = (): UiProject | undefined => projects.find((p) => p.key === activeKey);
const currentServer = (): UiServer | undefined => {
  const sel = selection;
  return sel?.kind === 'server' ? project()?.servers.find((s) => s.id === sel.id) : undefined;
};

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;

const markDirty = (server?: UiServer) => {
  dirty = true;
  status = undefined;
  if (server?.scope === 'global') propagateGlobal(server);
  renderFooter();
};

/** Global servers share connection settings across projects; mappings stay per project. */
const propagateGlobal = (server: UiServer) => {
  const { mappings: _m, excludedLocal: _l, excludedRemote: _r, ...conn } = server;
  for (const p of projects) {
    if (p.key === activeKey) continue;
    const other = p.servers.find((s) => s.id === server.id);
    if (other) Object.assign(other, conn);
  }
};

const secretFor = (id: string): SecretChange => (secretChanges[id] ??= { savePassword: true, savePassphrase: true });

// ---- Rendering helpers ------------------------------------------------------------------------------

const root = document.getElementById('app')!;
let sidebarEl: HTMLElement;
let contentEl: HTMLElement;
let footerEl: HTMLElement;

/** PhpStorm-style row: label on the left, control on the right; hints are tooltips instead of extra lines. */
const row = (label: string, control: Node, hint?: string, id?: string) =>
  h('div', { class: 'form-row' }, h('label', { for: id, title: hint }, label), h('div', { class: 'control', title: hint }, control));

let fieldSeq = 0;
const textInput = (
  value: string | undefined,
  onChange: (v: string) => void,
  opts: { placeholder?: string; type?: string; id?: string; width?: 'short' | 'long'; invalid?: (v: string) => string | undefined } = {},
) => {
  const input = h('input', {
    type: opts.type ?? 'text',
    value: value ?? '',
    placeholder: opts.placeholder,
    id: opts.id,
    class: opts.width === 'short' ? 'short' : '',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const validate = () => {
    const err = opts.invalid?.(input.value);
    input.classList.toggle('invalid', !!err);
    input.title = err ?? '';
  };
  input.addEventListener('input', () => {
    onChange(input.value);
    validate();
  });
  validate();
  return input;
};

const checkbox = (label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string) => {
  const id = `cb${++fieldSeq}`;
  const input = h('input', { type: 'checkbox', id, checked, on: { change: () => onChange(input.checked) } });
  return h('div', { class: 'checkbox-row', title: hint }, input, h('label', { for: id }, label));
};

const select = <T extends string>(value: T, options: [T, string][], onChange: (v: T) => void, id?: string) => {
  const el = h('select', { id, on: { change: () => onChange(el.value as T) } }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  return el;
};

const button = (label: string, onClick: () => void, opts: { primary?: boolean; icon?: string; disabled?: boolean; title?: string } = {}) =>
  h(
    'button',
    { class: opts.primary ? 'button primary' : 'button', disabled: opts.disabled, title: opts.title, on: { click: (e) => (e.preventDefault(), onClick()) } },
    opts.icon ? icon(opts.icon) : null,
    label,
  );

const withBrowse = (input: HTMLInputElement, onBrowse: () => void, title = 'Browse…') => h('div', { class: 'adorned' }, input, iconButton('folder-opened', title, onBrowse));

// ---- Remote browser (modal) ----------------------------------------------------------------------

const browseRemote = (server: UiServer, startPath: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    let current = startPath || server.rootPath || '/';
    const overlay = h('div', { class: 'modal-overlay' });
    const list = h('ul', { class: 'remote-list', role: 'listbox' });
    const pathInput = h('input', { type: 'text', value: current, spellcheck: 'false' });
    const message = h('div', { class: 'modal-message' });
    /** Folder highlighted with a single click; "Select" returns it, or the open folder when nothing is highlighted. */
    let selected: string | undefined;
    const close = (result?: string) => {
      overlay.remove();
      resolve(result);
    };
    const select = (li: HTMLElement, path: string | undefined) => {
      for (const other of list.querySelectorAll('li.selected')) {
        other.classList.remove('selected');
        other.setAttribute('aria-selected', 'false');
      }
      li.classList.add('selected');
      li.setAttribute('aria-selected', 'true');
      li.focus();
      li.scrollIntoView({ block: 'nearest' });
      selected = path;
      pathInput.value = path ?? current;
    };
    // Click selects, double-click / Enter opens, arrow keys move between folders.
    const folderItem = (label: string, iconName: string, target: string, selectable: boolean): HTMLElement => {
      const li: HTMLElement = h(
        'li',
        {
          class: 'dir',
          role: 'option',
          'aria-selected': 'false',
          tabindex: '0',
          on: {
            click: () => select(li, selectable ? target : undefined),
            dblclick: () => void load(target),
            keydown: (e) => {
              const key = (e as KeyboardEvent).key;
              if (key === 'Enter') return void load(target);
              if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
              e.preventDefault();
              const dirs = [...list.querySelectorAll<HTMLElement>('li.dir')];
              dirs[dirs.indexOf(li) + (key === 'ArrowDown' ? 1 : -1)]?.click();
            },
          },
        },
        icon(iconName),
        label,
      );
      return li;
    };
    const load = async (path: string) => {
      message.textContent = 'Loading…';
      list.replaceChildren();
      selected = undefined;
      const r = await request({ type: 'browseRemote', projectKey: activeKey, server, secret: secretChanges[server.id], path });
      if (!r.ok) {
        message.textContent = r.message ?? 'Cannot list directory.';
        return;
      }
      current = r.path ?? path;
      pathInput.value = current;
      message.textContent = '';
      const parent = current.replace(/\/+[^/]+\/?$/, '') || '/';
      const items: HTMLElement[] = [];
      if (current !== '/') items.push(folderItem('..', 'arrow-up', parent, false));
      for (const e of r.entries ?? []) {
        items.push(e.isDir ? folderItem(e.name, 'folder', `${current.replace(/\/$/, '')}/${e.name}`, true) : h('li', { class: 'file' }, icon('file'), e.name));
      }
      list.replaceChildren(...items);
    };
    pathInput.addEventListener('keydown', (e) => e.key === 'Enter' && void load(pathInput.value));
    overlay.addEventListener('keydown', (e) => e.key === 'Escape' && (e.stopPropagation(), close()));
    overlay.append(
      h(
        'div',
        { class: 'modal', role: 'dialog', 'aria-label': 'Choose remote folder' },
        h('div', { class: 'modal-title' }, `Choose folder on ${server.name || server.host}`),
        h('div', { class: 'input-with-button' }, pathInput, iconButton('arrow-right', 'Go', () => void load(pathInput.value))),
        list,
        message,
        h('div', { class: 'modal-buttons' }, button('Cancel', () => close()), button('Select', () => close(selected ?? current), { primary: true })),
      ),
    );
    document.body.append(overlay);
    pathInput.focus();
    void load(current);
  });

const relativeToRoot = (server: UiServer, abs: string): string => {
  const root = (server.rootPath || '/').replace(/\/$/, '');
  if (!root) return abs;
  if (abs === root) return '/';
  return abs.startsWith(`${root}/`) ? abs.slice(root.length) : abs;
};

const browseLocal = async (current: string, folders = true, relative = true): Promise<string | undefined> => {
  const r = await request({ type: 'browseLocal', projectKey: activeKey, current, folders, relative });
  return r.ok ? r.path : undefined;
};

// ---- Sidebar ---------------------------------------------------------------------------------------

const addServer = (type: ServerType) => {
  const p = project();
  if (!p) return;
  const names = new Set(p.servers.map((s) => s.name));
  let name = 'New server';
  for (let i = 2; names.has(name); i++) name = `New server ${i}`;
  const server: UiServer = {
    id: newId(),
    name,
    type,
    scope: 'project',
    host: type === 'webdav' ? 'https://' : '',
    port: DEFAULT_PORTS[type],
    username: '',
    auth: type === 'sftp' ? 'password' : undefined,
    webdavAuth: type === 'webdav' ? 'basic' : undefined,
    rootPath: type === 'local' ? '' : '/',
    webUrl: '',
    passive: true,
    mappings: [{ local: '', remote: '/', web: '/' }],
    excludedLocal: [],
    excludedRemote: [],
  };
  p.servers.push(server);
  if (!p.defaultServer) p.defaultServer = server.id;
  selection = { kind: 'server', id: server.id };
  tab = 'connection';
  markDirty();
  render();
  startRename(server);
};

/** Floating menu (toolbar "+" and the server list's context menu); items with `sub` open a submenu on hover. */
type MenuItem = { label: string; icon?: string | (() => HTMLElement); selected?: boolean; keys?: string; disabled?: boolean; run?: () => void; sub?: MenuItem[] } | 'separator';

const closeMenus = () => document.querySelectorAll('.popup-menu').forEach((m) => m.remove());

// Pressing outside any menu closes them (one listener, so a stale handler can't close the next menu).
document.addEventListener('mousedown', (e) => {
  if (!(e.target as Element | null)?.closest?.('.popup-menu')) closeMenus();
}, true);

const showMenu = (items: MenuItem[], x: number, y: number, level = 0, minWidth = 0): HTMLElement => {
  document.querySelectorAll('.popup-menu').forEach((m) => Number((m as HTMLElement).dataset.level) >= level && m.remove());
  const menu = h('div', { class: 'popup-menu', role: 'menu', 'data-level': String(level) });
  if (minWidth) menu.style.minWidth = `${minWidth}px`;
  for (const item of items) {
    if (item === 'separator') {
      menu.append(h('div', { class: 'menu-separator', role: 'separator' }));
      continue;
    }
    const el = h(
      'button',
      {
        role: 'menuitem',
        class: item.selected ? 'selected' : '',
        disabled: item.disabled,
        'aria-haspopup': item.sub ? 'menu' : undefined,
        on: {
          click: (e) => {
            e.stopPropagation();
            if (item.sub) return;
            closeMenus();
            item.run?.();
          },
          mouseenter: () => {
            if (!item.sub) return void document.querySelectorAll('.popup-menu').forEach((m) => Number((m as HTMLElement).dataset.level) > level && m.remove());
            const r = el.getBoundingClientRect();
            showMenu(item.sub, r.right + 2, r.top - 4, level + 1);
          },
        },
      },
      h('span', { class: 'menu-icon' }, typeof item.icon === 'function' ? item.icon() : item.icon ? icon(item.icon) : null),
      h('span', { class: 'menu-label' }, item.label),
      item.sub ? icon('chevron-right') : item.keys ? h('span', { class: 'menu-keys' }, item.keys) : null,
    );
    menu.append(el);
  }
  document.body.append(menu);
  const { innerWidth, innerHeight } = window;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, innerHeight - r.height - 4))}px`;
  ((menu.querySelector('button.selected') ?? menu.querySelector('button:not(:disabled)')) as HTMLElement | null)?.focus();
  return menu;
};

const addItems = (): MenuItem[] => [
  ...(Object.keys(TYPE_LABELS) as ServerType[]).map((t): MenuItem => ({ label: TYPE_LABELS[t], icon: () => typeIcon(t), run: () => addServer(t) })),
  'separator',
  { label: 'Import from PhpStorm…', icon: 'cloud-download', run: () => post({ type: 'importPhpStorm' }) },
];

const showAddMenu = (anchor: HTMLElement) => {
  const rect = anchor.getBoundingClientRect();
  showMenu(addItems(), rect.left, rect.bottom + 2);
};

const removeServer = () => {
  const p = project();
  const s = currentServer();
  if (!p || !s) return;
  const idx = p.servers.indexOf(s);
  p.servers.splice(idx, 1);
  if (s.scope === 'global') for (const other of projects) other.servers = other.servers.filter((x) => x.id !== s.id);
  if (p.defaultServer === s.id) p.defaultServer = undefined;
  delete secretChanges[s.id];
  const next = p.servers[Math.min(idx, p.servers.length - 1)];
  selection = next ? { kind: 'server', id: next.id } : undefined;
  markDirty();
  render();
};

const copyServer = () => {
  const p = project();
  const s = currentServer();
  if (!p || !s) return;
  const copy: UiServer = JSON.parse(JSON.stringify(s));
  copy.id = newId();
  copy.name = `Copy of ${s.name}`;
  copy.scope = 'project';
  copy.trustedCertificateFingerprint = undefined;
  p.servers.splice(p.servers.indexOf(s) + 1, 0, copy);
  selection = { kind: 'server', id: copy.id };
  markDirty();
  render();
};

const toggleDefault = () => {
  const p = project();
  const s = currentServer();
  if (!p || !s) return;
  p.defaultServer = p.defaultServer === s.id ? undefined : s.id;
  markDirty();
  renderSidebar();
};

/** Rename in place in the server list (PhpStorm: Rename… / Shift+F6). */
const startRename = (s: UiServer) => {
  const li = sidebarEl.querySelector(`li[data-id="${CSS.escape(s.id)}"]`);
  const name = li?.querySelector('.name');
  if (!li || !name) return;
  const input = h('input', { type: 'text', class: 'rename', value: s.name, spellcheck: 'false', 'aria-label': 'Server name' });
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (commit && v && v !== s.name) {
      s.name = v;
      markDirty(s);
    }
    renderSidebar();
    (sidebarEl.querySelector('li.selected') as HTMLElement | null)?.focus();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  name.replaceWith(input);
  input.focus();
  input.select();
};

const serverMenu = (s: UiServer): MenuItem[] => [
  { label: 'Add', icon: 'add', sub: addItems() },
  { label: 'Delete', icon: 'remove', keys: '⌘⌫', run: removeServer },
  { label: 'Duplicate', icon: 'copy', keys: '⌘D', run: copyServer },
  { label: 'Rename', keys: '⇧F6', run: () => startRename(s) },
  { label: project()?.defaultServer === s.id ? 'Unset Default' : 'Use as Default', run: toggleDefault },
];

/** PhpStorm-style protocol icon: colored arrow (lock badge for secure protocols), globe for WebDAV, monitor for local. */
const typeIcon = (t: ServerType) =>
  h('span', { class: `server-icon type-${t}` }, icon(TYPE_ICONS[t]), t === 'sftp' || t.startsWith('ftps') ? icon('lock') : null);

const serverIcon = (s: UiServer) => typeIcon(s.type);

/** Type dropdown with protocol icons (a native <select> cannot show them). */
const typeSelect = (value: ServerType, onChange: (t: ServerType) => void, id?: string) => {
  const btn: HTMLButtonElement = h(
    'button',
    {
      id,
      class: 'icon-select',
      'aria-haspopup': 'menu',
      on: {
        click: (e) => {
          e.preventDefault();
          const r = btn.getBoundingClientRect();
          showMenu(
            (Object.keys(TYPE_LABELS) as ServerType[]).map((t): MenuItem => ({ label: TYPE_LABELS[t], icon: () => typeIcon(t), selected: t === value, run: () => t !== value && onChange(t) })),
            r.left,
            r.bottom + 2,
            0,
            r.width,
          );
        },
        keydown: (e) => {
          if ((e as KeyboardEvent).key !== 'ArrowDown') return;
          e.preventDefault();
          btn.click();
        },
      },
    },
    typeIcon(value),
    h('span', { class: 'icon-select-label' }, TYPE_LABELS[value]),
    icon('chevron-down'),
  );
  return btn;
};

const selectServer = (id: string) => {
  selection = { kind: 'server', id };
  render();
  (sidebarEl.querySelector('li.selected') as HTMLElement | null)?.focus();
};

const renderSidebar = () => {
  const p = project();
  const servers = p?.servers ?? [];
  const sel = currentServer();
  const addBtn = iconButton('add', 'Add', () => showAddMenu(addBtn));
  addBtn.classList.add('tb-add');
  const removeBtn = iconButton('remove', 'Delete', removeServer, !sel);
  removeBtn.classList.add('tb-remove');
  const defaultBtn = iconButton(sel && p?.defaultServer === sel.id ? 'pass-filled' : 'pass', 'Use as Default', toggleDefault, !sel);
  defaultBtn.classList.add('tb-default');
  const toolbar = h('div', { class: 'toolbar' }, addBtn, removeBtn, defaultBtn);
  const list = h(
    'ul',
    { class: 'server-list', role: 'listbox', 'aria-label': 'Servers' },
    ...servers.map((s) =>
      h(
        'li',
        {
          class: `${selection?.kind === 'server' && selection.id === s.id ? 'selected' : ''} ${p?.defaultServer === s.id ? 'default' : ''}`,
          role: 'option',
          tabindex: '0',
          'data-id': s.id,
          'aria-selected': String(selection?.kind === 'server' && selection.id === s.id),
          title: `${TYPE_LABELS[s.type]}${s.scope === 'global' ? ' · visible in all projects' : ''}${p?.defaultServer === s.id ? ' · default' : ''}`,
          on: {
            click: () => selection?.kind === 'server' && selection.id === s.id ? undefined : selectServer(s.id),
            dblclick: () => startRename(s),
            contextmenu: (e) => {
              e.preventDefault();
              if (!(selection?.kind === 'server' && selection.id === s.id)) selectServer(s.id);
              const me = e as MouseEvent;
              showMenu(serverMenu(s), me.clientX, me.clientY);
            },
            keydown: (e) => {
              const ke = e as KeyboardEvent;
              const mod = ke.metaKey || ke.ctrlKey;
              const i = servers.indexOf(s);
              const next = ke.key === 'ArrowDown' ? servers[i + 1] : ke.key === 'ArrowUp' ? servers[i - 1] : undefined;
              if (next) return void (ke.preventDefault(), selectServer(next.id));
              if (ke.key === 'F2' || (ke.key === 'F6' && ke.shiftKey)) return void (ke.preventDefault(), startRename(s));
              if (mod && ke.key === 'd') return void (ke.preventDefault(), copyServer());
              if ((mod && ke.key === 'Backspace') || ke.key === 'Delete') return void (ke.preventDefault(), removeServer());
              if (ke.key === 'ContextMenu' || (ke.shiftKey && ke.key === 'F10')) {
                ke.preventDefault();
                const r = (ke.currentTarget as HTMLElement).getBoundingClientRect();
                showMenu(serverMenu(s), r.left + 24, r.bottom);
              }
            },
          },
        },
        serverIcon(s),
        h('span', { class: 'name' }, s.name || '(unnamed)'),
      ),
    ),
  );
  const options = h(
    'button',
    {
      class: `nav-item ${selection?.kind === 'options' ? 'selected' : ''}`,
      on: {
        click: () => {
          selection = { kind: 'options' };
          render();
        },
      },
    },
    icon('settings-gear'),
    'Options',
  );
  const projectPicker =
    projects.length > 1
      ? h(
          'div',
          { class: 'project-select' },
          select(activeKey, projects.map((x) => [x.key, x.name]), (v) => {
            activeKey = v;
            const first = project()?.servers[0];
            selection = first ? { kind: 'server', id: first.id } : undefined;
            render();
          }, 'project'),
        )
      : null;
  sidebarEl.replaceChildren(
    toolbar,
    ...(projectPicker ? [projectPicker] : []),
    servers.length ? list : h('div', { class: 'empty' }, 'No servers. Click + to add one.'),
    h('div', { class: 'sidebar-footer' }, options),
  );
};

// ---- Connection tab ----------------------------------------------------------------------------------

const secretField = (s: UiServer, kind: 'password' | 'passphrase') => {
  const has = kind === 'password' ? secrets[s.id]?.hasPassword : secrets[s.id]?.hasPassphrase;
  const change = secretChanges[s.id];
  if (has && !change) {
    // Saving with savePassword/savePassphrase false and no value forgets the stored secret.
    const reset = h('a', { href: '#', class: 'link', on: { click: (e) => {
      e.preventDefault();
      const c = secretFor(s.id);
      c[kind === 'password' ? 'savePassword' : 'savePassphrase'] = false;
      markDirty();
      renderContent();
    } } }, 'Reset');
    return h('div', { class: 'secret-saved' }, h('span', {}, `${kind === 'password' ? 'Password' : 'Passphrase'} saved permanently`), reset);
  }
  const saveKey = kind === 'password' ? 'savePassword' : 'savePassphrase';
  const input = textInput(change?.[kind] ?? '', (v) => {
    secretFor(s.id)[kind] = v;
    markDirty();
  }, { type: 'password', placeholder: has ? 'Saved in system keychain' : kind === 'password' ? 'Asked on connect if empty' : 'Asked on connect if needed' });
  const save = checkbox(`Save ${kind}`, change ? change[saveKey] : true, (v) => {
    secretFor(s.id)[saveKey] = v;
    markDirty();
  });
  return h('div', { class: 'secret-field' }, input, save);
};

const testArea = (s: UiServer) => {
  const result = testResults.get(s.id);
  const run = async () => {
    testResults.set(s.id, { ok: false, message: 'Connecting…', running: true });
    renderContent();
    const r = await request({ type: 'test', projectKey: activeKey, server: s, secret: secretChanges[s.id] });
    testResults.set(s.id, { ok: r.ok, message: r.message ?? (r.ok ? 'Connected.' : 'Failed.') });
    renderContent();
  };
  return h(
    'div',
    { class: 'form-row' },
    h('span', {}),
    h(
    'div',
    { class: 'test-area' },
    button('Test Connection', () => void run(), { disabled: result?.running }),
    result ? h('span', { class: `test-result ${result.running ? 'running' : result.ok ? 'ok' : 'error'}` }, icon(result.running ? 'loading codicon-modifier-spin' : result.ok ? 'pass' : 'error'), result.message) : null,
    ),
  );
};

const rootPathRow = (s: UiServer) => {
  const input = textInput(s.rootPath, (v) => ((s.rootPath = v), markDirty(s)), { id: 'root-path', placeholder: '/' });
  const detect = async () => {
    const r = await request({ type: 'detectRoot', projectKey: activeKey, server: s, secret: secretChanges[s.id] });
    if (r.ok && r.path) {
      s.rootPath = r.path;
      input.value = r.path;
      markDirty(s);
    } else {
      testResults.set(s.id, { ok: false, message: r.message ?? 'Cannot detect root path.' });
      renderContent();
    }
  };
  const browse = async () => {
    const picked = await browseRemote(s, s.rootPath);
    if (picked !== undefined) {
      s.rootPath = picked;
      input.value = picked;
      markDirty(s);
    }
  };
  return row(
    'Root path:',
    h(
      'div',
      { class: 'input-with-button' },
      h('div', { class: 'adorned' }, input, iconButton('folder-opened', 'Browse server…', () => void browse())),
      h('span', { class: 'help', title: 'All deployment paths (mappings, Remote Host) are relative to this folder.' }, icon('question')),
      button('Autodetect', () => void detect()),
    ),
    undefined,
    'root-path',
  );
};

const portValidator = (v: string) => (v === '' || (/^\d+$/.test(v) && +v > 0 && +v < 65536) ? undefined : 'Port must be 1–65535');

const renderConnection = (s: UiServer): HTMLElement => {
  const rows: Node[] = [];
  const changeType = (t: ServerType) => {
    if (s.port === undefined || s.port === DEFAULT_PORTS[s.type]) s.port = DEFAULT_PORTS[t];
    if (t === 'sftp' && !s.auth) s.auth = 'password';
    if (t === 'webdav' && !s.webdavAuth) s.webdavAuth = 'basic';
    s.type = t;
    markDirty(s);
    render();
  };
  rows.push(row('Type:', typeSelect(s.type, changeType, 'type'), undefined, 'type'));

  if (s.type === 'local') {
    const folder = textInput(s.rootPath, (v) => ((s.rootPath = v), markDirty(s)), { id: 'folder', placeholder: '/path/to/mounted/folder' });
    rows.push(
      row(
        'Folder:',
        withBrowse(folder, async () => {
          const p = await browseLocal(s.rootPath, true, false);
          if (p) {
            s.rootPath = p;
            folder.value = p;
            markDirty(s);
          }
        }),
        'Deployment target directory reachable through the file system (local, network share, mounted volume).',
        'folder',
      ),
      testArea(s),
    );
  } else if (s.type === 'webdav') {
    rows.push(
      row(
        'Server URL:',
        textInput(s.host, (v) => ((s.host = v), markDirty(s)), { id: 'host', placeholder: 'https://cloud.example.com/remote.php/dav/files/me', invalid: (v) => (/^https?:\/\/.+/.test(v) ? undefined : 'Enter an http(s) URL') }),
        undefined,
        'host',
      ),
      row(
        'Authentication:',
        select(s.webdavAuth ?? 'basic', [['basic', 'Basic'], ['digest', 'Digest'], ['none', 'None']], (v) => {
          s.webdavAuth = v;
          markDirty(s);
          render();
        }),
      ),
    );
    if (s.webdavAuth !== 'none') {
      rows.push(row('Username:', textInput(s.username, (v) => ((s.username = v), markDirty(s)), { id: 'username' }), undefined, 'username'), row('Password:', secretField(s, 'password')));
    }
    rows.push(testArea(s), rootPathRow(s));
  } else {
    rows.push(
      row(
        'Host:',
        h(
          'div',
          { class: 'host-port' },
          textInput(s.host, (v) => ((s.host = v.trim()), markDirty(s)), { id: 'host', placeholder: 'example.com', invalid: (v) => (v.trim() ? undefined : 'Host is required') }),
          h('label', { for: 'port' }, 'Port:'),
          textInput(s.port?.toString(), (v) => ((s.port = v ? Number(v) : undefined), markDirty(s)), { id: 'port', width: 'short', invalid: portValidator }),
        ),
        undefined,
        'host',
      ),
    );
    if (s.type === 'sftp') {
      rows.push(
        row('Username:', textInput(s.username, (v) => ((s.username = v), markDirty(s)), { id: 'username' }), undefined, 'username'),
        row(
          'Authentication:',
          select(
            s.auth ?? 'password',
            [
              ['password', 'Password'],
              ['key', 'Key pair (OpenSSH or PuTTY)'],
              ['openssh', 'OpenSSH config and authentication agent'],
              ['agent', 'Authentication agent'],
            ],
            (v) => {
              s.auth = v;
              markDirty(s);
              render();
            },
          ),
        ),
      );
      if (s.auth === 'password') rows.push(row('Password:', secretField(s, 'password')));
      if (s.auth === 'key') {
        const key = textInput(s.privateKeyPath, (v) => ((s.privateKeyPath = v), markDirty(s)), { id: 'key', placeholder: '~/.ssh/id_ed25519', invalid: (v) => (v.trim() ? undefined : 'Private key file is required') });
        rows.push(
          row(
            'Private key file:',
            withBrowse(key, async () => {
              const p = await browseLocal(s.privateKeyPath ?? '', false, false);
              if (p) {
                s.privateKeyPath = p;
                key.value = p;
                markDirty(s);
              }
            }),
            undefined,
            'key',
          ),
          row('Passphrase:', secretField(s, 'passphrase')),
        );
      }
      if (s.auth === 'openssh') {
        rows.push(
          row(
            'SSH config host:',
            textInput(s.sshConfigHost, (v) => ((s.sshConfigHost = v), markDirty(s)), { id: 'alias', placeholder: s.host || 'Host alias from ~/.ssh/config' }),
            'HostName, User, Port, IdentityFile and ProxyJump are read from ~/.ssh/config. Leave empty to use the host above.',
            'alias',
          ),
        );
      }
      rows.push(
        row(
          'Jump host:',
          textInput(s.jumpHost, (v) => ((s.jumpHost = v), markDirty(s)), { id: 'jump', placeholder: 'user@bastion.example.com:22 (optional)' }),
          'Connect through an SSH bastion (ProxyJump).',
          'jump',
        ),
      );
    } else {
      const anonymous = s.username === 'anonymous';
      rows.push(
        row(
          'Username:',
          h(
            'div',
            { class: 'inline' },
            textInput(s.username, (v) => ((s.username = v), markDirty(s)), { id: 'username' }),
            checkbox('Login as anonymous', anonymous, (v) => {
              s.username = v ? 'anonymous' : '';
              markDirty(s);
              render();
            }),
          ),
          undefined,
          'username',
        ),
      );
      if (!anonymous) rows.push(row('Password:', secretField(s, 'password')));
    }
    rows.push(testArea(s), rootPathRow(s));
  }

  rows.push(
    row(
      'Web server URL:',
      textInput(s.webUrl, (v) => ((s.webUrl = v), markDirty(s)), { id: 'web-url', placeholder: 'https://example.com', invalid: (v) => (!v || /^https?:\/\/.+/.test(v) ? undefined : 'Enter an http(s) URL') }),
      'Used for "Open in Browser" together with the web path of each mapping.',
      'web-url',
    ),
  );

  const advanced: Node[] = [];
  if (s.type.startsWith('ftp')) {
    advanced.push(
      checkbox('Passive mode', true, () => undefined, 'Always on: active-mode transfers are not supported.'),
      row('Encoding:', select((s.encoding ?? 'utf8') as string, ENCODINGS.map((e) => [e, e]), (v) => ((s.encoding = v === 'utf8' ? undefined : v), markDirty(s)))),
    );
  }
  if (s.type === 'ftps' || s.type === 'ftps-implicit' || (s.type === 'webdav' && s.host.startsWith('https'))) {
    advanced.push(
      checkbox(
        'Allow untrusted certificates (ask to accept)',
        !!s.allowUntrustedCertificate,
        (v) => ((s.allowUntrustedCertificate = v), markDirty(s)),
        s.trustedCertificateFingerprint ? `Accepted certificate: ${s.trustedCertificateFingerprint}` : 'Self-signed or mismatched certificates prompt for confirmation instead of failing.',
      ),
    );
    if (s.trustedCertificateFingerprint) {
      advanced.push(button('Forget accepted certificate', () => ((s.trustedCertificateFingerprint = undefined), markDirty(s), renderContent())));
    }
  }
  if (s.type === 'sftp') {
    advanced.push(
      row('Keep-alive interval (s):', textInput(s.keepAliveSeconds?.toString(), (v) => ((s.keepAliveSeconds = v ? Number(v) : undefined), markDirty(s)), { width: 'short', placeholder: '30' })),
      checkbox('Allow shell commands for content comparison (sha1sum)', !!s.allowShellCommands, (v) => ((s.allowShellCommands = v), markDirty(s))),
    );
  }
  if (s.type !== 'local') {
    advanced.push(
      row('Max. connections:', textInput(s.maxConnections?.toString(), (v) => ((s.maxConnections = v ? Math.max(1, Number(v)) : undefined), markDirty(s)), { width: 'short', placeholder: s.type === 'sftp' ? '2' : '4' })),
    );
  }

  return h(
    'div',
    { class: 'tab-body' },
    h('div', { class: 'form' }, ...rows),
    advanced.length ? h('details', { class: 'advanced' }, h('summary', {}, 'Advanced'), h('div', { class: 'form' }, ...advanced)) : null,
  );
};

// ---- Mappings tab ---------------------------------------------------------------------------------

const renderMappings = (s: UiServer): HTMLElement => {
  const p = project()!;
  const rows = s.mappings.map((m, i) => {
    const local = textInput(m.local, (v) => ((m.local = v), markDirty()), { placeholder: `${p.name} (project root)` });
    const remote = textInput(m.remote, (v) => ((m.remote = v), markDirty()), { placeholder: '/', invalid: (v) => (v.trim() ? undefined : 'Deployment path is required') });
    const web = textInput(m.web, (v) => ((m.web = v), markDirty()), { placeholder: '/' });
    return h(
      'tr',
      {},
      h('td', {}, withBrowse(local, async () => {
        const picked = await browseLocal(m.local, true, true);
        if (picked !== undefined) {
          m.local = picked;
          local.value = picked;
          markDirty();
        }
      })),
      h('td', {}, s.type === 'local' ? remote : withBrowse(remote, async () => {
        const base = (s.rootPath || '/').replace(/\/$/, '');
        const picked = await browseRemote(s, `${base}${m.remote.startsWith('/') ? '' : '/'}${m.remote}`);
        if (picked !== undefined) {
          m.remote = relativeToRoot(s, picked);
          remote.value = m.remote;
          markDirty();
        }
      }, 'Browse server…')),
      h('td', {}, web),
      h('td', { class: 'actions' }, iconButton('trash', 'Remove mapping', () => {
        s.mappings.splice(i, 1);
        markDirty();
        renderContent();
      })),
    );
  });
  return h(
    'div',
    { class: 'tab-body' },
    h('p', { class: 'description' }, 'Map local folders to deployment paths on the server. The longest matching local path wins.'),
    h(
      'table',
      { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Local path'), h('th', {}, `Deployment path (relative to ${s.rootPath || 'root'})`), h('th', {}, 'Web path'), h('th', {}, ''))),
      h('tbody', {}, ...rows),
    ),
    rows.length === 0 ? h('div', { class: 'empty' }, 'No mappings: files cannot be uploaded to this server.') : null,
    h('div', { class: 'table-actions' }, button('Add mapping', () => {
      s.mappings.push({ local: '', remote: '/', web: '/' });
      markDirty();
      renderContent();
    }, { icon: 'add' })),
  );
};

// ---- Excluded paths tab --------------------------------------------------------------------------

const renderExcluded = (s: UiServer): HTMLElement => {
  const list = (items: string[], kind: 'local' | 'remote') =>
    h(
      'ul',
      { class: 'path-list' },
      ...items.map((path, i) =>
        h(
          'li',
          {},
          icon(kind === 'local' ? 'file-directory' : 'cloud'),
          textInput(path, (v) => ((items[i] = v), markDirty())),
          iconButton('trash', 'Remove', () => {
            items.splice(i, 1);
            markDirty();
            renderContent();
          }),
        ),
      ),
    );
  const addLocal = async () => {
    const p = await browseLocal('', true, true);
    if (p) {
      s.excludedLocal.push(p);
      markDirty();
      renderContent();
    }
  };
  const addRemote = async () => {
    const p = s.type === 'local' ? await browseLocal(s.rootPath, true, false) : await browseRemote(s, s.rootPath);
    if (p) {
      s.excludedRemote.push(p);
      markDirty();
      renderContent();
    }
  };
  return h(
    'div',
    { class: 'tab-body' },
    h('p', { class: 'description' }, 'Excluded paths are never uploaded, downloaded or synchronized.'),
    h('h3', {}, 'Local paths'),
    list(s.excludedLocal, 'local'),
    h('div', { class: 'table-actions' }, button('Add local path…', () => void addLocal(), { icon: 'add' }), button('Add as text', () => (s.excludedLocal.push(''), markDirty(), renderContent()))),
    h('h3', {}, 'Deployment paths'),
    list(s.excludedRemote, 'remote'),
    h('div', { class: 'table-actions' }, button('Add deployment path…', () => void addRemote(), { icon: 'add' }), button('Add as text', () => (s.excludedRemote.push(''), markDirty(), renderContent()))),
  );
};

// ---- Options page ----------------------------------------------------------------------------------

const renderOptions = (o: UiOptions): HTMLElement => {
  const permRow = (label: string, key: 'filePermissions' | 'folderPermissions', fallback: string) => {
    const enabled = o[key] !== '';
    const input = textInput(o[key] || fallback, (v) => ((o[key] = v), markDirty()), { width: 'short', invalid: (v) => (/^[0-7]{3,4}$/.test(v) ? undefined : 'Octal mode, e.g. 644') });
    input.disabled = !enabled;
    return h(
      'div',
      { class: 'option-line' },
      checkbox(label, enabled, (v) => {
        o[key] = v ? input.value || fallback : '';
        input.disabled = !v;
        markDirty();
      }),
      input,
    );
  };
  const labeled = (label: string, control: HTMLElement, hint?: string) => {
    const id = `opt${++fieldSeq}`;
    control.id = id;
    return h('div', { class: 'option-line', title: hint }, h('label', { for: id }, label), control);
  };
  const section = (title: string, ...children: Node[]) => h('section', { class: 'option-section' }, h('h3', {}, title), ...children);
  const sub = (...children: Node[]) => h('div', { class: 'option-sub' }, ...children);
  return h(
    'div',
    { class: 'options' },
    section(
      'Upload',
      labeled(
        'Upload changed files automatically to the default server:',
        select(o.autoUpload, [['always', 'Always'], ['onExplicitSave', 'On explicit save action (⌘S / Ctrl+S)'], ['never', 'Never']], (v) => ((o.autoUpload = v), markDirty())),
      ),
      sub(
        checkbox('Skip external changes', o.skipExternalChanges, (v) => ((o.skipExternalChanges = v), markDirty()), 'Ignore files changed outside the editor (git checkout, build tools) when uploading automatically.'),
        checkbox('Delete remote files when local are deleted', o.deleteRemoteOnLocalDelete, (v) => ((o.deleteRemoteOnLocalDelete = v), markDirty())),
      ),
      checkbox('Create empty directories', o.createEmptyDirectories, (v) => ((o.createEmptyDirectories = v), markDirty())),
      checkbox('Preserve file timestamps', o.preserveTimestamps, (v) => ((o.preserveTimestamps = v), markDirty())),
      checkbox('Overwrite up-to-date files', o.overwriteUpToDate, (v) => ((o.overwriteUpToDate = v), markDirty()), 'During sync, also offer to upload files that are already identical.'),
      labeled(
        'Warn when uploading over newer file:',
        select(o.warnOnNewerRemote, [['timestampAndSize', 'Compare timestamp and size'], ['content', 'Compare content'], ['none', 'No']], (v) => ((o.warnOnNewerRemote = v), markDirty())),
      ),
      labeled(
        'Parallel transfers:',
        textInput(String(o.concurrency), (v) => ((o.concurrency = Math.min(16, Math.max(1, Number(v) || 1))), markDirty()), { width: 'short', invalid: (v) => (/^\d+$/.test(v) && +v >= 1 && +v <= 16 ? undefined : '1–16') }),
      ),
    ),
    section(
      'Remote files',
      checkbox('Notify about remote changes', o.notifyRemoteChanges, (v) => ((o.notifyRemoteChanges = v), markDirty()), 'Re-check open remote files when VS Code regains focus.'),
      checkbox('Confirm deleting remote files', o.confirmRemoteDelete, (v) => ((o.confirmRemoteDelete = v), markDirty())),
    ),
    section('Permissions', permRow('Override default permissions on files:', 'filePermissions', '644'), permRow('Override default permissions on folders:', 'folderPermissions', '755')),
    section(
      'Exclude',
      h(
        'div',
        { class: 'option-stack', title: 'Semicolon-separated names or wildcards, matched against every path segment.' },
        h('label', { for: 'exclude-names' }, 'Exclude items by name:'),
        textInput(o.excludeNames.join(';'), (v) => ((o.excludeNames = v.split(';').map((x) => x.trim()).filter(Boolean)), markDirty()), { id: 'exclude-names', placeholder: '.git;.idea;node_modules;*.log' }),
      ),
    ),
  );
};

// ---- Content -------------------------------------------------------------------------------------------

const renderContent = () => {
  const p = project();
  if (!p) {
    contentEl.replaceChildren(h('div', { class: 'placeholder' }, icon('folder'), h('p', {}, 'Open a folder or workspace to configure deployment.')));
    return;
  }
  if (selection?.kind === 'options') {
    contentEl.replaceChildren(h('div', { class: 'page-header' }, h('h2', {}, 'Options')), h('div', { class: 'tab-scroll' }, renderOptions(p.options)));
    return;
  }
  const s = currentServer();
  if (!s) {
    contentEl.replaceChildren(
      h(
        'div',
        { class: 'placeholder' },
        icon('server-environment'),
        h('p', {}, 'Add a server with + or import an existing PhpStorm configuration.'),
        button('Import from PhpStorm', () => post({ type: 'importPhpStorm' }), { icon: 'cloud-download' }),
      ),
    );
    return;
  }
  const scrollTop = contentEl.scrollTop;
  const visibility = checkbox('Visible only for this project', s.scope === 'project', (v) => {
    if (v) {
      s.scope = 'project';
      for (const other of projects) if (other.key !== activeKey) other.servers = other.servers.filter((x) => x.id !== s.id);
    } else {
      s.scope = 'global';
      for (const other of projects) {
        if (other.key === activeKey || other.servers.some((x) => x.id === s.id)) continue;
        other.servers.push({ ...JSON.parse(JSON.stringify(s)), mappings: [], excludedLocal: [], excludedRemote: [] });
      }
    }
    markDirty();
    renderSidebar();
  }, 'When unchecked, the connection is shared with all projects; mappings stay per project.');
  const tabs: [Tab, string][] = [['connection', 'Connection'], ['mappings', 'Mappings'], ['excluded', 'Excluded Paths']];
  const tabBar = h(
    'div',
    { class: 'tabs', role: 'tablist' },
    ...tabs.map(([t, label]) =>
      h('button', { role: 'tab', class: tab === t ? 'active' : '', 'aria-selected': String(tab === t), on: { click: () => ((tab = t), renderContent()) } }, label),
    ),
  );
  const body = tab === 'connection' ? renderConnection(s) : tab === 'mappings' ? renderMappings(s) : renderExcluded(s);
  contentEl.replaceChildren(tabBar, h('div', { class: 'tab-scroll' }, tab === 'connection' ? h('div', { class: 'visibility' }, visibility) : null, body));
  contentEl.scrollTop = scrollTop;
};

// ---- Footer / save ------------------------------------------------------------------------------------

const validate = (): { message: string; serverId?: string; tab?: Tab } | undefined => {
  for (const p of projects) {
    const names = new Set<string>();
    for (const s of p.servers) {
      const where = { serverId: s.id };
      if (!s.name.trim()) return { message: 'Every server needs a name.', ...where, tab: 'connection' };
      if (names.has(s.name.trim())) return { message: `Duplicate server name "${s.name}" in ${p.name}.`, ...where, tab: 'connection' };
      names.add(s.name.trim());
      if (s.type === 'local' && !s.rootPath.trim()) return { message: `${s.name}: choose the target folder.`, ...where, tab: 'connection' };
      if (s.type !== 'local' && !s.host.trim()) return { message: `${s.name}: host is required.`, ...where, tab: 'connection' };
      if (s.type === 'webdav' && !/^https?:\/\/.+/.test(s.host)) return { message: `${s.name}: WebDAV URL must start with http:// or https://.`, ...where, tab: 'connection' };
      if (s.port !== undefined && (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535)) return { message: `${s.name}: invalid port.`, ...where, tab: 'connection' };
      if (s.type === 'sftp' && s.auth === 'key' && !s.privateKeyPath?.trim()) return { message: `${s.name}: choose a private key file.`, ...where, tab: 'connection' };
      if (s.webUrl && !/^https?:\/\/.+/.test(s.webUrl)) return { message: `${s.name}: web server URL must start with http:// or https://.`, ...where, tab: 'connection' };
      if (s.mappings.some((m) => !m.remote.trim())) return { message: `${s.name}: every mapping needs a deployment path.`, ...where, tab: 'mappings' };
    }
    const o = p.options;
    if (o.filePermissions && !/^[0-7]{3,4}$/.test(o.filePermissions)) return { message: 'File permissions must be an octal mode such as 644.' };
    if (o.folderPermissions && !/^[0-7]{3,4}$/.test(o.folderPermissions)) return { message: 'Folder permissions must be an octal mode such as 755.' };
  }
  return undefined;
};

const save = (close: boolean) => {
  for (const p of projects) for (const s of p.servers) for (const m of s.mappings) m.local = m.local.trim();
  const problem = validate();
  if (problem) {
    status = { kind: 'error', text: problem.message };
    if (problem.serverId) {
      const owner = projects.find((p) => p.servers.some((s) => s.id === problem.serverId));
      if (owner) activeKey = owner.key;
      selection = { kind: 'server', id: problem.serverId };
      tab = problem.tab ?? tab;
    } else {
      selection = { kind: 'options' };
    }
    render();
    return;
  }
  status = { kind: 'info', text: 'Saving…' };
  renderFooter();
  post({ type: 'save', projects, secrets: secretChanges, close });
};

const renderFooter = () => {
  const statusEl = status
    ? h('div', { class: `status ${status.kind}` }, icon(status.kind === 'error' ? 'error' : status.kind === 'ok' ? 'check' : 'info'), status.text)
    : problems.length
      ? h('div', { class: 'status error', title: problems.join('\n') }, icon('warning'), `${problems.length} configuration problem(s): ${problems[0]}`)
      : h('div', { class: 'status' }, dirty ? 'Unsaved changes' : '');
  footerEl.replaceChildren(
    h('div', { class: 'footer-left' }, statusEl),
    h('div', { class: 'footer-right' }, button('Cancel', () => post({ type: 'cancel' })), button('OK', () => save(true), { primary: true, title: '⌘S applies without closing' })),
  );
};

const render = () => {
  sidebarEl = h('aside', { class: 'sidebar' });
  contentEl = h('main', { class: 'content' });
  footerEl = h('footer', { class: 'footer' });
  root.replaceChildren(h('div', { class: 'dialog' }, h('div', { class: 'body' }, sidebarEl, contentEl), footerEl));
  renderSidebar();
  renderContent();
  renderFooter();
};

// ---- Messages ----------------------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<SettingsToWebview>) => {
  const m = event.data;
  switch (m.type) {
    case 'init': {
      projects = m.projects;
      activeKey = projects.some((p) => p.key === m.activeProject) ? m.activeProject : (projects[0]?.key ?? '');
      secrets = m.secrets;
      secretChanges = {};
      problems = m.problems;
      dirty = false;
      const p = project();
      const wanted = m.selectedServer && p?.servers.find((s) => s.id === m.selectedServer);
      const prev = selection;
      const keep = prev?.kind === 'server' ? (p?.servers.some((s) => s.id === prev.id) ? prev : undefined) : prev;
      selection = wanted ? { kind: 'server', id: wanted.id } : (keep ?? (p?.servers[0] ? { kind: 'server', id: p.servers[0].id } : undefined));
      render();
      return;
    }
    case 'saved':
      if (m.ok) {
        dirty = false;
        status = { kind: 'ok', text: 'Settings saved.' };
        problems = m.problems ?? problems;
      } else {
        status = { kind: 'error', text: m.message ?? 'Saving failed.' };
      }
      renderFooter();
      return;
    case 'result':
      pending.get(m.requestId)?.(m);
      pending.delete(m.requestId);
      return;
  }
});

document.addEventListener('keydown', (e) => {
  // Escape first closes an open menu; stopping it here keeps VS Code from closing the whole popup.
  if (e.key === 'Escape' && document.querySelector('.popup-menu')) {
    e.stopPropagation();
    e.preventDefault();
    closeMenus();
    (sidebarEl.querySelector('li.selected') as HTMLElement | null)?.focus();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save(false);
  }
});

post({ type: 'ready' });
