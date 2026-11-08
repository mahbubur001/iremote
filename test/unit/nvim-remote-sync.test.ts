import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServer, type Answers, type Client } from './nvimClient';

const exists = (p: string) => fs.stat(p).then(() => true, () => false);
const read = (p: string) => fs.readFile(p, 'utf8');

const until = async (cond: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

const project = async (options: Record<string, unknown>) => {
  const base = await fs.mkdtemp(join(tmpdir(), 'iremote-nvim-p23-'));
  const root = join(base, 'project');
  const remote = join(base, 'remote');
  await fs.mkdir(join(root, '.vscode'), { recursive: true });
  await fs.mkdir(join(remote, 'site'), { recursive: true });
  await fs.writeFile(
    join(root, '.vscode', 'iremote.json'),
    JSON.stringify({
      version: 1,
      defaultServer: 'disk',
      options,
      servers: [{ id: 'disk', name: 'Disk', type: 'local', rootPath: remote, mappings: [{ local: '', remote: '/site', web: '/' }] }],
    }),
  );
  return { base, root, remote, site: join(remote, 'site') };
};

const init = (client: Client, base: string) => client.call('initialize', { stateDir: join(base, 'state'), globalServersFile: join(base, 'none.json') });

test('nvim remote host: list, open/edit/save with conflict check, new, rename, chmod, delete, download, upload here', async () => {
  const p = await project({ autoUpload: 'never' });
  const asked: string[] = [];
  const answers: Answers = { confirm: (q) => (asked.push(String(q.message)), 'Cancel') };
  const { child, client } = startServer(answers);
  try {
    await init(client, p.base);
    await fs.mkdir(join(p.site, 'css'));
    await fs.writeFile(join(p.site, 'index.php'), 'remote v1');
    await fs.writeFile(join(p.site, 'css', 'app.css'), 'body{}');

    const root = await client.call<{ serverId: string; root: string; isDefault: boolean }>('remoteRoot', { path: p.root });
    assert.equal(root.serverId, 'disk');
    assert.equal(root.root, p.remote);
    assert.equal(root.isDefault, true);

    const list = await client.call<{ name: string; type: string; local: string | null }[]>('remoteList', { path: p.root, serverId: 'disk', remotePath: p.site });
    assert.deepEqual(list.map((e) => `${e.type}:${e.name}`), ['directory:css', 'file:index.php']);
    assert.equal(list[1].local, join(p.root, 'index.php'));

    // Open a remote file (no local copy yet) → temp copy; save writes it back.
    const opened = await client.call<{ path: string; remote: boolean }>('remoteOpen', { path: p.root, serverId: 'disk', remotePath: join(p.site, 'index.php'), preferLocal: true });
    assert.equal(opened.remote, true);
    assert.equal(await read(opened.path), 'remote v1');
    await fs.writeFile(opened.path, 'edited in nvim');
    assert.deepEqual(await client.call('remoteSave', { path: p.root, tmpPath: opened.path }), { saved: true, server: 'Disk' });
    assert.equal(await read(join(p.site, 'index.php')), 'edited in nvim');

    // Changed on the server meanwhile → asked, "Cancel" keeps the server version; remoteCheck reports it.
    await fs.writeFile(join(p.site, 'index.php'), 'changed by someone else!');
    assert.deepEqual(await client.call('remoteCheck', { path: p.root, tmpPaths: [opened.path] }), [opened.path]);
    await fs.writeFile(opened.path, 'my second edit');
    assert.deepEqual(await client.call('remoteSave', { path: p.root, tmpPath: opened.path }), { saved: false });
    assert.equal(asked.length, 1);
    assert.equal(await read(join(p.site, 'index.php')), 'changed by someone else!');
    await client.call('remoteReload', { path: p.root, tmpPath: opened.path });
    assert.equal(await read(opened.path), 'changed by someone else!');

    // A mapped local file is preferred when present.
    await fs.writeFile(join(p.root, 'index.php'), 'local');
    const local = await client.call<{ path: string; remote: boolean }>('remoteOpen', { path: p.root, serverId: 'disk', remotePath: join(p.site, 'index.php'), preferLocal: true });
    assert.deepEqual(local, { path: join(p.root, 'index.php'), remote: false });

    // New folder / file, rename, chmod, delete.
    await client.call('remoteMkdir', { path: p.root, serverId: 'disk', remotePath: join(p.site, 'js') });
    await client.call('remoteNewFile', { path: p.root, serverId: 'disk', remotePath: join(p.site, 'js', 'a.js') });
    assert.equal(await read(join(p.site, 'js', 'a.js')), '');
    await assert.rejects(client.call('remoteNewFile', { path: p.root, serverId: 'disk', remotePath: join(p.site, 'js', 'a.js') }), /already exists/);
    await client.call('remoteRename', { path: p.root, serverId: 'disk', from: join(p.site, 'js', 'a.js'), to: join(p.site, 'js', 'b.js') });
    assert.equal(await exists(join(p.site, 'js', 'b.js')), true);
    await client.call('remoteChmod', { path: p.root, serverId: 'disk', remotePaths: [join(p.site, 'js', 'b.js')], mode: '600' });
    assert.equal((await fs.stat(join(p.site, 'js', 'b.js'))).mode & 0o777, 0o600);
    await assert.rejects(client.call('remoteChmod', { path: p.root, serverId: 'disk', remotePaths: [join(p.site, 'js')], mode: 'rwx' }), /Invalid permissions/);
    await client.call('remoteDelete', { path: p.root, serverId: 'disk', remotePaths: [{ path: join(p.site, 'js'), isDir: true }] });
    assert.equal(await exists(join(p.site, 'js')), false);

    // Download a remote folder to its mapped local path.
    const down = await client.call<{ transferred: number }>('remoteDownload', { path: p.root, serverId: 'disk', remotePaths: [join(p.site, 'css')] });
    assert.equal(down.transferred, 1);
    assert.equal(await read(join(p.root, 'css', 'app.css')), 'body{}');

    // Upload Here: an unmapped local file into an arbitrary remote folder.
    const outside = join(p.base, 'outside.txt');
    await fs.writeFile(outside, 'from elsewhere');
    await fs.mkdir(join(p.remote, 'drop'));
    const up = await client.call<{ transferred: number }>('remoteUploadHere', { path: p.root, serverId: 'disk', localPaths: [outside], remoteDir: join(p.remote, 'drop') });
    assert.equal(up.transferred, 1);
    assert.equal(await read(join(p.remote, 'drop', 'outside.txt')), 'from elsewhere');
  } finally {
    await stopServer(client, child);
    await fs.rm(p.base, { recursive: true, force: true });
  }
});

test('nvim sync: compare and apply upload / download / delete actions', async () => {
  const p = await project({ autoUpload: 'never' });
  const { child, client } = startServer({ confirm: () => 'Synchronize' });
  try {
    await init(client, p.base);
    await fs.writeFile(join(p.root, 'only-local.php'), 'L');
    await fs.writeFile(join(p.site, 'only-remote.php'), 'R');
    await fs.writeFile(join(p.root, 'gone.php'), 'G');
    const old = new Date(Date.now() - 3_600_000);
    await fs.writeFile(join(p.root, 'both.php'), 'old local');
    await fs.utimes(join(p.root, 'both.php'), old, old);
    await fs.writeFile(join(p.site, 'both.php'), 'newer remote');

    type Item = { id: number; state: string; action: string; rel: string };
    const cmp = await client.call<{ token: number; items: Item[] }>('syncCompare', { paths: [p.root] });
    const byRel = Object.fromEntries(cmp.items.map((i) => [i.rel, i]));
    assert.equal(byRel['only-local.php'].state, 'localOnly');
    assert.equal(byRel['only-local.php'].action, 'upload');
    assert.equal(byRel['only-remote.php'].state, 'remoteOnly');
    assert.equal(byRel['both.php'].state, 'remoteNewer');
    assert.equal(byRel['both.php'].action, 'download');
    assert.equal(byRel['.vscode/iremote.json'], undefined, 'excluded by default names');

    const results = await client.call<{ id: number; status: string }[]>('syncRun', {
      token: cmp.token,
      actions: [
        { id: byRel['only-local.php'].id, action: 'upload' },
        { id: byRel['only-remote.php'].id, action: 'deleteRemote' },
        { id: byRel['both.php'].id, action: 'download' },
        { id: byRel['gone.php'].id, action: 'skip' },
      ],
    });
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.status === 'done'));
    assert.equal(await read(join(p.site, 'only-local.php')), 'L');
    assert.equal(await exists(join(p.site, 'only-remote.php')), false);
    assert.equal(await read(join(p.root, 'both.php')), 'newer remote');
    assert.equal(await exists(join(p.site, 'gone.php')), false);

    // After syncing, a new comparison sees those files as the same.
    const again = await client.call<{ items: Item[] }>('syncCompare', { paths: [p.root] });
    assert.equal(again.items.find((i) => i.rel === 'both.php')!.state, 'same');
    await assert.rejects(client.call('syncRun', { token: 999, actions: [] }), /expired/);
  } finally {
    await stopServer(client, child);
    await fs.rm(p.base, { recursive: true, force: true });
  }
});

test('nvim auto-upload: created, renamed, deleted files and external changes ("Always" mode)', async () => {
  const p = await project({ autoUpload: 'always', skipExternalChanges: false, deleteRemoteOnLocalDelete: true, warnOnNewerRemote: 'none' });
  const { child, client } = startServer();
  try {
    await init(client, p.base);
    // Loading the project (any call with a path inside it) starts the external-change watcher.
    await client.call('status', { path: p.root });

    await fs.writeFile(join(p.root, 'new.php'), 'n');
    await client.call('fileCreated', { path: join(p.root, 'new.php') });
    assert.equal(await read(join(p.site, 'new.php')), 'n');

    await fs.rename(join(p.root, 'new.php'), join(p.root, 'renamed.php'));
    await client.call('fileRenamed', { from: join(p.root, 'new.php'), to: join(p.root, 'renamed.php') });
    assert.equal(await exists(join(p.site, 'new.php')), false);
    assert.equal(await read(join(p.site, 'renamed.php')), 'n');

    await fs.rm(join(p.root, 'renamed.php'));
    assert.equal(await client.call('fileDeleted', { path: join(p.root, 'renamed.php'), isDir: false }), true);
    assert.equal(await exists(join(p.site, 'renamed.php')), false);

    // Written by another program (git checkout, build tool): picked up by the watcher.
    await fs.mkdir(join(p.root, 'dist'));
    await fs.writeFile(join(p.root, 'dist', 'bundle.js'), 'built');
    assert.ok(await until(() => exists(join(p.site, 'dist', 'bundle.js'))), 'external file uploaded');
    assert.equal(await read(join(p.site, 'dist', 'bundle.js')), 'built');
    await fs.rm(join(p.root, 'dist', 'bundle.js'));
    assert.ok(await until(async () => !(await exists(join(p.site, 'dist', 'bundle.js')))), 'external delete propagated');
    // .git is never watched.
    await fs.mkdir(join(p.root, '.git'));
    await fs.writeFile(join(p.root, '.git', 'HEAD'), 'ref');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(await exists(join(p.site, '.git')), false);
  } finally {
    await stopServer(client, child);
    await fs.rm(p.base, { recursive: true, force: true });
  }
});

test('nvim PhpStorm import writes .vscode/iremote.json', async () => {
  const base = await fs.mkdtemp(join(tmpdir(), 'iremote-nvim-import-'));
  const root = join(base, 'wp');
  await fs.mkdir(join(root, '.idea'), { recursive: true });
  await fs.writeFile(
    join(root, '.idea', 'webServers.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<project version="4"><component name="WebServers"><option name="servers">
  <webServer id="f1" name="shared ftp" url="http://ftp.example.com">
    <fileTransfer host="ftp.example.com" port="21" rootFolder="/public_html" accessType="FTP" username="me" />
  </webServer>
</option></component></project>`,
  );
  await fs.writeFile(
    join(root, '.idea', 'deployment.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<project version="4"><component name="PublishConfigData" autoUpload="Always" serverName="shared ftp">
  <serverData><paths name="shared ftp"><serverdata><mappings>
    <mapping deploy="/" local="$PROJECT_DIR$" web="/" />
  </mappings></serverdata></paths></serverData>
</component></project>`,
  );
  const { child, client } = startServer();
  try {
    await init(client, base);
    const r = await client.call<{ imported: number; root: string }>('importPhpStorm', { root });
    assert.equal(r.imported, 1);
    const cfg = JSON.parse(await read(join(root, '.vscode', 'iremote.json')));
    assert.equal(cfg.servers[0].type, 'ftp');
    assert.equal(cfg.servers[0].host, 'ftp.example.com');
    assert.equal(cfg.defaultServer, cfg.servers[0].id);
    assert.equal(cfg.options.autoUpload, 'always');
    const servers = await client.call<{ servers: { name: string }[] }>('servers', { path: root });
    assert.deepEqual(servers.servers.map((s) => s.name), ['shared ftp']);
  } finally {
    await stopServer(client, child);
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('nvim settings: read, validate + save, test connection, secrets', async () => {
  const base = await fs.mkdtemp(join(tmpdir(), 'iremote-nvim-settings-'));
  const root = join(base, 'fresh');
  const remote = join(base, 'remote');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(remote);
  const { child, client } = startServer();
  try {
    await init(client, base);
    // A project without .vscode/iremote.json yet: empty config with default options.
    const got = await client.call<{ root: string; config: { servers: unknown[]; options: { autoUpload: string } } }>('configGet', { path: root });
    assert.equal(got.root, root);
    assert.deepEqual(got.config.servers, []);
    assert.equal(got.config.options.autoUpload, 'never');

    const server = { id: 'disk', name: 'Disk', type: 'local', host: '', rootPath: remote, mappings: [{ local: '', remote: '/', web: '/' }], excludedLocal: [], excludedRemote: [] };
    const bad = await client.call<{ saved: boolean; errors: string[] }>('configSave', {
      root,
      config: { version: 1, options: got.config.options, servers: [{ ...server, id: 'bad id!' }] },
    });
    assert.equal(bad.saved, false);
    assert.ok(bad.errors.length > 0);
    assert.equal(await exists(join(root, '.vscode', 'iremote.json')), false, 'invalid config is not written');

    const ok = await client.call<{ saved: boolean }>('configSave', { root, config: { version: 1, defaultServer: 'disk', options: got.config.options, servers: [server] } });
    assert.equal(ok.saved, true);
    const cfg = JSON.parse(await read(join(root, '.vscode', 'iremote.json')));
    assert.equal(cfg.defaultServer, 'disk');
    assert.equal((await client.call<{ servers: unknown[] }>('servers', { path: root })).servers.length, 1);

    const good = await client.call<{ ok: boolean; message: string }>('testConnection', { server });
    assert.equal(good.ok, true, good.message);
    const missing = await client.call<{ ok: boolean; message: string }>('testConnection', { server: { ...server, rootPath: join(base, 'nope') } });
    assert.equal(missing.ok, false);
  } finally {
    await stopServer(client, child);
    await fs.rm(base, { recursive: true, force: true });
  }
});
