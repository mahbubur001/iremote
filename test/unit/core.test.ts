import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, defaultAction } from '../../src/core/SyncEngine';
import { StateCache } from '../../src/core/StateCache';
import { ConnectionPool } from '../../src/core/ConnectionPool';
import { TransferQueue } from '../../src/core/TransferQueue';
import { RemoteError, type RemoteClient } from '../../src/protocol/types';
import { parseMlsxFacts, parseMlsxTime, formatMlsxTime } from '../../src/protocol/FtpClient';
import { parseJump } from '../../src/protocol/JumpHost';
import { hostKeyType } from '../../src/protocol/SftpClient';

const rec = (o: Partial<{ localSize: number; localMtime: number; remoteSize: number; remoteMtime: number }> = {}) => ({
  localSize: 10,
  localMtime: 1_000_000,
  remoteSize: 10,
  remoteMtime: 2_000_000,
  at: 0,
  ...o,
});

test('classify uses the last-sync record to tell which side changed', () => {
  const local = { size: 10, mtime: 1_000_000 };
  const remote = { type: 'file' as const, size: 10, mtime: 2_000_000 };
  assert.equal(classify(local, remote, rec()), 'same');
  assert.equal(classify({ size: 11, mtime: 9_000_000 }, remote, rec()), 'localNewer');
  assert.equal(classify(local, { ...remote, size: 12 }, rec()), 'remoteNewer');
  assert.equal(classify({ size: 11, mtime: 9_000_000 }, { ...remote, mtime: 9_000_000 }, rec()), 'conflict');
});

test('classify without record falls back to timestamps with tolerance', () => {
  const remote = { type: 'file' as const, size: 10, mtime: 5_000_000 };
  assert.equal(classify({ size: 10, mtime: 5_001_000 }, remote, undefined), 'same');
  assert.equal(classify({ size: 11, mtime: 9_000_000 }, remote, undefined), 'localNewer');
  assert.equal(classify({ size: 11, mtime: 1_000_000 }, remote, undefined), 'remoteNewer');
  assert.equal(classify({ size: 11, mtime: 5_000_500 }, remote, undefined), 'conflict');
  assert.equal(classify({ size: 1, mtime: 0 }, undefined, undefined), 'localOnly');
  assert.equal(classify(undefined, remote, undefined), 'remoteOnly');
  assert.equal(defaultAction('localOnly'), 'upload');
  assert.equal(defaultAction('remoteNewer'), 'download');
  assert.equal(defaultAction('conflict'), 'skip');
});

test('StateCache persists atomically and supports rename/delete of trees', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iremote-'));
  const file = join(dir, 'state.json');
  const c = new StateCache(file);
  await c.load();
  c.set('s1', '/a/b.txt', rec());
  c.set('s1', '/a/c/d.txt', rec());
  c.rename('s1', '/a', '/z');
  assert.ok(c.get('s1', '/z/b.txt'));
  assert.ok(c.get('s1', '/z/c/d.txt'));
  assert.equal(c.get('s1', '/a/b.txt'), undefined);
  await c.flush();
  const c2 = new StateCache(file);
  await c2.load();
  assert.ok(c2.get('s1', '/z/c/d.txt'));
  c2.delete('s1', '/z', true);
  assert.equal(c2.get('s1', '/z/b.txt'), undefined);
});

test('FTP MLSx helpers parse facts and UTC timestamps', () => {
  const p = parseMlsxFacts(' type=file;size=42;modify=20240102030405;UNIX.mode=0644; my file.txt');
  assert.deepEqual(p?.name, 'my file.txt');
  assert.equal(p?.facts.size, '42');
  assert.equal(p?.facts['unix.mode'], '0644');
  assert.equal(parseMlsxTime('20240102030405'), Date.UTC(2024, 0, 2, 3, 4, 5));
  assert.equal(parseMlsxTime('20240102030405.5'), Date.UTC(2024, 0, 2, 3, 4, 5, 500));
  assert.equal(formatMlsxTime(Date.UTC(2024, 0, 2, 3, 4, 5)), '20240102030405');
});

test('jump host spec parsing', () => {
  assert.deepEqual(parseJump('admin@bastion:2200', 'me'), { username: 'admin', host: 'bastion', port: 2200 });
  assert.deepEqual(parseJump('bastion', 'me'), { username: 'me', host: 'bastion', port: 22 });
  assert.deepEqual(parseJump('u@[::1]:22,second', 'me'), { username: 'u', host: '::1', port: 22 });
});

test('hostKeyType reads the algorithm from an SSH key blob', () => {
  const name = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([Buffer.from([0, 0, 0, name.length]), name, Buffer.alloc(36)]);
  assert.equal(hostKeyType(blob), 'ssh-ed25519');
  assert.equal(hostKeyType(Buffer.alloc(2)), 'unknown');
});

/** In-memory client: counts connections, can fail on demand. */
class FakeClient implements RemoteClient {
  static connects = 0;
  readonly capabilities = { chmod: true, setMtime: true, exec: false, reliableMtime: true };
  connected = false;
  private listeners: (() => void)[] = [];
  constructor(private readonly delayMs = 0) {}
  onClose(l: () => void) {
    this.listeners.push(l);
  }
  async connect() {
    FakeClient.connects++;
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.connected = true;
  }
  async close() {
    this.connected = false;
  }
  drop() {
    this.connected = false;
    this.listeners.forEach((l) => l());
  }
  homeDir = async () => '/';
  list = async () => [];
  stat = async () => undefined;
  readFile = async () => Buffer.alloc(0);
  writeFile = async () => undefined;
  download = async () => undefined;
  upload = async () => undefined;
  mkdirp = async () => undefined;
  deleteFile = async () => undefined;
  deleteDir = async () => undefined;
  rename = async () => undefined;
  chmod = async () => undefined;
  setMtime = async () => undefined;
  exec = async () => ({ code: 0, stdout: '', stderr: '' });
}

test('ConnectionPool opens the first connection alone, then up to the limit', async () => {
  FakeClient.connects = 0;
  const pool = new ConnectionPool(() => new FakeClient(20), { maxConnections: 3, idleCloseMs: 60_000 });
  let concurrent = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 10 }, () =>
      pool.use(async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
      }),
    ),
  );
  assert.ok(peak <= 3, `peak ${peak}`);
  assert.ok(FakeClient.connects <= 3);
  await pool.dispose();
});

test('ConnectionPool shares a failed first connection instead of retrying per caller', async () => {
  let attempts = 0;
  const pool = new ConnectionPool(
    () => {
      const c = new FakeClient();
      c.connect = async () => {
        attempts++;
        await new Promise((r) => setTimeout(r, 10));
        throw new RemoteError('Auth', 'bad password');
      };
      return c;
    },
    { maxConnections: 4, idleCloseMs: 60_000 },
  );
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => pool.use(async () => 1)));
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.equal(attempts, 1);
  await pool.dispose();
});

test('ConnectionPool retries once on a stale reused connection', async () => {
  const pool = new ConnectionPool(() => new FakeClient(), { maxConnections: 1, idleCloseMs: 60_000 });
  await pool.use(async () => undefined);
  let calls = 0;
  const v = await pool.use(async () => {
    calls++;
    if (calls === 1) throw new RemoteError('Connection', 'socket closed');
    return 'ok';
  });
  assert.equal(v, 'ok');
  assert.equal(calls, 2);
  await pool.dispose();
});

test('TransferQueue serializes tasks per key, coalesces queued uploads and cancels', async () => {
  const pool = new ConnectionPool(() => new FakeClient(), { maxConnections: 4, idleCloseMs: 60_000 });
  const q = new TransferQueue(() => pool, () => 4);
  const order: string[] = [];
  const spec = (key: string, label: string, ms: number) => ({
    kind: 'upload' as const,
    serverId: 's',
    serverName: 'S',
    source: label,
    target: label,
    key,
    run: async () => {
      order.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end:${label}`);
    },
  });
  const a = q.enqueue(spec('k1', 'a', 30));
  const b = q.enqueue({ ...spec('k1', 'b', 5), kind: 'delete' });
  const c1 = q.enqueue(spec('k2', 'c1', 5));
  await Promise.all([a, b, c1]);
  assert.ok(order.indexOf('end:a') < order.indexOf('start:b'), 'same key runs in order');

  // Two queued uploads of the same file collapse into one transfer (the newest).
  const blocker = q.enqueue(spec('k3', 'first', 30));
  const second = q.enqueue(spec('k3', 'second', 5));
  const third = q.enqueue(spec('k3', 'third', 5));
  await Promise.all([blocker, second, third]);
  assert.ok(order.includes('end:third'));
  assert.ok(!order.includes('start:second'));

  const slow = q.enqueue(spec('k4', 'slow', 200));
  const queued = q.enqueue(spec('k4', 'queued', 5));
  await q.cancel();
  await assert.rejects(queued, (e: unknown) => e instanceof RemoteError && e.code === 'Cancelled');
  await slow.catch(() => undefined);
  await pool.dispose();
});
