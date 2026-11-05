import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addToGitignore, gitFileStatus } from '../../src/util/git';

const tmp = mkdtempSync(join(tmpdir(), 'iremote-git-'));

before(() => {
  // Keep the developer's global excludesFile (which may ignore .vscode/iremote.json) out of the results.
  const emptyConfig = join(tmp, 'empty-gitconfig');
  writeFileSync(emptyConfig, '');
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

const repoWithConfig = (name: string): { root: string; file: string } => {
  const root = join(tmp, name);
  mkdirSync(join(root, 'app', '.vscode'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const file = join(root, 'app', '.vscode', 'iremote.json');
  writeFileSync(file, '{}');
  return { root, file };
};

test('gitFileStatus reports an untracked, not ignored file inside a repository', async () => {
  const { file } = repoWithConfig('untracked');
  const status = await gitFileStatus(file);
  assert.ok(status);
  assert.equal(status.ignored, false);
  assert.equal(status.tracked, false);
});

test('gitFileStatus is undefined outside a repository', async () => {
  const dir = join(tmp, 'no-repo', '.vscode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'iremote.json'), '{}');
  // GIT_CEILING_DIRECTORIES stops git from finding a repository above the temp folder.
  process.env.GIT_CEILING_DIRECTORIES = tmp;
  try {
    assert.equal(await gitFileStatus(join(dir, 'iremote.json')), undefined);
  } finally {
    delete process.env.GIT_CEILING_DIRECTORIES;
  }
});

test('addToGitignore appends an anchored entry once and git then ignores the file', async () => {
  const { root, file } = repoWithConfig('ignore');
  writeFileSync(join(root, '.gitignore'), 'node_modules'); // no trailing newline
  const status = await gitFileStatus(file);
  assert.ok(status);
  assert.equal(await addToGitignore(status.root, file), '/app/.vscode/iremote.json');
  await addToGitignore(status.root, file);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'node_modules\n/app/.vscode/iremote.json\n');
  assert.equal((await gitFileStatus(file))?.ignored, true);
});

test('gitFileStatus reports a committed file as tracked', async () => {
  const { root, file } = repoWithConfig('tracked');
  execFileSync('git', ['add', '--', file], { cwd: root });
  assert.equal((await gitFileStatus(file))?.tracked, true);
});
