import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Minimal JSON-RPC client playing the Neovim side; answers server→client prompts from `answers`. */
class Client {
  private buffer = '';
  private id = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly notifications: { method: string; params: unknown }[] = [];
  readonly asked: { method: string; params: unknown }[] = [];

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly answers: Record<string, (params: { choices?: string[] }) => unknown>,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(this.buffer.slice(0, nl));
        this.buffer = this.buffer.slice(nl + 1);
        this.handle(msg);
      }
    });
  }

  private handle(msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }): void {
    if (msg.method && msg.id !== undefined) {
      this.asked.push({ method: msg.method, params: msg.params });
      const answer = this.answers[msg.method]?.(msg.params as { choices?: string[] }) ?? null;
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: answer })}\n`);
    } else if (msg.method) {
      this.notifications.push({ method: msg.method, params: msg.params });
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }

  call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
}

const setup = async () => {
  const base = await fs.mkdtemp(join(tmpdir(), 'iremote-nvim-test-'));
  const project = join(base, 'project');
  const remote = join(base, 'remote');
  await fs.mkdir(join(project, '.vscode'), { recursive: true });
  await fs.mkdir(join(project, 'src'), { recursive: true });
  await fs.mkdir(remote, { recursive: true });
  await fs.writeFile(
    join(project, '.vscode', 'iremote.json'),
    JSON.stringify({
      version: 1,
      defaultServer: 'disk',
      options: { autoUpload: 'onExplicitSave', warnOnNewerRemote: 'timestampAndSize' },
      servers: [{ id: 'disk', name: 'Disk', type: 'local', rootPath: remote, mappings: [{ local: '', remote: '/site', web: '/' }] }],
    }),
  );
  await fs.writeFile(join(project, 'index.php'), '<?php echo 1;');
  await fs.writeFile(join(project, 'src', 'a.php'), 'a');
  await fs.writeFile(join(project, 'src', 'b.php'), 'b');
  return { base, project, remote };
};

const start = (answers: Record<string, (params: { choices?: string[] }) => unknown> = {}) => {
  const child = spawn(process.execPath, [join(__dirname, '..', 'nvim', 'iremote.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  return { child, client: new Client(child, answers) };
};

test('nvim server: upload, auto-upload, fetch, download and default server over stdio', async () => {
  const { base, project, remote } = await setup();
  const conflicts: string[] = [];
  const { child, client } = start({
    confirm: (p) => {
      conflicts.push(String((p as { message?: string }).message));
      return 'Skip';
    },
  });
  try {
    const init = await client.call<{ problems: string[] }>('initialize', {
      stateDir: join(base, 'state'),
      globalServersFile: join(base, 'none.json'),
    });
    assert.deepEqual(init.problems, []);

    const status = await client.call<{ project: string; server: { id: string }; autoUpload: string; mapped: boolean }>('status', { path: join(project, 'index.php') });
    assert.equal(status.project, project);
    assert.equal(status.server.id, 'disk');
    assert.equal(status.mapped, true);
    assert.equal(status.autoUpload, 'onExplicitSave');

    // Upload a file and a folder.
    const up = await client.call<{ transferred: number }>('upload', { paths: [join(project, 'index.php')] });
    assert.equal(up.transferred, 1);
    assert.equal(await fs.readFile(join(remote, 'site', 'index.php'), 'utf8'), '<?php echo 1;');
    const dir = await client.call<{ transferred: number }>('upload', { paths: [join(project, 'src')] });
    assert.equal(dir.transferred, 2);
    assert.equal(await fs.readFile(join(remote, 'site', 'src', 'b.php'), 'utf8'), 'b');

    // Excluded by default names: never uploaded.
    await assert.rejects(client.call('upload', { paths: [join(project, '.vscode', 'iremote.json')] }));

    // Auto-upload on save.
    await fs.writeFile(join(project, 'index.php'), '<?php echo 2;');
    const saved = await client.call<{ transferred: number }>('fileSaved', { path: join(project, 'index.php') });
    assert.equal(saved.transferred, 1);
    assert.equal(await fs.readFile(join(remote, 'site', 'index.php'), 'utf8'), '<?php echo 2;');

    // Remote changed behind our back → conflict prompt, answered "Skip".
    await fs.writeFile(join(remote, 'site', 'index.php'), '<?php echo "server";');
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(join(remote, 'site', 'index.php'), future, future);
    await fs.writeFile(join(project, 'index.php'), '<?php echo 3;');
    const skipped = await client.call<{ transferred: number; skipped: number }>('fileSaved', { path: join(project, 'index.php') });
    assert.equal(skipped.transferred, 0);
    assert.equal(conflicts.length, 1);
    assert.equal(await fs.readFile(join(remote, 'site', 'index.php'), 'utf8'), '<?php echo "server";');

    // Compare: fetch the remote copy into a temp file.
    const fetched = await client.call<{ tmpPath: string; remotePath: string; exists: boolean }>('fetchRemote', { path: join(project, 'index.php') });
    assert.equal(fetched.remotePath, join(remote, 'site', 'index.php'));
    assert.equal(fetched.exists, true);
    assert.equal(await fs.readFile(fetched.tmpPath, 'utf8'), '<?php echo "server";');

    // Download overwrites the local file with the server version.
    const down = await client.call<{ transferred: number }>('download', { paths: [join(project, 'index.php')] });
    assert.equal(down.transferred, 1);
    assert.equal(await fs.readFile(join(project, 'index.php'), 'utf8'), '<?php echo "server";');
    // ...and a save right after must not echo the download back as an auto-upload.
    assert.equal(await client.call('fileSaved', { path: join(project, 'index.php') }), null);

    // Default server and auto-upload mode are written back to .vscode/iremote.json.
    await client.call('setAutoUpload', { path: project, mode: 'never' });
    await client.call('setDefaultServer', { path: project, serverId: null });
    const cfg = JSON.parse(await fs.readFile(join(project, '.vscode', 'iremote.json'), 'utf8'));
    assert.equal(cfg.defaultServer, undefined);
    assert.equal(cfg.options.autoUpload, 'never');
    await assert.rejects(client.call('upload', { paths: [join(project, 'index.php')] }), /No default server/);

    assert.ok(client.notifications.some((n) => n.method === 'transfer'));
  } finally {
    await client.call('shutdown').catch(() => undefined);
    await new Promise((r) => child.once('exit', r));
    await fs.rm(base, { recursive: true, force: true });
  }
});
