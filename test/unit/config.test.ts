import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { normalizeProjectConfig, toJson } from '../../src/config/normalize';
import { checkHostKey, fingerprintSha256, hostMatches, isRevoked, parseKnownHosts } from '../../src/config/KnownHosts';
import { buildImport, parseDeployment, parseSshConfigs, parseWebServers, projectRelative } from '../../src/config/PhpStormImporter';

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

const WEB_SERVERS = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="WebServers">
    <option name="servers">
      <webServer id="a0e508f8-a658-4975-ba82-96d8aae9127a" name="vm" url="http://192.168.56.102">
        <fileTransfer host="192.168.56.102" port="22" privateKey="$PROJECT_DIR$/.idea/private_key" rootFolder="/var/www" accessType="SFTP" username="vagrant" keyPair="true">
          <advancedOptions><advancedOptions dataProtectionLevel="Private" /></advancedOptions>
        </fileTransfer>
      </webServer>
      <webServer id="8b67aa76" name="prod" url="https://example.com">
        <fileTransfer rootFolder="/storage" accessType="SFTP" host="10.10.15.87" port="22" sshConfigId="ssh-1" />
      </webServer>
      <webServer id="f1" name="shared ftp" url="http://ftp.example.com">
        <fileTransfer host="ftp.example.com" port="21" rootFolder="/public_html" accessType="FTP" username="me">
          <advancedOptions><advancedOptions dataProtectionLevel="Private" passiveMode="true" /></advancedOptions>
        </fileTransfer>
      </webServer>
    </option>
  </component>
</project>`;

const SSH_CONFIGS = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="SshConfigs">
    <configs>
      <sshConfig authType="OPEN_SSH" host="prod.example.com" id="ssh-1" port="2200" nameFormat="DESCRIPTIVE" username="deploy" useOpenSSHConfig="true" />
    </configs>
  </component>
</project>`;

const DEPLOYMENT = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="PublishConfigData" autoUpload="Always" serverName="prod" promptOnRemoteOverwrite="CHECK_CONTENT" autoUploadExternalChanges="true" filePermissions="420" folderPermissions="493">
    <serverData>
      <paths name="prod">
        <serverdata>
          <mappings>
            <mapping deploy="/html" local="$PROJECT_DIR$" web="/" />
            <mapping deploy="/assets" local="$PROJECT_DIR$/public/assets" web="/static" />
          </mappings>
          <excludedPaths>
            <excludedPath local="true" path="$PROJECT_DIR$/vendor" />
            <excludedPath path="/storage/html/uploads" />
          </excludedPaths>
        </serverdata>
      </paths>
      <paths name="vm">
        <serverdata>
          <mappings><mapping local="$PROJECT_DIR$" web="/" /></mappings>
        </serverdata>
      </paths>
      <paths name="ghost">
        <serverdata><mappings><mapping deploy="/" local="$PROJECT_DIR$" web="/" /></mappings></serverdata>
      </paths>
    </serverData>
    <option name="myAutoUpload" value="ALWAYS" />
  </component>
</project>`;

test('PhpStorm import: servers, SSH configs, mappings, excludes and options', () => {
  const ws = parseWebServers(WEB_SERVERS);
  const ssh = parseSshConfigs(SSH_CONFIGS);
  const dep = parseDeployment(DEPLOYMENT);
  assert.equal(ws.length, 3);
  assert.equal(ssh[0].port, 2200);
  const r = buildImport('/proj', ws, ssh, dep);

  const vm = r.servers.find((s) => s.name === 'vm')!;
  assert.equal(vm.auth, 'key');
  assert.equal(vm.privateKeyPath, '/proj/.idea/private_key');
  assert.equal(vm.username, 'vagrant');
  assert.equal(vm.mappings[0].remote, '/');

  const prod = r.servers.find((s) => s.name === 'prod')!;
  assert.equal(prod.auth, 'openssh');
  assert.equal(prod.host, 'prod.example.com');
  assert.equal(prod.port, 2200);
  assert.equal(prod.username, 'deploy');
  assert.equal(prod.rootPath, '/storage');
  assert.deepEqual(prod.mappings, [
    { local: '', remote: '/html', web: '/' },
    { local: 'public/assets', remote: '/assets', web: '/static' },
  ]);
  assert.deepEqual(prod.excludedLocal, ['vendor']);
  assert.deepEqual(prod.excludedRemote, ['/storage/html/uploads']);
  assert.equal(r.defaultServer, prod.id);

  const ftp = r.servers.find((s) => s.type === 'ftp')!;
  assert.equal(ftp.id, 'f1');
  assert.equal(ftp.webUrl, 'http://ftp.example.com');

  assert.equal(r.options.autoUpload, 'always');
  assert.equal(r.options.skipExternalChanges, false);
  assert.equal(r.options.warnOnNewerRemote, 'content');
  assert.equal(r.options.filePermissions, '644');
  assert.equal(r.options.folderPermissions, '755');
  assert.ok(r.warnings.some((w) => w.includes('ghost')));
});

test('projectRelative keeps outside paths absolute', () => {
  assert.equal(projectRelative('$PROJECT_DIR$', '/proj'), '');
  assert.equal(projectRelative('$PROJECT_DIR$/a/b', '/proj'), 'a/b');
  assert.equal(projectRelative('/elsewhere/x', '/proj'), '/elsewhere/x');
});
