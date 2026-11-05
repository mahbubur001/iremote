# Architecture

iRemote is a desktop-only VS Code extension (`extensionKind: ["ui"]`), so it runs on the local machine even inside
Remote-SSH or WSL windows. Everything is wired in `src/extension.ts`, which builds the `Services` object
(`src/services.ts`) shared by commands, views and webviews.

```
          commands/  views/  webviews/  features/  fs/          ← VS Code integration
                              │
    config/ (ConfigStore, Credentials, PathMapper per server)
                              │
   core/  Deployer ─ SyncEngine ─ StateCache
             │
          TransferQueue ──► ServerManager ──► ConnectionPool (one per server)
                                                   │
   protocol/  SftpClient · FtpClient · WebDavClient · LocalClient   (no vscode imports)
```

## Protocol layer — `src/protocol/`

Every server type implements the `RemoteClient` contract in `types.ts`: list, stat, read/write, upload/download,
mkdirp, delete, rename, chmod, setMtime, exec. Rules:

- No `vscode` imports, so the same code runs in plain Node integration tests.
- Errors are mapped to `RemoteError` with a code (`NotFound`, `Auth`, `HostKey`, `Certificate`, `Cancelled`, …);
  callers branch on the code, never on library-specific messages.
- `capabilities` describe what a server can do (`chmod`, `setMtime`, `exec`, `reliableMtime`). FTP detects `MFMT`
  at login; WebDAV cannot chmod or set times.
- Remote paths are POSIX strings. Files are transferred as bytes, never re-encoded.

## Connections — `src/core/ServerManager.ts`, `ConnectionPool.ts`

`ServerManager` owns one `ConnectionPool` per server id and rebuilds it when connection-relevant settings change.
The pool creates `DeferredClient`s: the credentials are resolved only when a connection is actually opened
(keychain, password / passphrase prompts with retry, `~/.ssh/config`, SSH agent, jump host, known_hosts and TLS
certificate checks). The pool opens the first connection alone (so a bad password is asked once, not per parallel
request), then grows up to `maxConnections`, closes idle connections and retries once when a reused connection turns
out to be dead.

## Transfers — `TransferQueue`, `Deployer`, `StateCache`

- **`TransferQueue`** runs every transfer and feeds the File Transfer view and status bar. Tasks with the same key run
  in order; queued uploads of the same file are merged; cancel drops in-flight connections.
- **`Deployer`** maps local paths to remote ones, creates missing folders, applies permissions and timestamps, and
  records the result in `StateCache`. Before an upload it can check whether the remote file changed since the last
  transfer (*warn when uploading over newer file*). It also remembers its own local writes from downloads so
  auto-upload doesn't send them straight back.
- **`StateCache`** stores remote mtime/size, local mtime/size and SHA-1 per server and remote path after each transfer.
  It is the baseline for conflict checks and sync classification.
- **`SyncEngine`** walks both sides and classifies each file (local-only, remote-only, changed locally / remotely /
  both, same) for the Sync dialog. With `allowShellCommands` on SFTP it hashes remote files with `sha1sum`.

## Configuration — `src/config/`

- **`ConfigStore`** loads `.vscode/iremote.json` for every workspace folder plus shared servers from global storage,
  reloads on file changes and writes atomically. A server resolved for a project combines the definition with that
  project's mappings. It caches one `PathMapper` per project and server.
- **`normalize.ts`** sanitizes all input, from disk or from the settings UI. `schema.ts` holds the types and defaults;
  `schemas/iremote.schema.json` must be kept in sync with it.
- **`Credentials`** wraps SecretStorage, `~/.ssh/config` and `KnownHosts` (hashed entries, wildcards, `@revoked`).
- **`PathMapper`** translates local ↔ remote ↔ web paths and applies excluded paths and exclude-by-name patterns.
  See [configuration.md](configuration.md#mappings).

## Editor integration

- **`fs/RemoteFileSystemProvider`** registers the `iremote://<serverId>/<path>` scheme. Remote files open in the normal
  editor, and saving writes to the server. It remembers the mtime/size it read and asks before overwriting a file that
  changed on the server in the meantime.
- **`features/AutoUploader`** listens to saves, file creation/rename/delete and (in `always` mode) a file watcher, and
  implements *upload on save*, *skip external changes* and *delete remote files when local are deleted*.
- **`features/RemoteChangeMonitor`** re-checks open remote files when the window regains focus.
- **`views/`** — Remote Host tree (lazy, drag and drop), File Transfer view, status bar, Explorer decorations.
- **`webviews/`** — Deployment Settings and Sync panels. The browser side is in `webview/` (plain TypeScript with VS Code
  theme variables). Messages between the two sides are typed in `webview/shared/protocol.ts`.

## Main flows

**Save → upload.** `onDidSaveTextDocument` → `AutoUploader` checks the mode and the mapping → `Deployer.uploadFile`
→ `TransferQueue` → pooled client → `StateCache` updated.

**Edit on the server.** Remote Host → open `iremote://…` → provider `readFile` remembers the remote version → save
→ provider `writeFile` checks that version, writes, stores the new one.

**Sync with Deployed.** `SyncEngine` builds the file list → Sync panel shows it with per-file actions → the chosen
actions run through `Deployer`.
