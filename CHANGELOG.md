# Changelog

## 1.2.0

- **Neovim plugin**, using the same `.vscode/iremote.json` and the same engine as the extension
  ([docs/neovim.md](docs/neovim.md)):
  - upload / download, compare with the deployed version, default server and auto-upload mode, keychain passwords;
  - automatic upload on `:write`, of new files, delete / rename / move propagation from neo-tree, and external changes
    (git checkout, build tools) in *Always* mode;
  - **Remote Host** as a neo-tree tab: browse, open and edit remote files in place (with a changed-on-server check and
    reload on focus), new file / folder, rename / move, delete, permissions, download, upload here;
  - **Sync with Deployed** view with per-file upload / download / delete actions;
  - PhpStorm deployment import;
  - **Deployment settings dialog** (servers, connection, mappings, excluded paths, options, test connection) and a
    one-key action menu;
  - File Transfer view with live progress, `:checkhealth iremote`, statusline component.
- Internal: `ServerManager`, logging and host-key trust no longer depend on the VS Code API (shared with Neovim).

## 1.1.4

- SSH sessions open as a tab next to your other terminals: in the active group when started from a terminal tab, else
  in the group that holds terminal tabs, else at `terminal.integrated.defaultLocation` (they used to always open in the
  panel).

## 1.1.3

- Deployment Settings opens in its own floating window, like PhpStorm's Deployment dialog; OK / Cancel close it.
  Setting `iremote.settings.openIn` (`window` / `editor`) keeps the old editor tab if you prefer it.

## 1.1.2

- Start SSH Session lists only your iRemote SFTP servers (marked *project* or *global*), `~/.ssh/config` hosts and
  recent typed hosts; PhpStorm's SSH configurations are no longer listed. Saved servers log in with their keychain
  password without asking.
- New PhpStorm-style icon for the SSH session button.
- **Import PhpStorm SSH Configurations**: copies PhpStorm's SSH list into iRemote's global servers once (offered in the
  session list while it has no servers, and in the Remote Host `…` menu).

## 1.1.1

- The **Start SSH Session…** button also appears in the editor title bar when a terminal is open as an editor tab (terminals in the editor area have no terminal panel title bar).

## 1.1.0

- **Start SSH Session…** (PhpStorm's Tools | Start SSH Session): an SSH shell in a VS Code terminal for any SFTP server,
  PhpStorm SSH configuration (read live from the IDE settings) or `~/.ssh/config` host, or a typed `user@host:port`.
  Also available as **SSH Session…** in the terminal's new-terminal dropdown, from the terminal panel title and as
  **Open SSH Session Here** in Remote Host. Logins reuse the keychain, agent, jump host and host-key checks.
- **Install Public Key on SSH Host…**: adds your public key to the server's `authorized_keys`, verifies it and uses
  key login for that host's sessions from then on.
- Fix: IDE-level PhpStorm settings (`options/webServers.xml`, `options/sshConfigs.xml`) were not read, so the import
  fallback for shared servers and SSH configurations found nothing.

## 1.0.4

- When `.vscode/iremote.json` is first created in a git repository, iRemote offers to add it to `.gitignore` (setting `iremote.git.offerToIgnoreConfig`).

## 1.0.3

- Fix: the remote folder picker now highlights a folder on click and **Select** uses it (it used to return the folder you were in). Double-click or Enter opens a folder; arrow keys move the selection.

## 1.0.2

- Fix: the Sync with Deployed dialog showed an empty Path column (file names and status badges were collapsed).
- README: screenshots of the Deployment settings and Sync dialogs.

## 1.0.1

- New extension and Activity Bar icons; the extension icon now has transparent corners (no white box on dark themes).
- Security: WebDAV client now uses minimatch 11 (fixes GHSA-g3hv-75wg-m249, denial of service via glob patterns).

## 1.0.0

- Deployment servers: SFTP, FTP, FTPS (explicit/implicit), WebDAV, local or mounted folder.
- PhpStorm-style Deployment settings (Connection / Mappings / Excluded Paths / Options) and PhpStorm import.
- Automatic upload (Always / On explicit save / Never), skip external changes, delete and rename propagation.
- Remote Host view with direct remote editing (`iremote://`), drag and drop, permissions, compare and sync.
- Sync with Deployed dialog, Compare with Deployed Version, File Transfer view, status bar.
- Keychain-backed credentials, known_hosts verification, TLS certificate pinning, SSH agent, ~/.ssh/config, jump hosts.
