/**
 * The Neovim server against the Docker test servers (npm run test:servers:up): the same RPC calls the Lua plugin makes,
 * including password / host-key / certificate prompts. Never answers "Save", so nothing reaches the system keychain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer, stopServer, type Answers } from '../unit/nvimClient';
import { waitForServer } from './servers';

const run = randomBytes(4).toString('hex');

interface Case {
  name: string;
  port: number;
  server: Record<string, unknown>;
  /** Prompts expected besides the password. */
  expect: RegExp[];
}

const CASES: Case[] = [
  {
    name: 'SFTP',
    port: 2222,
    server: { type: 'sftp', host: '127.0.0.1', port: 2222, username: 'tester', auth: 'password', rootPath: '/upload' },
    expect: [/authenticity of host/],
  },
  {
    name: 'FTP (ProFTPD)',
    port: 2121,
    server: { type: 'ftp', host: '127.0.0.1', port: 2121, username: 'tester', rootPath: '/' },
    expect: [],
  },
  {
    // "Accept untrusted certificate" on: the user is asked (and answers "Accept Once"); off, it is refused outright.
    name: 'FTPS (self-signed, accepted in the prompt)',
    port: 2121,
    server: { type: 'ftps', host: '127.0.0.1', port: 2121, username: 'tester', rootPath: '/', allowUntrustedCertificate: true },
    expect: [/TLS certificate/],
  },
  {
    name: 'FTP (vsftpd)',
    port: 2122,
    server: { type: 'ftp', host: '127.0.0.1', port: 2122, username: 'tester', rootPath: '/home/tester' },
    expect: [],
  },
  {
    name: 'WebDAV',
    port: 8080,
    server: { type: 'webdav', host: 'http://127.0.0.1:8080', username: 'tester', webdavAuth: 'basic', rootPath: '/' },
    expect: [],
  },
];

for (const c of CASES) {
  test(`nvim server over ${c.name}`, async () => {
    if (c.port !== 8080) await waitForServer(c.port);
    const base = await fs.mkdtemp(join(tmpdir(), 'iremote-nvim-it-'));
    const root = join(base, 'project');
    const dir = `nvim-it-${run}-${c.port}-${c.name.replace(/\W+/g, '').toLowerCase()}`;
    const id = `it-${c.name.replace(/\W+/g, '-').toLowerCase()}-${run}`;
    await fs.mkdir(join(root, '.vscode'), { recursive: true });
    await fs.writeFile(
      join(root, '.vscode', 'iremote.json'),
      JSON.stringify({
        version: 1,
        defaultServer: id,
        options: { autoUpload: 'onExplicitSave', warnOnNewerRemote: 'timestampAndSize' },
        servers: [{ id, name: c.name, ...c.server, mappings: [{ local: '', remote: dir, web: '/' }] }],
      }),
    );
    await fs.writeFile(join(root, 'index.php'), '<?php echo 1;');
    await fs.mkdir(join(root, 'src'));
    await fs.writeFile(join(root, 'src', 'a.php'), 'a');

    const prompts: string[] = [];
    const confirms: string[] = [];
    let passwords = c.name.startsWith('FTP (ProFTPD)') ? ['wrong', 'pass'] : ['pass'];
    const answers: Answers = {
      prompt: (p) => {
        prompts.push(String(p.prompt));
        return passwords.shift() ?? null;
      },
      confirm: (p) => {
        confirms.push(String(p.message));
        const choices = p.choices ?? [];
        return choices.find((x) => x === 'Trust Once' || x === 'Accept Once' || x === 'Not Now') ?? null;
      },
    };
    const { child, client } = startServer(answers);
    try {
      await client.call('initialize', { stateDir: join(base, 'state'), globalServersFile: join(base, 'none.json') });

      // Settings dialog: Test Connection logs in (prompts) before anything is saved.
      const t = await client.call<{ ok: boolean; message: string }>('testConnection', {
        server: { id: `${id}-t`, name: c.name, ...c.server, mappings: [], excludedLocal: [], excludedRemote: [] },
      });
      assert.equal(t.ok, true, t.message);
      passwords = ['pass'];

      const up = await client.call<{ transferred: number; failed: unknown[] }>('upload', { paths: [join(root, 'index.php'), join(root, 'src')] });
      assert.deepEqual(up.failed, []);
      assert.equal(up.transferred, 2);

      await fs.writeFile(join(root, 'index.php'), '<?php echo 2;');
      const saved = await client.call<{ transferred: number }>('fileSaved', { path: join(root, 'index.php') });
      assert.equal(saved.transferred, 1);

      const fetched = await client.call<{ tmpPath: string; exists: boolean; remotePath: string }>('fetchRemote', { path: join(root, 'index.php') });
      assert.equal(fetched.exists, true);
      assert.equal(await fs.readFile(fetched.tmpPath, 'utf8'), '<?php echo 2;');

      // Remote Host: list, open in place, save back.
      const remoteDir = fetched.remotePath.slice(0, fetched.remotePath.lastIndexOf('/'));
      const list = await client.call<{ name: string }[]>('remoteList', { path: root, serverId: id, remotePath: remoteDir });
      assert.deepEqual(list.map((e) => e.name).sort(), ['index.php', 'src']);
      const opened = await client.call<{ path: string; remote: boolean }>('remoteOpen', { path: root, serverId: id, remotePath: fetched.remotePath, preferLocal: false });
      await fs.writeFile(opened.path, '<?php echo "edited on server";');
      const rs = await client.call<{ saved: boolean }>('remoteSave', { path: root, tmpPath: opened.path });
      assert.equal(rs.saved, true);

      // Sync sees the server edit; download brings it back.
      const cmp = await client.call<{ items: { rel: string; state: string }[] }>('syncCompare', { paths: [root] });
      assert.ok(cmp.items.some((i) => i.rel === 'index.php' && i.state !== 'same'), JSON.stringify(cmp.items));
      const down = await client.call<{ transferred: number }>('download', { paths: [join(root, 'index.php')] });
      assert.equal(down.transferred, 1);
      assert.equal(await fs.readFile(join(root, 'index.php'), 'utf8'), '<?php echo "edited on server";');

      // Prompts: password asked (twice for the wrong-password case), expected trust prompts, never "Save".
      assert.ok(prompts.length >= 1, 'password prompt');
      for (const re of c.expect) assert.ok(confirms.some((m) => re.test(m)), `expected prompt ${re} in ${JSON.stringify(confirms)}`);

      // Clean up the remote test folder.
      await client.call('remoteDelete', { path: root, serverId: id, remotePaths: [{ path: remoteDir, isDir: true }] });
      const after = await client.call<{ name: string }[]>('remoteList', { path: root, serverId: id, remotePath: remoteDir.slice(0, remoteDir.lastIndexOf('/')) || '/' });
      assert.ok(!after.some((e) => remoteDir.endsWith(e.name)));
    } finally {
      await stopServer(client, child);
      await fs.rm(base, { recursive: true, force: true });
    }
  });
}
