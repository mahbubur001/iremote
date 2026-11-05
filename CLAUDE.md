# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

iRemote is a VS Code extension that reproduces PhpStorm's **Deployment** settings and **Remote Host** tool window
(SFTP, FTP/FTPS, WebDAV, local/mounted folders). `PLAN.md` holds the PhpStorm feature inventory and the original design;
behaviour should match PhpStorm's concepts and naming (mappings, default server, "Upload changed files automatically", …).
Longer human-facing docs are in `docs/` (configuration reference, architecture, development); update them when
behaviour, options or the test setup change.

## Commands

```bash
npm run build            # esbuild: extension → dist/extension.js, webviews → dist/webview/
npm run watch            # rebuild on change; F5 launches the Extension Development Host
npm test                 # typecheck (extension + webview tsconfigs) + unit tests
npm run lint
npm run package          # iremote-<version>.vsix

npm run test:servers:up  # Docker: SFTP :2222, ProFTPD FTP/FTPS :2121, vsftpd :2122, WebDAV :8080 (user tester / pass)
npm run test:integration # protocol contract + Deployer/Sync tests against the containers
npm run test:e2e         # mocha inside a downloaded VS Code, against the SFTP container
npm run test:servers:down
```

Tests are bundled by `scripts/build-tests.mjs` into `out-test/` and run with `node --test`. Single test file / test:

```bash
node scripts/build-tests.mjs && node --test out-test/unit/PathMapper.test.js
node scripts/build-tests.mjs && node --test --test-name-pattern="longest local mapping" "out-test/unit/**/*.test.js"
```

Keep `node --test` arguments as quoted globs, not directories: Node 22 (used in CI) does not accept a directory.
`test:servers:up` also generates the throw-away SSH key in `test/fixtures/` (git-ignored). `examples/demo` is a project
wired to these containers. CI (`.github/workflows/ci.yml`) runs typecheck/lint/unit/package on Linux, Windows and macOS,
and integration + e2e (under `xvfb-run`) on Linux; on e2e failure the VS Code logs are uploaded as an artifact.

## Architecture

Wiring happens in `src/extension.ts` (`activate`), which builds the `Services` bag (`src/services.ts`) passed to commands,
views and webviews.

Layers, lowest first:

- **`src/protocol/`** — one `RemoteClient` contract (`types.ts`) implemented by `SftpClient` (ssh2), `FtpClient`
  (basic-ftp), `WebDavClient`, `LocalClient`. These must **not import `vscode`**, so integration tests run them in plain
  Node. All failures are normalized to `RemoteError` with a `RemoteErrorCode`; `capabilities` (chmod, setMtime, exec,
  reliableMtime) gate optional operations. Remote paths are always POSIX.
- **`src/core/`**
  - `ServerManager` owns one `ConnectionPool` per server. Its `DeferredClient` resolves credentials lazily at connect
    time (keychain, prompts, `~/.ssh/config`, agent, jump host, host-key / TLS verification) so the pool factory stays
    synchronous. Pools are rebuilt when connection-relevant config fields change.
  - `ConnectionPool` — first connection opens alone, then up to the limit; retries once on a stale reused connection.
  - `TransferQueue` — all transfers go through it; tasks with the same key run in order and queued uploads coalesce;
    cancel drops in-flight connections. Feeds the File Transfer view and status bar.
  - `PathMapper` — local ↔ remote ↔ web path translation (longest mapping wins), excluded paths and exclude-by-name.
    Local paths are OS-native; the `platform` argument selects win32/posix rules (tests pass it explicitly).
  - `Deployer` — upload/download/delete/rename on top of the queue; conflict detection ("warn when uploading over
    newer file") compares against `StateCache`; tracks its own local writes so auto-upload doesn't echo downloads back.
  - `StateCache` — per server/remote path record of mtime/size/sha1 after each transfer (persisted atomically).
  - `SyncEngine` — classifies files for the Sync with Deployed dialog.
- **`src/config/`** — `ConfigStore` reads `.vscode/iremote.json` per workspace folder plus global servers in
  `globalStorage/servers.json` (servers not "visible only for this project"; their mappings stay per project in
  `globalServerData`). `normalize.ts` sanitizes everything read from disk or the UI; `schema.ts` holds the TS types and
  defaults, and `schemas/iremote.schema.json` validates the file in the editor — keep the two in sync. Secrets live only
  in SecretStorage (`Credentials`), never in the JSON. `PhpStormImporter` reads `.idea/*.xml`.
- **`src/fs/RemoteFileSystemProvider`** — the `iremote://<serverId>/<abs path>` scheme for direct remote editing; it
  remembers the remote mtime/size read into an editor and asks before overwriting a file changed on the server.
- **`src/features/`** — `AutoUploader` (save / file-watcher driven uploads, "skip external changes", delete & rename
  propagation) and `RemoteChangeMonitor` (re-checks open remote files on window focus).
- **`src/views/`, `src/commands/`** — Remote Host tree, File Transfer view, status bar, decorations; command handlers.
- **Webviews** — extension side in `src/webviews/` (`SettingsPanel`, `SyncPanel`), browser side in `webview/` (plain
  TypeScript + VS Code theme CSS variables, bundled as IIFE). Message types shared by both sides live in
  `webview/shared/protocol.ts`, which must stay free of runtime imports.

## Constraints

- Desktop only: `extensionKind: ["ui"]` (runs locally even in Remote-SSH/WSL); no vscode.dev support.
- `ssh2`'s optional native modules (`cpu-features`, `sshcrypto.node`) are marked external in both esbuild scripts and
  are not shipped.
- Untrusted workspaces are not supported (the extension connects to servers from workspace config).
