# Configuration reference

Deployment settings live in `.vscode/iremote.json` in each workspace folder and are validated by
[`schemas/iremote.schema.json`](../schemas/iremote.schema.json). The **Deployment Settings…** dialog edits the same file.

Passwords and key passphrases are never stored here. They are kept in the OS keychain (VS Code SecretStorage);
`password` / `passphrase` keys are rejected by the schema.

## File layout

```json
{
  "version": 1,
  "defaultServer": "prod",
  "options": { },
  "servers": [ ],
  "globalServerData": { }
}
```

| Key | Description |
|---|---|
| `version` | Always `1`. |
| `defaultServer` | Id of the default server — the target of automatic upload and the *…Default Server* commands. |
| `options` | Project-wide deployment options (below). |
| `servers` | Servers *visible only for this project*. |
| `globalServerData` | Mappings and excluded paths for **shared** servers, keyed by server id. |

### Project vs. shared servers

Unchecking *Visible only for this project* in the settings dialog moves the server definition to VS Code's global
storage (`servers.json`), so every project can use it. Mappings and excluded paths always stay per project, in
`globalServerData`.

## Options

| Option | Default | PhpStorm equivalent |
|---|---|---|
| `autoUpload` | `never` | Upload changed files automatically to the default server: `always`, `onExplicitSave`, `never` |
| `skipExternalChanges` | `true` | Skip external changes (git checkout, build tools) |
| `deleteRemoteOnLocalDelete` | `false` | Delete remote files when local are deleted |
| `createEmptyDirectories` | `false` | Create empty directories |
| `preserveTimestamps` | `true` | Preserve files timestamps |
| `warnOnNewerRemote` | `timestampAndSize` | Warn when uploading over newer file: `none`, `timestampAndSize`, `content` |
| `filePermissions` | `""` | Override default permissions on files (octal, e.g. `"644"`; empty = server default) |
| `folderPermissions` | `""` | Override default permissions on folders |
| `excludeNames` | `.svn .cvs .idea .DS_Store .git .hg .vscode node_modules` | Exclude items by name (globs matched against every path segment) |
| `confirmRemoteDelete` | `true` | Confirm deleting remote files |
| `overwriteUpToDate` | `false` | Overwrite up-to-date files (sync) |
| `notifyRemoteChanges` | `true` | Notify about remote changes (re-check open remote files when VS Code regains focus) |
| `concurrency` | `4` | Parallel transfers per server |

*Upload on explicit save* uploads only on a manual save (not auto-save). External changes are only uploaded in
`always` mode with `skipExternalChanges` off.

## Servers

| Key | Applies to | Description |
|---|---|---|
| `id`, `name` | all | Unique id and display name. |
| `type` | all | `sftp`, `ftp`, `ftps` (explicit), `ftps-implicit`, `webdav`, `local` |
| `host` | all but `local` | Host name; for WebDAV the full endpoint URL. |
| `port` | | Defaults: SFTP 22, FTP/FTPS 21, implicit FTPS 990. |
| `username` | | |
| `auth` | SFTP | `password`, `key`, `agent`, `openssh` (use `~/.ssh/config`). |
| `privateKeyPath` | SFTP | OpenSSH or PuTTY key; `~` is expanded. |
| `sshConfigHost` | SFTP | Host alias in `~/.ssh/config` when `auth` is `openssh`. |
| `jumpHost` | SFTP | Bastion as `user@host:port`. |
| `rootPath` | all | Root on the server; deployment paths are relative to it. For `local`, a local directory. |
| `webUrl` | all | Web server URL, used for *Open in Browser*. |
| `passive` | FTP | Kept for PhpStorm import; only passive / EPSV transfers are supported. |
| `allowUntrustedCertificate` | FTPS, WebDAV | Allow self-signed certificates after you confirm the fingerprint. |
| `trustedCertificateFingerprint` | FTPS, WebDAV | Pinned SHA-256 fingerprint (written when you choose to pin). |
| `webdavAuth` | WebDAV | `basic`, `digest`, `none` |
| `encoding` | FTP | File name encoding: `utf8`, `latin1`, `ascii`, `utf16le`. |
| `maxConnections` | all | Connection pool size. Default: SFTP 2, others 4. |
| `keepAliveSeconds` | SFTP | SSH keep-alive interval, `0` disables. Default 30. |
| `allowShellCommands` | SFTP | Allow `sha1sum` over SSH for fast content comparison during sync. Default `false`. |
| `mappings` | all | Array of `{ local, remote, web }` (below). |
| `excludedLocal` | all | Local paths (relative to the project root) never deployed. |
| `excludedRemote` | all | Remote paths never touched. |

### Mappings

| Field | Meaning |
|---|---|
| `local` | Local path relative to the project root (`""` = the root) or absolute. |
| `remote` | Deployment path, relative to `rootPath`. |
| `web` | Web path, relative to `webUrl`. |

When several mappings match a file, the longest local path wins. Example: with `rootPath` `/var/www` and mappings
`{ "local": "", "remote": "/html" }` and `{ "local": "public/assets", "remote": "/cdn" }`, `public/assets/app.js`
deploys to `/var/www/cdn/app.js` and `public/index.php` to `/var/www/html/public/index.php`.

## Version control

`.vscode/iremote.json` is the counterpart of PhpStorm's `.idea/deployment.xml`: it holds mappings, excluded paths, the
default server and project-only servers (host, user, paths) — never passwords. Shared servers live outside the project,
in VS Code's global storage, like PhpStorm's IDE-level `options/webServers.xml`.

- **Commit it** to give a team the same deployment setup.
- **Ignore it** for personal setups or public repositories (host names and user names are visible in the file).

When iRemote creates the file inside a git repository that neither tracks nor ignores it, it asks once whether to add
it to `.gitignore` (an entry anchored to the repository root, e.g. `/.vscode/iremote.json`). Turn this off with
`iremote.git.offerToIgnoreConfig`. To ignore it in every repository, add `.vscode/iremote.json` to your global
gitignore (`git config --global core.excludesFile`).

The file is never uploaded: `.vscode` is in the default *Exclude items by name* list.

## VS Code settings

User/workspace settings (not in `iremote.json`) are listed in the [README](../README.md#settings).

## Importing from PhpStorm

**iRemote: Import PhpStorm Deployment Configuration** reads `.idea/deployment.xml`, `.idea/webServers.xml` and
`.idea/sshConfigs.xml`. PhpStorm's stored passwords cannot be imported; you are asked for them on first connect and can
save them to the keychain.
