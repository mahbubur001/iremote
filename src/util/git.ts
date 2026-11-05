import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface GitFileStatus {
  /** Repository top-level directory. */
  root: string;
  ignored: boolean;
  tracked: boolean;
}

const git = (cwd: string, args: string[]): Promise<{ code: number; stdout: string }> =>
  new Promise((done) => {
    execFile('git', args, { cwd, timeout: 10_000, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      done({ code, stdout: String(stdout) });
    });
  });

/** Git state of a file, or undefined when git is unavailable or the file is not inside a repository. */
export const gitFileStatus = async (file: string): Promise<GitFileStatus | undefined> => {
  const cwd = dirname(file);
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) return undefined;
  const [ignored, tracked] = await Promise.all([
    git(cwd, ['check-ignore', '-q', '--', file]),
    git(cwd, ['ls-files', '--error-unmatch', '--', file]),
  ]);
  return { root: resolve(top.stdout.trim()), ignored: ignored.code === 0, tracked: tracked.code === 0 };
};

/** Appends `file` (anchored to the repository root) to `<root>/.gitignore` unless the exact entry is already there. */
export const addToGitignore = async (root: string, file: string): Promise<string> => {
  // git reports the top level with symlinks resolved (e.g. macOS /var → /private/var), so compare real paths.
  const [realRoot, realDir] = await Promise.all([fs.realpath(root), fs.realpath(dirname(file))]);
  const rel = relative(realRoot, join(realDir, basename(file)));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${file} is not inside ${root}`);
  const entry = `/${rel.split(/[\\/]/).join('/')}`;
  const path = join(root, '.gitignore');
  const current = await fs.readFile(path, 'utf8').catch(() => '');
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return entry;
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  await fs.writeFile(path, `${current}${separator}${entry}\n`, 'utf8');
  return entry;
};
