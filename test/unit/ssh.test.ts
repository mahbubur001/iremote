import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSshConfigs } from '../../src/config/PhpStormImporter';
import {
  authorizedKeysCommand,
  fromDestination,
  fromServer,
  fromSshConfigAlias,
  mergeHosts,
  parseDestination,
  parseOpenSshHosts,
  parsePublicKey,
  phpStormSshToServer,
} from '../../src/ssh/hosts';
import { normalizeGlobalConfig } from '../../src/config/normalize';
import type { ServerConfig } from '../../src/config/schema';

const PHPSTORM_XML = `<application>
  <component name="SshConfigs">
    <configs>
      <sshConfig authType="PASSWORD" host="199.167.202.14" id="a1" port="2200" nameFormat="DESCRIPTIVE" username="harmony" useOpenSSHConfig="false" />
      <sshConfig authType="PASSWORD" host="radiustheme.net" id="b2" port="22" customName="Rt - radiustheme.net" nameFormat="CUSTOM" username="rt" useOpenSSHConfig="true">
        <option name="customName" value="Rt - radiustheme.net" />
      </sshConfig>
      <sshConfig authType="KEY_PAIR" host="k.example.com" id="c3" keyPath="$USER_HOME$/.ssh/id_ed25519" nameFormat="DESCRIPTIVE" username="deploy" />
    </configs>
  </component>
</application>`;

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

test('IDE-level PhpStorm sshConfigs.xml (<application> root) is parsed, with custom names', () => {
  const configs = parseSshConfigs(PHPSTORM_XML);
  assert.deepEqual(
    configs.map((c) => [c.id, c.host, c.port, c.username, c.authType, c.nameFormat, c.customName]),
    [
      ['a1', '199.167.202.14', 2200, 'harmony', 'PASSWORD', 'DESCRIPTIVE', undefined],
      ['b2', 'radiustheme.net', 22, 'rt', 'PASSWORD', 'CUSTOM', 'Rt - radiustheme.net'],
      ['c3', 'k.example.com', undefined, 'deploy', 'KEY_PAIR', 'DESCRIPTIVE', undefined],
    ],
  );
});

test('PhpStorm SSH configurations import as valid global SFTP servers with PhpStorm names', () => {
  const servers = parseSshConfigs(PHPSTORM_XML).map(phpStormSshToServer);
  const errors: string[] = [];
  const clean = normalizeGlobalConfig({ version: 1, servers }, errors);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    clean.servers.map((s) => [s.id, s.name, s.type, s.port, s.auth]),
    [
      ['ssh-a1', 'harmony@199.167.202.14:2200', 'sftp', 2200, 'password'],
      ['ssh-b2', 'Rt - radiustheme.net', 'sftp', 22, 'password'],
      ['ssh-c3', 'deploy@k.example.com:22', 'sftp', 22, 'key'],
    ],
  );
  assert.equal(clean.servers[2].privateKeyPath, `${homedir()}/.ssh/id_ed25519`);
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
