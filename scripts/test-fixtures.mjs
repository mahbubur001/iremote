// Generates the throw-away SSH key used by the SFTP test container.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

mkdirSync('test/fixtures', { recursive: true });
if (!existsSync('test/fixtures/id_ed25519')) {
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'iremote-test', '-f', 'test/fixtures/id_ed25519'], { stdio: 'inherit' });
}
