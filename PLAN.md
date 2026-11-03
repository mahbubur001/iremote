# iRemote — PhpStorm-style Remote Host / Deployment for VS Code

## 1. What PhpStorm actually does (feature inventory)

PhpStorm calls it **Deployment** (Settings → Build, Execution, Deployment → Deployment) plus the **Remote Host** tool window.

### 1.1 Server configuration
| Area | Details |
|---|---|
| Server types | SFTP, FTP, FTPS (explicit/implicit), WebDAV, Local or mounted folder, In place |
| Connection | host, port, username, auth (password / key pair + passphrase / OpenSSH config & agent), root path, web server URL, FTP passive mode, "Test connection", auto-detect root |
| Mappings | multiple rows: **local path ↔ deployment path (relative to root) ↔ web path** |
| Excluded paths | separate local excludes and remote (deployment) excludes |
| Default server | one server marked default (bold) → target of auto-upload |
| Credentials | stored in OS keychain, not in project files |
| Storage | `.idea/webServers.xml` (hosts), `.idea/deployment.xml` (mappings, options) |

### 1.2 Deployment options (global per project)
- Auto upload to default server: **Always / On explicit save / Never**
- Skip external changes (git checkout etc.)
- Delete remote files when local deleted
- Create empty directories
- Preserve timestamps / original permissions; override default file & folder permissions (chmod)
- **Warn when uploading over newer file** (compare timestamp+size or content)
- Exclude items by name pattern (`.git;.idea;.DS_Store;...`)
- Confirm before delete; overwrite up-to-date files; operations logging level

### 1.3 Actions
- Upload to… / Upload to default server (file, folder, selection)
- Download from…
- **Sync with Deployed to…** — tree diff dialog: per-file direction arrows (→ upload, ← download, ✕ delete, skip), diff preview, "Synchronize All"
- **Compare with Deployed Version** — side-by-side diff
- Browse Remote Host / toggle automatic upload
- Remote "Open in Editor": edit remote file directly, save ⇒ upload

### 1.4 Remote Host tool window
- Tree of remote server (lazy-loaded), server switcher dropdown
- Open/edit, create file/folder, rename, delete, drag-drop upload, download to mapped local path, copy path, chmod, compare with local, "Show in local project", refresh
- Unmapped files shown greyed; mapped highlighted

### 1.5 Supporting UX
- **File Transfer** tool window: log of every op (time, direction, path, status, errors)
- Background queue with progress, cancellable
- Notifications: "remote file changed since last download — overwrite?"

---

## 2. VS Code architecture

### 2.1 Key VS Code APIs
| Need | API |
|---|---|
| Edit remote files natively (true "direct edit") | `vscode.workspace.registerFileSystemProvider('iremote', …)` — URIs `iremote://<serverId>/path` |
| Remote Host browser | `TreeDataProvider` view in custom Activity Bar container |
| Mount server as workspace folder (optional) | `workspace.updateWorkspaceFolders` with `iremote://` URI |
| Settings UI (PhpStorm-like dialog) | `WebviewPanel` (React/Svelte + `@vscode/webview-ui-toolkit` successor / own CSS vars) |
| Passwords / passphrases | `context.secrets` (SecretStorage → OS keychain) |
| Auto-upload | `workspace.onDidSaveTextDocument`, `workspace.createFileSystemWatcher`, `onDidCreate/Delete/RenameFiles` |
| Diff | `vscode.commands.executeCommand('vscode.diff', localUri, remoteUri, title)` |
| Progress | `window.withProgress` |
| Transfer log | `OutputChannel` (LogOutputChannel) + optional tree view |
| Status bar | default server + auto-upload toggle + queue count |
| Context menus | `contributes.menus` → `explorer/context`, `editor/title/context`, `view/item/context` |
| Decorations (mapped/excluded/conflict) | `FileDecorationProvider` |

### 2.2 Protocol libraries (Node, desktop only)
| Protocol | Library | Notes |
|---|---|---|
| SFTP | `ssh2` (+ thin wrapper or `ssh2-sftp-client`) | optional native `cpu-features` → mark external/optional when bundling; supports agent, keys, jump host via `sock` |
| FTP / FTPS | `basic-ftp` | 1 transfer per connection ⇒ need connection pool; MLSD/MDTM for mtimes |
| WebDAV | `webdav` (perry-mitchell) | ESM — bundle with esbuild |
| Local/mounted | `fs/promises` | trivial |
| SSH config | `ssh-config` | parse `~/.ssh/config` |
| Globs | `minimatch` / `picomatch` | excludes |

Desktop-only (`"extensionKind": ["ui"]` so it runs locally even when user is in Remote-SSH/WSL). No vscode.dev support (raw TCP needed).

### 2.3 Core modules
```
src/
  extension.ts                 activate: register everything
  config/
    schema.ts                  types + JSON schema
    ConfigStore.ts             load/save .vscode/iremote.json, watch changes
    PhpStormImporter.ts        parse .idea/webServers.xml + deployment.xml
    secrets.ts                 SecretStorage wrapper
  protocol/
    RemoteClient.ts            interface: connect, list, stat, read, write, mkdir, rm, rename, chmod, exec?
    SftpClient.ts / FtpClient.ts / WebDavClient.ts / LocalClient.ts
    ConnectionPool.ts          per-server pool, keepalive, idle close, reconnect
  core/
    PathMapper.ts              local ↔ remote ↔ web, longest-prefix match, excludes
    TransferQueue.ts           concurrency, retry, cancel, priority, dedupe
    SyncEngine.ts              tree diff (mtime/size/hash), plan → execute
    StateCache.ts              last-known remote mtime/size per file (conflict detection)
    AutoUploader.ts            save/watch listeners → queue
  fs/
    RemoteFileSystemProvider.ts  iremote:// scheme
  views/
    RemoteHostTree.ts          Remote Host browser
    TransferLogView.ts
    SyncPanel/                 webview: sync dialog
    SettingsPanel/             webview: Deployment settings
  commands/                    upload, download, sync, compare, browse, toggleAuto, setDefault…
  ui/StatusBar.ts, Decorations.ts
```

### 2.4 Config file (`.vscode/iremote.json`, no secrets)
```json
{
  "defaultServer": "prod",
  "options": {
    "autoUpload": "onExplicitSave",
    "skipExternalChanges": true,
    "deleteRemoteOnLocalDelete": false,
    "preserveTimestamps": true,
    "warnOnNewerRemote": "timestampAndSize",
    "permissions": { "file": "644", "folder": "755" },
    "excludeNames": [".git", ".idea", ".DS_Store", "node_modules"],
    "concurrency": 4
  },
  "servers": [
    {
      "id": "prod",
      "name": "Production",
      "type": "sftp",
      "host": "example.com",
      "port": 22,
      "username": "deploy",
      "auth": "key",
      "privateKeyPath": "~/.ssh/id_ed25519",
      "rootPath": "/var/www",
      "webUrl": "https://example.com",
      "mappings": [{ "local": "/", "remote": "/html", "web": "/" }],
      "excludedLocal": ["storage/logs"],
      "excludedRemote": ["/html/uploads"]
    }
  ]
}
```

### 2.5 Key flows
1. **Save → upload**: onDidSave → PathMapper (mapped? excluded?) → StateCache check remote stat vs last-known → newer remote ⇒ prompt (Overwrite / Compare / Cancel) → queue upload → update cache → log.
2. **Edit remote directly**: tree click → open `iremote://prod/var/www/html/index.php` → FS provider `readFile` via pool → save ⇒ `writeFile` uploads. Optional "Download to mapped local" instead.
3. **Sync**: walk local + remote (parallel, excludes applied) → classify (new local, new remote, changed, same, deleted) → webview with direction toggles & diff → execute via queue.
4. **Compare**: `vscode.diff(local, iremote://…)`.

---

## 3. Delivery phases

| Phase | Scope | Done when |
|---|---|---|
| **0 Scaffold** | `yo code` TS + esbuild, lint, test harness (Docker `atmoz/sftp`, `delfer/alpine-ftp-server`, `bytemark/webdav`) | extension activates, CI runs |
| **1 MVP (SFTP)** | config file + SecretStorage, SftpClient + pool, PathMapper, Upload/Download commands, auto-upload on save, Remote Host tree, FS provider (open/edit/save remote), transfer log, status bar | edit file locally → saved remotely; browse & edit remote file |
| **2 Parity core** | FTP/FTPS, Compare with deployed, conflict warning (StateCache), delete/rename propagation, excludes, permissions, multiple mappings, multiple servers + default switch | matches PhpStorm daily workflow |
| **3 Sync & UI** | Sync dialog webview, Settings webview (PhpStorm-like tabs: Connection / Mappings / Excluded Paths), Test connection, auto-detect root, drag-drop in tree, file decorations | non-JSON users can configure everything |
| **4 Advanced** | WebDAV, Local/mounted, import from PhpStorm `.idea`, `~/.ssh/config` + agent + jump host, keepalive/reconnect, hash compare via `exec sha1sum`, "Open in browser" (web path) | power-user parity |
| **5 Ship** | docs, icons, telemetry opt-in (or none), Marketplace + Open VSX publish | v1.0 published |

---

## 4. Risks & gotchas
- **FTP**: one command at a time per socket → pool; MDTM timezone/precision differences → compare with tolerance; some servers lack MLSD.
- **Clock skew** between local and server breaks timestamp compare → store server-reported mtime after upload, not local mtime.
- **Bundling `ssh2`**: native optional deps; test on mac (arm64/x64), Windows, Linux.
- **FS provider + large dirs**: lazy `readDirectory`, cache `stat` with short TTL, avoid VS Code's eager search/indexing on `iremote://` (set `files.exclude`/no search provider initially).
- **Git checkout / bulk external changes** → "skip external changes" must ignore watcher events not from editor saves.
- **Secrets never in JSON**; warn if `password` key found in config.
- **Encoding / line endings**: transfer bytes as-is (binary), never re-encode.

## 5. Competitive landscape
- `liximomo.sftp` — popular, unmaintained; `Natizyskunk.sftp` fork — maintained, JSON-only, no real Remote Host browser/sync dialog.
- MS **Remote-SSH** — needs SSH shell + vscode-server on host; useless for FTP/shared hosting.
- Gap iRemote fills: **PhpStorm-parity UX** — settings UI, mappings, Remote Host browser with native editing, sync dialog, conflict detection, PhpStorm config import.
