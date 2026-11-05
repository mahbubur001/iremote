# Changelog

## Unreleased

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
