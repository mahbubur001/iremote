import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { normalizeProjectConfig, toJson } from '../../src/config/normalize';
import { checkHostKey, fingerprintSha256, hostMatches, isRevoked, parseKnownHosts } from '../../src/config/KnownHosts';

test('normalizeProjectConfig fills defaults, drops invalid servers and reports problems', () => {
  const errors: string[] = [];
  const cfg = normalizeProjectConfig(
    {
      version: 1,
      defaultServer: 'a',
      options: { autoUpload: 'always', filePermissions: '999', concurrency: 100 },
      servers: [
        { id: 'a', name: 'A', type: 'sftp', host: 'h', rootPath: '/www', password: 'oops', mappings: [{ local: '', remote: '/' }] },
        { name: 'no id' },
        { id: 'bad id!', name: 'B', type: 'ftp', host: 'h', rootPath: '/' },
        { id: 'a', name: 'dup', type: 'ftp', host: 'h', rootPath: '/' },
      ],
    },
    errors,
  );
  assert.equal(cfg.servers.length, 1);
  assert.equal(cfg.servers[0].port, 22);
  assert.equal(cfg.servers[0].mappings[0].web, '/');
  assert.equal(cfg.options.autoUpload, 'always');
  assert.equal(cfg.options.filePermissions, '');
  assert.equal(cfg.options.concurrency, 16);
  assert.ok(errors.some((e) => e.includes('passwords')));
  assert.ok(errors.some((e) => e.includes('no id')));
  assert.ok(errors.some((e) => e.includes('bad id!')));
  assert.ok(errors.some((e) => e.includes('Duplicate')));
  assert.ok(!('password' in cfg.servers[0]));
});

test('toJson omits empty and undefined values', () => {
  assert.equal(toJson({ a: 1, b: undefined, c: '', d: 'x' }), '{\n  "a": 1,\n  "d": "x"\n}\n');
});

test('known_hosts: plain, port, hashed, negated, revoked and mismatch', () => {
  const key = randomBytes(51);
  const other = randomBytes(51);
  const salt = randomBytes(20);
  const hashed = `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update('[secret.host]:2222').digest('base64')}`;
  const text = [
    '# comment',
    `example.com,10.0.0.1 ssh-ed25519 ${key.toString('base64')}`,
    `[ported.host]:2222 ssh-ed25519 ${key.toString('base64')}`,
    `${hashed} ssh-ed25519 ${key.toString('base64')}`,
    `*.corp,!evil.corp ssh-rsa ${other.toString('base64')}`,
    `@revoked * ssh-ed25519 ${other.toString('base64')}`,
  ].join('\n');
  const entries = parseKnownHosts(text);
  assert.equal(checkHostKey(entries, 'example.com', 22, 'ssh-ed25519', key), 'trusted');
  assert.equal(checkHostKey(entries, 'ported.host', 2222, 'ssh-ed25519', key), 'trusted');
  assert.equal(checkHostKey(entries, 'ported.host', 22, 'ssh-ed25519', key), 'unknown');
  assert.equal(checkHostKey(entries, 'secret.host', 2222, 'ssh-ed25519', key), 'trusted');
  assert.equal(checkHostKey(entries, 'example.com', 22, 'ssh-ed25519', randomBytes(51)), 'mismatch');
  assert.ok(hostMatches(['*.corp', '!evil.corp'], 'a.corp', 22));
  assert.ok(!hostMatches(['*.corp', '!evil.corp'], 'evil.corp', 22));
  assert.ok(isRevoked(entries, other));
  assert.match(fingerprintSha256(key), /^SHA256:[A-Za-z0-9+/]+$/);
});
