import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';

const remoteRoot = process.env.IREMOTE_E2E_REMOTE_ROOT ?? '';
const remote = (p: string) => vscode.Uri.from({ scheme: 'iremote', authority: 'e2e', path: `${remoteRoot}/${p}` });
const ws = () => vscode.workspace.workspaceFolders![0].uri;

/** Polls until the predicate holds; remote effects (auto-upload) are asynchronous. */
const eventually = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000): Promise<T> => {
  const start = Date.now();
  let last: T | undefined;
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (ok(last)) return last;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Condition not met in ${timeoutMs} ms (last: ${String(last)}, error: ${String(lastErr)})`);
};

const readRemote = async (p: string) => new TextDecoder().decode(await vscode.workspace.fs.readFile(remote(p)));

describe('iRemote end-to-end', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('itemcoder.iremote');
    assert.ok(ext, 'extension is installed');
    await ext.activate();
  });

  it('registers every contributed command', async () => {
    const pkg = JSON.parse(readFileSync(`${vscode.extensions.getExtension('itemcoder.iremote')!.extensionPath}/package.json`, 'utf8'));
    const contributed: string[] = pkg.contributes.commands.map((c: { command: string }) => c.command);
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = contributed.filter((c) => !registered.has(c));
    assert.deepEqual(missing, []);
  });

  it('auto-uploads a saved file to the default server', async () => {
    const file = vscode.Uri.joinPath(ws(), 'src', 'hello.php');
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode('<?php // v1'));
    const doc = await vscode.workspace.openTextDocument(file);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(file, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), '<?php // v2 saved');
    assert.ok(await vscode.workspace.applyEdit(edit), 'edit applied');
    assert.equal(doc.getText(), '<?php // v2 saved');
    assert.ok(await doc.save(), 'document saved');
    const content = await eventually(() => readRemote('src/hello.php'), (v) => v === '<?php // v2 saved');
    assert.equal(content, '<?php // v2 saved');
  });

  it('edits remote files directly through the iremote:// file system', async () => {
    await vscode.workspace.fs.writeFile(remote('direct/note.txt'), new TextEncoder().encode('from fs provider')).then(
      () => undefined,
      async () => {
        await vscode.workspace.fs.createDirectory(remote('direct'));
        await vscode.workspace.fs.writeFile(remote('direct/note.txt'), new TextEncoder().encode('from fs provider'));
      },
    );
    assert.equal(await readRemote('direct/note.txt'), 'from fs provider');
    const entries = await vscode.workspace.fs.readDirectory(remote('direct'));
    assert.deepEqual(entries, [['note.txt', vscode.FileType.File]]);

    const doc = await vscode.workspace.openTextDocument(remote('direct/note.txt'));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(0, 0), 'edited: ');
    assert.ok(await vscode.workspace.applyEdit(edit), 'edit applied');
    assert.ok(await doc.save());
    assert.equal(await readRemote('direct/note.txt'), 'edited: from fs provider');

    await vscode.workspace.fs.rename(remote('direct/note.txt'), remote('direct/renamed.txt'));
    await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(remote('direct/note.txt'))));
    await vscode.workspace.fs.delete(remote('direct'), { recursive: true });
    await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(remote('direct'))));
  });

  it('downloads a changed remote file over the local copy', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.writeFile(remote('src/hello.php'), new TextEncoder().encode('<?php // changed on server'));
    const file = vscode.Uri.joinPath(ws(), 'src', 'hello.php');
    await vscode.commands.executeCommand('iremote.downloadFromDefault', file, [file]);
    const local = await eventually(
      async () => new TextDecoder().decode(await vscode.workspace.fs.readFile(file)),
      (v) => v === '<?php // changed on server',
    );
    assert.equal(local, '<?php // changed on server');
  });

  it('propagates local renames and deletes when configured', async () => {
    const file = vscode.Uri.joinPath(ws(), 'src', 'move-me.php');
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode('move'));
    await vscode.commands.executeCommand('iremote.uploadToDefault', file, [file]);
    await eventually(() => readRemote('src/move-me.php'), (v) => v === 'move');
    const edit = new vscode.WorkspaceEdit();
    const target = vscode.Uri.joinPath(ws(), 'src', 'moved.php');
    edit.renameFile(file, target);
    assert.ok(await vscode.workspace.applyEdit(edit));
    await eventually(() => readRemote('src/moved.php'), (v) => v === 'move');
  });

  it('opens the Deployment settings and Sync panels', async () => {
    await vscode.commands.executeCommand('iremote.openSettings');
    const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    await eventually(async () => tabs(), (t) => t.includes('Deployment'));
    await vscode.commands.executeCommand('iremote.syncWithDeployed', ws(), [ws()]);
    await eventually(async () => tabs(), (t) => t.some((l) => l.startsWith('Sync: E2E SFTP')));
  });

  it('reveals the Remote Host view', async () => {
    await vscode.commands.executeCommand('iremote.remoteHost.focus');
    await vscode.commands.executeCommand('iremote.remote.refresh');
  });
});
