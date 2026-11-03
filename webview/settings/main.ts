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
  sftp: 'lock',
  ftp: 'globe',
  ftps: 'shield',
  'ftps-implicit': 'shield',
  webdav: 'cloud',
  local: 'folder',
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

const row = (label: string, control: Node, hint?: string, id?: string) =>
  h('div', { class: 'form-row' }, h('label', { for: id }, label), h('div', { class: 'control' }, control, hint ? h('div', { class: 'hint' }, hint) : null));

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
  return h('div', { class: 'checkbox-row' }, input, h('label', { for: id }, label), hint ? h('div', { class: 'hint' }, hint) : null);
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

const withBrowse = (input: HTMLInputElement, onBrowse: () => void, title = 'Browse…') => h('div', { class: 'input-with-button' }, input, iconButton('folder-opened', title, onBrowse));

// ---- Remote browser (modal) ----------------------------------------------------------------------

const browseRemote = (server: UiServer, startPath: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    let current = startPath || server.rootPath || '/';
    const overlay = h('div', { class: 'modal-overlay' });
    const list = h('ul', { class: 'remote-list', role: 'listbox' });
    const pathInput = h('input', { type: 'text', value: current, spellcheck: 'false' });
    const message = h('div', { class: 'modal-message' });
    const close = (result?: string) => {
      overlay.remove();
      resolve(result);
    };
    const load = async (path: string) => {
      message.textContent = 'Loading…';
      list.replaceChildren();
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
      if (current !== '/') items.push(h('li', { class: 'dir', tabindex: '0', on: { dblclick: () => void load(parent), keydown: (e) => (e as KeyboardEvent).key === 'Enter' && void load(parent) } }, icon('arrow-up'), '..'));
      for (const e of r.entries ?? []) {
        if (!e.isDir) {
          items.push(h('li', { class: 'file' }, icon('file'), e.name));
          continue;
        }
        const target = `${current.replace(/\/$/, '')}/${e.name}`;
        items.push(
          h('li', { class: 'dir', tabindex: '0', on: { dblclick: () => void load(target), keydown: (ev) => (ev as KeyboardEvent).key === 'Enter' && void load(target) } }, icon('folder'), e.name),
        );
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
        h('div', { class: 'modal-buttons' }, button('Cancel', () => close()), button('Select', () => close(current), { primary: true })),
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
  document.getElementById('server-name')?.focus();
};

const showAddMenu = (anchor: HTMLElement) => {
  document.querySelector('.popup-menu')?.remove();
  const rect = anchor.getBoundingClientRect();
  const menu = h(
    'div',
    { class: 'popup-menu', role: 'menu' },
    ...(Object.keys(TYPE_LABELS) as ServerType[]).map((t) =>
      h('button', { role: 'menuitem', on: { click: () => (menu.remove(), addServer(t)) } }, icon(TYPE_ICONS[t]), TYPE_LABELS[t]),
    ),
  );
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 2}px`;
  document.body.append(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }));
  (menu.firstElementChild as HTMLElement | null)?.focus();
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

const renderSidebar = () => {
  const p = project();
  const servers = p?.servers ?? [];
  const sel = currentServer();
  const addBtn = iconButton('add', 'Add server', () => showAddMenu(addBtn));
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    addBtn,
    iconButton('remove', 'Remove server', removeServer, !sel),
    iconButton('copy', 'Copy server', copyServer, !sel),
    iconButton(sel && p?.defaultServer === sel.id ? 'star-full' : 'star-empty', 'Use as default server', toggleDefault, !sel),
  );
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
          'aria-selected': String(selection?.kind === 'server' && selection.id === s.id),
          title: `${TYPE_LABELS[s.type]}${s.scope === 'global' ? ' · shared with all projects' : ''}`,
          on: {
            click: () => {
              selection = { kind: 'server', id: s.id };
              render();
            },
            keydown: (e) => {
              const k = (e as KeyboardEvent).key;
              const i = servers.indexOf(s);
              const next = k === 'ArrowDown' ? servers[i + 1] : k === 'ArrowUp' ? servers[i - 1] : undefined;
              if (next) {
                selection = { kind: 'server', id: next.id };
                render();
                (sidebarEl.querySelector('li.selected') as HTMLElement | null)?.focus();
              }
            },
          },
        },
        icon(TYPE_ICONS[s.type]),
        h('span', { class: 'name' }, s.name || '(unnamed)'),
        s.scope === 'global' ? icon('globe', 'Shared with all projects') : null,
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
  sidebarEl.replaceChildren(
    h('div', { class: 'section-title' }, 'Servers'),
    toolbar,
    servers.length ? list : h('div', { class: 'empty' }, 'No servers. Click + to add one.'),
    h('div', { class: 'sidebar-footer' }, options),
  );
};

// ---- Connection tab ----------------------------------------------------------------------------------

const secretField = (s: UiServer, kind: 'password' | 'passphrase') => {
  const has = kind === 'password' ? secrets[s.id]?.hasPassword : secrets[s.id]?.hasPassphrase;
  const change = secretChanges[s.id];
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
    { class: 'test-area' },
    button('Test Connection', () => void run(), { icon: 'plug', disabled: result?.running }),
    result ? h('span', { class: `test-result ${result.running ? 'running' : result.ok ? 'ok' : 'error'}` }, icon(result.running ? 'loading codicon-modifier-spin' : result.ok ? 'pass' : 'error'), result.message) : null,
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
    h('div', { class: 'input-with-button' }, input, iconButton('folder-opened', 'Browse server…', () => void browse()), button('Autodetect', () => void detect())),
    'All deployment paths are relative to this folder.',
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
  rows.push(row('Type:', select(s.type, (Object.keys(TYPE_LABELS) as ServerType[]).map((t) => [t, TYPE_LABELS[t]]), changeType, 'type'), undefined, 'type'));

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
    rows.push(rootPathRow(s));
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
            checkbox('Anonymous login', anonymous, (v) => {
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
    rows.push(rootPathRow(s));
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
    testArea(s),
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
      { class: 'inline' },
      checkbox(label, enabled, (v) => {
        o[key] = v ? input.value || fallback : '';
        input.disabled = !v;
        markDirty();
      }),
      input,
    );
  };
  return h(
    'div',
    { class: 'tab-body options' },
    h('h2', {}, 'Options'),
    h(
      'div',
      { class: 'form' },
      row(
        'Upload changed files automatically to the default server:',
        select(o.autoUpload, [['always', 'Always'], ['onExplicitSave', 'On explicit save action (Ctrl/Cmd+S)'], ['never', 'Never']], (v) => ((o.autoUpload = v), markDirty())),
      ),
      checkbox('Skip external changes', o.skipExternalChanges, (v) => ((o.skipExternalChanges = v), markDirty()), 'Ignore files changed outside the editor (git checkout, build tools) when uploading automatically.'),
      checkbox('Delete remote files when local are deleted', o.deleteRemoteOnLocalDelete, (v) => ((o.deleteRemoteOnLocalDelete = v), markDirty())),
      checkbox('Create empty directories', o.createEmptyDirectories, (v) => ((o.createEmptyDirectories = v), markDirty())),
      checkbox('Preserve file timestamps', o.preserveTimestamps, (v) => ((o.preserveTimestamps = v), markDirty())),
      row(
        'Warn when uploading over newer file:',
        select(o.warnOnNewerRemote, [['timestampAndSize', 'Compare timestamp and size'], ['content', 'Compare content'], ['none', 'No']], (v) => ((o.warnOnNewerRemote = v), markDirty())),
      ),
      checkbox('Notify about remote changes', o.notifyRemoteChanges, (v) => ((o.notifyRemoteChanges = v), markDirty()), 'Re-check open remote files when VS Code regains focus.'),
      checkbox('Confirm deleting remote files', o.confirmRemoteDelete, (v) => ((o.confirmRemoteDelete = v), markDirty())),
      checkbox('Overwrite up-to-date files', o.overwriteUpToDate, (v) => ((o.overwriteUpToDate = v), markDirty()), 'During sync, also offer to upload files that are already identical.'),
      permRow('Override default permissions on files:', 'filePermissions', '644'),
      permRow('Override default permissions on folders:', 'folderPermissions', '755'),
      row(
        'Exclude items by name:',
        textInput(o.excludeNames.join(';'), (v) => ((o.excludeNames = v.split(';').map((x) => x.trim()).filter(Boolean)), markDirty()), { placeholder: '.git;.idea;node_modules;*.log' }),
        'Semicolon-separated names or wildcards, matched against every path segment.',
      ),
      row(
        'Parallel transfers:',
        textInput(String(o.concurrency), (v) => ((o.concurrency = Math.min(16, Math.max(1, Number(v) || 1))), markDirty()), { width: 'short', invalid: (v) => (/^\d+$/.test(v) && +v >= 1 && +v <= 16 ? undefined : '1–16') }),
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
    contentEl.replaceChildren(renderOptions(p.options));
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
  const header = h(
    'div',
    { class: 'server-header' },
    row(
      'Name:',
      textInput(s.name, (v) => {
        s.name = v;
        markDirty(s);
        const li = sidebarEl.querySelector('li.selected .name');
        if (li) li.textContent = v || '(unnamed)';
      }, { id: 'server-name', invalid: (v) => (v.trim() ? undefined : 'Name is required') }),
      undefined,
      'server-name',
    ),
    checkbox('Visible only for this project', s.scope === 'project', (v) => {
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
    }, 'When unchecked, the connection is shared with all projects; mappings stay per project.'),
  );
  const tabs: [Tab, string][] = [['connection', 'Connection'], ['mappings', 'Mappings'], ['excluded', 'Excluded Paths']];
  const tabBar = h(
    'div',
    { class: 'tabs', role: 'tablist' },
    ...tabs.map(([t, label]) =>
      h('button', { role: 'tab', class: tab === t ? 'active' : '', 'aria-selected': String(tab === t), on: { click: () => ((tab = t), renderContent()) } }, label),
    ),
  );
  const body = tab === 'connection' ? renderConnection(s) : tab === 'mappings' ? renderMappings(s) : renderExcluded(s);
  contentEl.replaceChildren(header, tabBar, body);
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
    h('div', { class: 'footer-left' }, button('Import from PhpStorm', () => post({ type: 'importPhpStorm' }), { icon: 'cloud-download', title: 'Read .idea/deployment.xml and webServers.xml' }), statusEl),
    h(
      'div',
      { class: 'footer-right' },
      button('Cancel', () => post({ type: 'cancel' })),
      button('Apply', () => save(false), { disabled: !dirty }),
      button('OK', () => save(true), { primary: true }),
    ),
  );
};

const renderHeader = (): HTMLElement => {
  const header = h('header', { class: 'header' }, h('h1', {}, icon('server-environment'), 'Deployment'));
  if (projects.length > 1) {
    header.append(
      h(
        'div',
        { class: 'project-select' },
        h('label', { for: 'project' }, 'Project:'),
        select(activeKey, projects.map((p) => [p.key, p.name]), (v) => {
          activeKey = v;
          const first = project()?.servers[0];
          selection = first ? { kind: 'server', id: first.id } : undefined;
          render();
        }, 'project'),
      ),
    );
  }
  return header;
};

const render = () => {
  sidebarEl = h('aside', { class: 'sidebar' });
  contentEl = h('main', { class: 'content' });
  footerEl = h('footer', { class: 'footer' });
  root.replaceChildren(h('div', { class: 'dialog' }, renderHeader(), h('div', { class: 'body' }, sidebarEl, contentEl), footerEl));
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
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save(false);
  }
});

post({ type: 'ready' });
