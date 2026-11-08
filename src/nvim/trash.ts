import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

const run = (cmd: string, args: string[]): Promise<boolean> => new Promise((resolve) => execFile(cmd, args, (err) => resolve(!err)));

const uniqueIn = async (dir: string, name: string): Promise<string> => {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = join(dir, i === 0 ? name : `${stem} ${i}${ext}`);
    if (!(await fs.stat(candidate).then(() => true, () => false))) return candidate;
  }
};

/** Moves a local file to the user's trash (never deletes outright). Throws when no trash is available. */
export const moveToTrash = async (path: string): Promise<void> => {
  if (process.platform === 'darwin') {
    // Plain move into ~/.Trash: scripting Finder would trigger a macOS Automation permission prompt.
    await fs.rename(path, await uniqueIn(join(homedir(), '.Trash'), basename(path)));
    return;
  }
  if (process.platform === 'linux') {
    if (await run('gio', ['trash', path])) return;
    const dir = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'Trash', 'files');
    await fs.mkdir(dir, { recursive: true });
    await fs.rename(path, await uniqueIn(dir, basename(path)));
    return;
  }
  throw new Error('Moving files to the trash is not supported on this platform.');
};
