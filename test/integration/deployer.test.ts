import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SftpClient } from '../../src/protocol/SftpClient';
import { FtpClient } from '../../src/protocol/FtpClient';
import type { ConnectContext, RemoteClient } from '../../src/protocol/types';
import { ConnectionPool } from '../../src/core/ConnectionPool';
import { TransferQueue } from '../../src/core/TransferQueue';
import { StateCache } from '../../src/core/StateCache';
import { Deployer, type ConflictInfo, type DeploymentTarget } from '../../src/core/Deployer';
import { SyncEngine } from '../../src/core/SyncEngine';
import { PathMapper } from '../../src/core/PathMapper';
import { defaultOptions, type ServerConfig } from '../../src/config/schema';

const ctx: ConnectContext = { timeoutMs: 20_000, password: 'pass', verifyHostKey: async () => true, verifyCertificate: async () => true };

const backends: { name: string; base: string; make: () => RemoteClient; type: ServerConfig['type'] }[] = [
  {
    name: 'SFTP',
    base: '/upload',
    type: 'sftp',
    make: () => new SftpClient({ host: '127.0.0.1', port: 2222, username: 'tester', keepAliveSeconds: 0, useAgent: false, tryKeyboard: false }, ctx),
  },
  {
    name: 'FTPS',
    base: '/',
    type: 'ftps',
    make: () => new FtpClient({ host: '127.0.0.1', port: 2121, username: 'tester', tls: 'explicit', allowUntrustedCertificate: true }, ctx),
  },
];

for (const b of backends) {
  describe(`Deployer + Sync over ${b.name}`, () => {
    const project = mkdtempSync(join(tmpdir(), 'iremote-proj-'));
    const remoteRoot = `${b.base.replace(/\/$/, '')}/deploy-${randomBytes(4).toString('hex')}`;
    const conflicts: ConflictInfo[] = [];
    let decision: 'overwrite' | 'skip' = 'skip';
    let pool: ConnectionPool;
    let deployer: Deployer;
    let sync: SyncEngine;
    let target: DeploymentTarget;
    let cache: StateCache;

    before(async () => {
      mkdirSync(join(project, 'src/lib'), { recursive: true });
      mkdirSync(join(project, '.git'), { recursive: true });
      mkdirSync(join(project, 'vendor'), { recursive: true });
      writeFileSync(join(project, 'index.php'), '<?php echo 1;');
      writeFileSync(join(project, 'src/app.php'), '<?php // app');
      writeFileSync(join(project, 'src/lib/util.php'), '<?php // util');
      writeFileSync(join(project, '.git/HEAD'), 'ref: main');
      writeFileSync(join(project, 'vendor/autoload.php'), '<?php // vendor');
      writeFileSync(join(project, 'debug.log'), 'noise');

      const server: ServerConfig = {
        id: `it-${b.name.toLowerCase()}`,
        name: b.name,
        type: b.type,
        host: '127.0.0.1',
        rootPath: remoteRoot,
        mappings: [{ local: '', remote: '/', web: '/' }],
        excludedLocal: ['vendor'],
        excludedRemote: [],
      };
      const options = { ...defaultOptions(), excludeNames: ['.git', '*.log'], filePermissions: b.type === 'sftp' ? '640' : '' };
      target = { server, projectRoot: project, options, mapper: new PathMapper(project, server, options.excludeNames) };
      pool = new ConnectionPool(b.make, { maxConnections: 3, idleCloseMs: 60_000 });
      const queue = new TransferQueue(() => pool, () => 3);
      cache = new StateCache(join(project, '..', `${randomBytes(4).toString('hex')}-state.json`));
      await cache.load();
      deployer = new Deployer(
        queue,
        cache,
        {
          onConflict: async (info) => {
            conflicts.push(info);
            return decision;
          },
          log: () => undefined,
        },
        () => pool,
      );
      sync = new SyncEngine(deployer, cache);
    });

    after(async () => {
      await pool.use((c) => c.deleteDir(remoteRoot, true)).catch(() => undefined);
      await pool.dispose();
    });

    test('uploads the project honoring excludes and creating folders', async () => {
      const r = await deployer.upload(target, [project], true);
      assert.equal(r.failed.length, 0, String(r.failed[0]?.error));
      assert.equal(r.transferred, 3);
      await pool.use(async (c) => {
        assert.equal((await c.readFile(`${remoteRoot}/src/lib/util.php`)).toString(), '<?php // util');
        assert.equal(await c.stat(`${remoteRoot}/.git/HEAD`), undefined);
        assert.equal(await c.stat(`${remoteRoot}/vendor/autoload.php`), undefined);
        assert.equal(await c.stat(`${remoteRoot}/debug.log`), undefined);
        if (b.type === 'sftp') assert.equal(((await c.stat(`${remoteRoot}/index.php`))?.mode ?? 0) & 0o777, 0o640);
      });
    });

    test('everything is "same" right after upload', async () => {
      const items = await pool.use((c) => sync.compare(c, target, [project], { compareContents: false, maxDownloadCompareBytes: 1e6 }));
      assert.equal(items.length, 3);
      assert.ok(items.every((i) => i.state === 'same'), JSON.stringify(items.map((i) => [i.remotePath, i.state])));
    });

    test('detects a remote change before overwriting it', async () => {
      await new Promise((r) => setTimeout(r, 1100));
      await pool.use((c) => c.writeFile(`${remoteRoot}/index.php`, Buffer.from('<?php echo "changed on server, longer";')));
      writeFileSync(join(project, 'index.php'), '<?php echo 2;');

      decision = 'skip';
      const skipped = await deployer.uploadFile(target, join(project, 'index.php'), true);
      assert.equal(conflicts.length, 1);
      assert.equal(skipped.skipped, 1);
      assert.match((await pool.use((c) => c.readFile(`${remoteRoot}/index.php`))).toString(), /changed on server/);

      decision = 'overwrite';
      const written = await deployer.uploadFile(target, join(project, 'index.php'), true);
      assert.equal(written.transferred, 1);
      assert.equal((await pool.use((c) => c.readFile(`${remoteRoot}/index.php`))).toString(), '<?php echo 2;');
    });

    test('sync classifies local-only, remote-only, local and remote changes', async () => {
      await new Promise((r) => setTimeout(r, 1100));
      writeFileSync(join(project, 'src/new.php'), 'new local');
      writeFileSync(join(project, 'src/app.php'), '<?php // app edited locally');
      const future = new Date(Date.now() + 10_000);
      utimesSync(join(project, 'src/app.php'), future, future);
      await pool.use(async (c) => {
        await c.writeFile(`${remoteRoot}/src/remote-only.php`, Buffer.from('remote'));
        await c.writeFile(`${remoteRoot}/src/lib/util.php`, Buffer.from('<?php // util edited on server'));
      });
      const items = await pool.use((c) => sync.compare(c, target, [project], { compareContents: false, maxDownloadCompareBytes: 1e6 }));
      const state = (p: string) => items.find((i) => i.remotePath === `${remoteRoot}/${p}`)?.state;
      assert.equal(state('src/new.php'), 'localOnly');
      assert.equal(state('src/remote-only.php'), 'remoteOnly');
      assert.equal(state('src/app.php'), 'localNewer');
      assert.equal(state('src/lib/util.php'), 'remoteNewer');
      assert.equal(state('index.php'), 'same');

      for (const item of items) {
        if (item.action === 'upload') await deployer.uploadFile(target, item.localPath, false);
        if (item.action === 'download') await deployer.downloadFile(target, item.remotePath, item.localPath);
      }
      assert.equal(readFileSync(join(project, 'src/remote-only.php'), 'utf8'), 'remote');
      assert.equal(readFileSync(join(project, 'src/lib/util.php'), 'utf8'), '<?php // util edited on server');
      assert.ok(deployer.isOwnLocalWrite(join(project, 'src/remote-only.php')), 'downloads are flagged so auto-upload ignores them');
      assert.ok(!existsSync(join(project, 'src/remote-only.php.iremote-download')), 'temporary download file is cleaned up');

      const after = await pool.use((c) => sync.compare(c, target, [project], { compareContents: false, maxDownloadCompareBytes: 1e6 }));
      assert.ok(after.every((i) => i.state === 'same'), JSON.stringify(after.filter((i) => i.state !== 'same').map((i) => [i.remotePath, i.state])));
    });

    test('content comparison treats identical files as same', async () => {
      cache.forgetServer(target.server.id);
      const items = await pool.use((c) => sync.compare(c, target, [project], { compareContents: true, maxDownloadCompareBytes: 1e6 }));
      assert.ok(items.every((i) => i.state === 'same' || i.state === 'localNewer' || i.state === 'remoteNewer'));
      const sizesEqual = items.filter((i) => i.local && i.remote && i.local.size === i.remote.size);
      assert.ok(sizesEqual.every((i) => i.state === 'same'));
    });

    test('rename and delete propagate and keep the cache in sync', async () => {
      await deployer.uploadFile(target, join(project, 'src/new.php'), false);
      assert.ok(cache.get(target.server.id, `${remoteRoot}/src/new.php`));
      await deployer.renameRemote(target, `${remoteRoot}/src/new.php`, `${remoteRoot}/src/renamed.php`);
      assert.equal(cache.get(target.server.id, `${remoteRoot}/src/new.php`), undefined);
      assert.ok(cache.get(target.server.id, `${remoteRoot}/src/renamed.php`));
      await deployer.deleteRemote(target, `${remoteRoot}/src/lib`, true);
      assert.equal(await pool.use((c) => c.stat(`${remoteRoot}/src/lib`)), undefined);
      assert.equal(cache.get(target.server.id, `${remoteRoot}/src/lib/util.php`), undefined);
    });

    test('download of a remote folder recreates the local tree', async () => {
      await pool.use(async (c) => {
        await c.mkdirp(`${remoteRoot}/assets/img`);
        await c.writeFile(`${remoteRoot}/assets/img/logo.svg`, Buffer.from('<svg/>'));
      });
      const r = await deployer.download(target, [`${remoteRoot}/assets`]);
      assert.equal(r.failed.length, 0);
      assert.equal(readFileSync(join(project, 'assets/img/logo.svg'), 'utf8'), '<svg/>');
    });
  });
}
