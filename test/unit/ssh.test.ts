import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authorizedKeysCommand,
  fromDestination,
  fromServer,
  fromSshConfigAlias,
  mergeHosts,
  parseDestination,
  parseOpenSshHosts,
  parsePublicKey,
} from '../../src/ssh/hosts';
import type { ServerConfig } from '../../src/config/schema';

const server = (fields: Partial<ServerConfig>): ServerConfig => ({
  id: 's',
  name: 'S',
  type: 'sftp',
  host: 'h',
  rootPath: '/',
  mappings: [],
  excludedLocal: [],
  excludedRemote: [],
  ...fields,
});

test('OpenSSH config: concrete Host aliases only', () => {
  const text = 'Host *\n  User x\nHost web db # comment\n  HostName 10.0.0.1\nhost=staging\nHost !bad prod-?\nMatch host foo\n';
  assert.deepEqual(parseOpenSshHosts(text), ['web', 'db', 'staging']);
  assert.equal(fromSshConfigAlias('web').server.auth, 'openssh');
});

test('parseDestination accepts the usual ssh spellings', () => {
  assert.deepEqual(parseDestination('rt@example.com'), { username: 'rt', host: 'example.com', port: 22 });
  assert.deepEqual(parseDestination(' ssh rt@example.com:2200 '), { username: 'rt', host: 'example.com', port: 2200 });
  assert.deepEqual(parseDestination('rt@example.com -p 45552'), { username: 'rt', host: 'example.com', port: 45552 });
  assert.deepEqual(parseDestination('root@[::1]:2222'), { username: 'root', host: '::1', port: 2222 });
  assert.deepEqual(parseDestination('example.com'), { username: undefined, host: 'example.com', port: 22 });
  assert.equal(parseDestination('rt@'), undefined);
  assert.equal(parseDestination('rt@host:99999'), undefined);
  assert.equal(parseDestination('two words'), undefined);
});

test('mergeHosts de-duplicates (first list wins), sorts and applies installed keys', () => {
  const own = fromServer(server({ id: 'own', name: 'Zeta', host: 'Example.com', port: 22, username: 'rt', auth: 'password' }), 'global');
  const other = fromServer(server({ id: 'other', name: 'alpha', host: '10.0.0.1', port: 2200, username: 'harmony', auth: 'password' }), 'project');
  const dup = fromDestination({ username: 'rt', host: 'example.com', port: 22 });
  const merged = mergeHosts([[own, other], [dup]], { [other.key]: '/home/me/.ssh/id_ed25519' });
  assert.deepEqual(
    merged.map((h) => [h.label, h.scope]),
    [
      ['alpha', 'project'],
      ['Zeta', 'global'],
    ],
  );
  assert.equal(merged[0].server.auth, 'key');
  assert.equal(merged[0].server.privateKeyPath, '/home/me/.ssh/id_ed25519');
  assert.equal(merged[1].server.id, 'own', 'the saved iRemote server wins, so its keychain password is used');
});

test('parsePublicKey accepts one OpenSSH public key line', () => {
  assert.ok(parsePublicKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA me@mac\n'));
  assert.ok(parsePublicKey('ecdsa-sha2-nistp256 AAAAE2VjZHNh'));
  assert.equal(parsePublicKey('-----BEGIN OPENSSH PRIVATE KEY-----'), undefined);
  assert.equal(parsePublicKey('ssh-ed25519 AAAA a\nssh-rsa BBBB b'), undefined);
});

test('authorizedKeysCommand appends once, keeps the last line intact and sets permissions', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'iremote-ssh-'));
  try {
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA it's me";
    const run = () => execFileSync('/bin/sh', ['-c', authorizedKeysCommand(key)], { env: { ...process.env, HOME: home } });
    run();
    const file = join(home, '.ssh', 'authorized_keys');
    writeFileSync(file, 'ssh-rsa OTHER no-newline');
    run();
    run();
    assert.equal(readFileSync(file, 'utf8'), `ssh-rsa OTHER no-newline\n${key}\n`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, '.ssh')).mode & 0o777, 0o700);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
