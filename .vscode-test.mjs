// End-to-end tests inside VS Code against the Docker SFTP server (npm run test:servers:up).
import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('out-test/e2e-env');
const workspace = resolve(root, 'workspace');
const knownHosts = resolve(root, 'known_hosts');
rmSync(root, { recursive: true, force: true });
mkdirSync(resolve(workspace, '.vscode'), { recursive: true });

// Trust the test container's host key via iremote.ssh.knownHostsFiles so no modal prompt blocks the run.
writeFileSync(knownHosts, execFileSync('ssh-keyscan', ['-p', '2222', '127.0.0.1'], { encoding: 'utf8' }));

const remoteRoot = `/upload/e2e-${Date.now()}`;
writeFileSync(
  resolve(workspace, '.vscode/iremote.json'),
  JSON.stringify(
    {
      version: 1,
      defaultServer: 'e2e',
      options: { autoUpload: 'always', warnOnNewerRemote: 'none', excludeNames: ['.vscode'] },
      servers: [
        {
          id: 'e2e',
          name: 'E2E SFTP',
          type: 'sftp',
          host: '127.0.0.1',
          port: 2222,
          username: 'tester',
          auth: 'key',
          privateKeyPath: resolve('test/fixtures/id_ed25519'),
          rootPath: remoteRoot,
          webUrl: 'https://example.test',
          mappings: [{ local: '', remote: '/', web: '/' }],
        },
      ],
    },
    null,
    2,
  ),
);
writeFileSync(resolve(root, 'remote-root.txt'), remoteRoot);
writeFileSync(resolve(workspace, '.vscode/settings.json'), JSON.stringify({ 'iremote.log.level': 'details', 'iremote.ssh.knownHostsFiles': [knownHosts] }, null, 2));

export default defineConfig({
  files: 'out-test/e2e/**/*.test.js',
  workspaceFolder: workspace,
  // In-memory secret storage keeps the test instance away from the macOS keychain (no system dialogs).
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--use-inmemory-secretstorage'],
  env: { IREMOTE_E2E_REMOTE_ROOT: remoteRoot },
  mocha: { ui: 'bdd', timeout: 60000 },
});
