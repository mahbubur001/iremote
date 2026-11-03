import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect as netConnect } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SftpClient } from '../../src/protocol/SftpClient';
import { FtpClient } from '../../src/protocol/FtpClient';
import { WebDavClient } from '../../src/protocol/WebDavClient';
import { LocalClient } from '../../src/protocol/LocalClient';
import { RemoteError, type ConnectContext, type RemoteClient } from '../../src/protocol/types';

/**
 * Requires `npm run test:servers:up`. Every protocol implementation must satisfy the same contract.
 */

const waitForPort = (port: number, timeoutMs = 60_000) =>
  new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const attempt = () => {
      const s = netConnect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve();
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`port ${port} not reachable`));
        else setTimeout(attempt, 500);
      });
    };
    attempt();
  });

const ctx = (extra: Partial<ConnectContext> = {}): ConnectContext => ({
  timeoutMs: 20_000,
  password: 'pass',
  verifyHostKey: async () => true,
  verifyCertificate: async () => true,
  ...extra,
});

const tmp = mkdtempSync(join(tmpdir(), 'iremote-it-'));
const localDir = mkdtempSync(join(tmpdir(), 'iremote-local-target-'));

interface Case {
  name: string;
  port?: number;
  base: string;
  make: () => RemoteClient;
  chmod: boolean;
}

const cases: Case[] = [
  {
    name: 'SFTP (password)',
    port: 2222,
    base: '/upload',
    chmod: true,
    make: () => new SftpClient({ host: '127.0.0.1', port: 2222, username: 'tester', keepAliveSeconds: 0, useAgent: false, tryKeyboard: false }, ctx()),
  },
  {
    name: 'SFTP (private key)',
    port: 2222,
    base: '/upload',
    chmod: true,
    make: () =>
      new SftpClient(
        { host: '127.0.0.1', port: 2222, username: 'tester', keepAliveSeconds: 0, useAgent: false, tryKeyboard: false },
        ctx({ password: undefined, privateKey: readFileSync('test/fixtures/id_ed25519') }),
      ),
  },
  {
    name: 'FTP (ProFTPD, MLSD)',
    port: 2121,
    base: '/',
    chmod: true,
    make: () => new FtpClient({ host: '127.0.0.1', port: 2121, username: 'tester', tls: false, allowUntrustedCertificate: false }, ctx()),
  },
  {
    name: 'FTPS explicit (self-signed, accepted)',
    port: 2121,
    base: '/',
    chmod: true,
    make: () => new FtpClient({ host: '127.0.0.1', port: 2121, username: 'tester', tls: 'explicit', allowUntrustedCertificate: true }, ctx()),
  },
  {
    name: 'FTP (vsftpd, LIST only)',
    port: 2122,
    base: '/home/tester',
    chmod: false,
    make: () => new FtpClient({ host: '127.0.0.1', port: 2122, username: 'tester', tls: false, allowUntrustedCertificate: false }, ctx()),
  },
  {
    name: 'WebDAV',
    port: 8080,
    base: '/',
    chmod: false,
    make: () => new WebDavClient({ url: 'http://127.0.0.1:8080', username: 'tester', auth: 'basic', allowUntrustedCertificate: false }, ctx()),
  },
  {
    name: 'Local folder',
    base: localDir,
    chmod: process.platform !== 'win32',
    make: () => new LocalClient(),
  },
];

for (const c of cases) {
  describe(c.name, () => {
    let client: RemoteClient;
    const dir = `${c.base.replace(/\/$/, '')}/it-${randomBytes(4).toString('hex')}`;

    before(async () => {
      if (c.port) await waitForPort(c.port);
      client = c.make();
      await client.connect();
    });

    after(async () => {
      await client.deleteDir(dir, true).catch(() => undefined);
      await client.close();
    });

    test('home directory and missing paths', async () => {
      assert.ok((await client.homeDir()).length > 0);
      assert.equal(await client.stat(`${dir}/nope`), undefined);
      await assert.rejects(client.readFile(`${dir}/nope.txt`), (e: unknown) => e instanceof RemoteError && e.code === 'NotFound');
    });

    test('mkdirp creates nested folders idempotently', async () => {
      await client.mkdirp(`${dir}/a/b/c`);
      await client.mkdirp(`${dir}/a/b/c`);
      assert.equal((await client.stat(`${dir}/a/b`))?.type, 'dir');
    });

    test('write, read, stat and list files (incl. spaces and unicode)', async () => {
      const name = 'hello wörld.txt';
      await client.writeFile(`${dir}/${name}`, Buffer.from('hi there'));
      assert.equal((await client.readFile(`${dir}/${name}`)).toString(), 'hi there');
      const st = await client.stat(`${dir}/${name}`);
      assert.equal(st?.type, 'file');
      assert.equal(st?.size, 8);
      const names = (await client.list(dir)).map((e) => e.name).sort();
      assert.deepEqual(names, ['a', name].sort());
    });

    test('empty files round-trip', async () => {
      await client.writeFile(`${dir}/empty.txt`, Buffer.alloc(0));
      assert.equal((await client.stat(`${dir}/empty.txt`))?.size, 0);
      const local = join(tmp, `empty-${Date.now()}`);
      writeFileSync(local, '');
      await client.upload(local, `${dir}/empty2.txt`);
      assert.equal((await client.stat(`${dir}/empty2.txt`))?.size, 0);
    });

    test('upload and download binary files with progress', async () => {
      const data = randomBytes(300_000);
      const src = join(tmp, `src-${Date.now()}`);
      const dst = join(tmp, `dst-${Date.now()}`);
      writeFileSync(src, data);
      let progressed = 0;
      await client.upload(src, `${dir}/blob.bin`, (b) => (progressed = b));
      assert.equal((await client.stat(`${dir}/blob.bin`))?.size, data.length);
      assert.ok(progressed > 0);
      await client.download(`${dir}/blob.bin`, dst);
      assert.ok(readFileSync(dst).equals(data));
      rmSync(src);
      rmSync(dst);
    });

    test('rename overwrites the target', async () => {
      await client.writeFile(`${dir}/r1.txt`, Buffer.from('one'));
      await client.writeFile(`${dir}/r2.txt`, Buffer.from('two'));
      try {
        await client.rename(`${dir}/r1.txt`, `${dir}/r2.txt`);
      } catch (e) {
        // Plain SFTP rename (no posix-rename extension) and some FTP servers refuse to overwrite.
        assert.ok(e instanceof RemoteError);
        await client.deleteFile(`${dir}/r2.txt`);
        await client.rename(`${dir}/r1.txt`, `${dir}/r2.txt`);
      }
      assert.equal((await client.readFile(`${dir}/r2.txt`)).toString(), 'one');
      assert.equal(await client.stat(`${dir}/r1.txt`), undefined);
    });

    test('chmod and mtime where supported', async () => {
      await client.writeFile(`${dir}/perm.txt`, Buffer.from('x'));
      if (c.chmod) {
        await client.chmod(`${dir}/perm.txt`, 0o600);
        const st = await client.stat(`${dir}/perm.txt`);
        if (st?.mode !== undefined) assert.equal(st.mode & 0o777, 0o600);
      }
      if (client.capabilities.setMtime) {
        const t = Date.UTC(2020, 0, 1, 12, 0, 0);
        await client.setMtime(`${dir}/perm.txt`, t);
        const st = await client.stat(`${dir}/perm.txt`);
        assert.ok(Math.abs((st?.mtime ?? 0) - t) < 2000, `mtime ${st?.mtime}`);
      }
    });

    test('mtime is reported for change detection', async () => {
      const st = await client.stat(`${dir}/perm.txt`);
      if (client.capabilities.reliableMtime) assert.ok((st?.mtime ?? 0) > 0);
    });

    test('delete file and recursive directory', async () => {
      await client.deleteFile(`${dir}/perm.txt`);
      assert.equal(await client.stat(`${dir}/perm.txt`), undefined);
      await client.writeFile(`${dir}/a/b/c/deep.txt`, Buffer.from('deep'));
      await client.deleteDir(`${dir}/a`, true);
      assert.equal(await client.stat(`${dir}/a`), undefined);
    });
  });
}

describe('security', () => {
  test('SFTP refuses connection when the host key is rejected', async () => {
    await waitForPort(2222);
    const client = new SftpClient(
      { host: '127.0.0.1', port: 2222, username: 'tester', keepAliveSeconds: 0, useAgent: false, tryKeyboard: false },
      ctx({ verifyHostKey: async () => false }),
    );
    await assert.rejects(client.connect(), (e: unknown) => e instanceof RemoteError && e.code === 'HostKey');
  });

  test('SFTP wrong password is an Auth error', async () => {
    const client = new SftpClient(
      { host: '127.0.0.1', port: 2222, username: 'tester', keepAliveSeconds: 0, useAgent: false, tryKeyboard: false },
      ctx({ password: 'wrong' }),
    );
    await assert.rejects(client.connect(), (e: unknown) => e instanceof RemoteError && e.code === 'Auth');
  });

  test('FTPS rejects a self-signed certificate unless explicitly allowed', async () => {
    await waitForPort(2121);
    let asked = false;
    const client = new FtpClient(
      { host: '127.0.0.1', port: 2121, username: 'tester', tls: 'explicit', allowUntrustedCertificate: false },
      ctx({ verifyCertificate: async () => ((asked = true), true) }),
    );
    await assert.rejects(client.connect(), (e: unknown) => e instanceof RemoteError && e.code === 'Certificate');
    assert.equal(asked, false, 'must not even ask when untrusted certificates are not allowed');
  });

  test('FTPS: user declining the certificate aborts before login', async () => {
    const client = new FtpClient(
      { host: '127.0.0.1', port: 2121, username: 'tester', tls: 'explicit', allowUntrustedCertificate: true },
      ctx({ verifyCertificate: async () => false }),
    );
    await assert.rejects(client.connect(), (e: unknown) => e instanceof RemoteError && e.code === 'Certificate');
  });

  test('FTP wrong password is an Auth error', async () => {
    const client = new FtpClient({ host: '127.0.0.1', port: 2121, username: 'tester', tls: false, allowUntrustedCertificate: false }, ctx({ password: 'wrong' }));
    await assert.rejects(client.connect(), (e: unknown) => e instanceof RemoteError && e.code === 'Auth');
  });

  test('WebDAV wrong password is an Auth error', async () => {
    await waitForPort(8080);
    const client = new WebDavClient({ url: 'http://127.0.0.1:8080', username: 'tester', auth: 'basic', allowUntrustedCertificate: false }, ctx({ password: 'wrong' }));
    await assert.rejects(client.connect(), (e: unknown) => e instanceof RemoteError && e.code === 'Auth');
  });
});
