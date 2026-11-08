# iRemote for Neovim

The same deployment engine as the VS Code extension, driven from Neovim. It reads the project's
`.vscode/iremote.json` (and VS Code's global servers), so one configuration works in both editors.

Covers upload / download, automatic upload (on `:write`, new files, delete / rename propagation and external changes),
compare with the deployed version, the **Remote Host** browser (a neo-tree tab, with direct remote editing), **Sync with
Deployed**, PhpStorm import, default server and auto-upload mode, keychain passwords and host-key / TLS trust. Servers are
set up in the **Deployment settings** dialog (`:IRemote settings`), which writes `.vscode/iremote.json`; `:IRemote`
alone opens a menu with every action.

## Requirements

- Neovim 0.10+ and Node.js 20+ on `PATH` (or set `node`).
- A built checkout: `npm ci && npm run build` produces `dist/nvim/iremote.js`.

## Installation (lazy.nvim)

```lua
{
  dir = "~/dev/iRemote", -- or "mahbubur001/iremote"
  name = "iremote",
  build = "npm ci && npm run build",
  event = { "BufReadPost", "BufNewFile" },
  cmd = "IRemote",
  opts = {},
  keys = {
    { "<leader>du", function() require("iremote").upload() end, desc = "Upload to default server" },
    { "<leader>dd", function() require("iremote").download() end, desc = "Download from default server" },
    { "<leader>dc", function() require("iremote").compare() end, desc = "Compare with deployed version" },
    { "<leader>ds", function() require("iremote").select_server() end, desc = "Select default server" },
    { "<leader>dr", function() require("iremote").remote_browser() end, desc = "Remote Host" },
    { "<leader>dS", function() require("iremote").sync() end, desc = "Sync with deployed" },
  },
}
```

### neo-tree: Remote Host tab and file-operation propagation

```lua
require("neo-tree").setup({
  sources = { "filesystem", "buffers", "git_status", "iremote.neotree" },
  source_selector = {
    winbar = true,
    sources = {
      { source = "filesystem" },
      { source = "buffers" },
      { source = "git_status" },
      { source = "iremote", display_name = " 󰒍 Remote " },
    },
  },
  -- create / delete / rename / move in neo-tree → default server (follows the project's options)
  event_handlers = require("iremote").neo_tree_event_handlers(),
})
```

## Commands

| Command | PhpStorm / VS Code equivalent |
|---|---|
| `:IRemote` / `:IRemote menu` | Action menu (every command below, with the current server and mode) |
| `:IRemote settings` | Deployment settings dialog |
| `:IRemote upload [server-id]` | Upload to default server (current file, or the neo-tree node under the cursor — files and folders) |
| `:IRemote download [server-id]` | Download from default server |
| `:IRemote compare [server-id]` | Compare with Deployed Version — opens a diff tab (left: remote, read-only) |
| `:IRemote server` | Pick the default server (written to `defaultServer`) |
| `:IRemote autoupload [always\|onExplicitSave\|never]` | Upload changed files automatically |
| `:IRemote browser` | Open the file's web URL (mapping `web` + server `webUrl`) |
| `:IRemote remote [float\|left\|right\|current]` | Remote Host (neo-tree `iremote` source) |
| `:IRemote sync [paths…]` | Sync with Deployed (default: the project root) |
| `:IRemote import [dir]` | Import PhpStorm's `.idea/deployment.xml` / `webServers.xml` |
| `:IRemote log` | Transfer and connection log |
| `:IRemote cancel` / `disconnect` / `reload` | Cancel transfers, close connections, re-read config |
| `:IRemote forget` | Forget the default server's saved password and trusted host key |

Automatic upload follows the project's options exactly like VS Code / PhpStorm:

- `:write` uploads when `autoUpload` is `always` or `onExplicitSave`; files created in neo-tree upload in `always` mode.
- Deleting / renaming / moving in neo-tree is mirrored on the server (`deleteRemoteOnLocalDelete` for deletes).
- With `always` and `skipExternalChanges: false`, a recursive watcher uploads changes made outside Neovim (git
  checkout, build tools) and propagates their deletions; `.git` is ignored.
- Mappings, excluded paths and *warn when uploading over newer file* (Overwrite / Compare / Skip) apply throughout.

## Deployment settings dialog

`:IRemote settings` opens PhpStorm's Deployment dialog in floating windows: servers on the left, tabs on the right.

| Where | Key | Action |
|---|---|---|
| Server list | `a` / `c` / `d` | Add (name + type) / clone / delete a server |
| | `*` | Make it the default server (●) |
| | `<CR>` / `<Tab>` | Edit the selected server |
| Detail pane | `1`–`4`, `<Tab>` / `<S-Tab>` | Connection · Mappings · Excluded · Options |
| | `<CR>` / `e` | Edit the field under the cursor (text, list picker, number; *Password* asks and saves to the keychain) |
| | `<Space>` | Toggle a checkbox |
| | `a` / `d` | Add / delete a mapping or excluded path |
| | `h` | Back to the server list |
| Both | `T` | Test connection (works on unsaved changes) |
| | `<C-s>` | Save to `.vscode/iremote.json` (validated first; invalid settings are not written) |
| | `q` / `<Esc>` | Close (asks to save unsaved changes) |

The Connection tab shows the fields that apply to the server type (SFTP auth method, key file, jump host; FTP passive
mode, encoding, certificate; WebDAV auth). Global servers from VS Code are listed too: their connection is edited in VS
Code, their mappings and excluded paths per project here. A project without `.vscode/iremote.json` starts empty; saving
creates the file.

## Remote Host

`:IRemote remote` (or the **Remote** tab in neo-tree) lists the default server from its root path; folders load as you
expand them. Size, modification time and permissions are shown on the right.

| Key | Action |
|---|---|
| `<CR>` / `l`, `s`, `S`, `t` | Open (the mapped local file when it exists, else the remote file), in a vsplit / split / tab |
| `L` | Open the remote file even when a local copy exists |
| `h` | Collapse |
| `a` / `A` | New file (end with `/` for a folder) / new folder |
| `r` | Rename or move (edit the full remote path) |
| `d` | Delete on the server (asks first) |
| `D` | Download to the mapped local path |
| `U` | Upload local files or folders into this folder (paths separated by spaces, `<Tab>` completes) |
| `=` | Compare with the mapped local file |
| `c` | Change permissions (octal; folders can apply recursively) |
| `gx`, `Y` | Open the web URL, copy the remote path |
| `.` / `<BS>` | Make this folder the root / go up |
| `sv` | Show another server |
| `R` | Refresh |

Remote files open as temp copies (named like the original, so filetype detection works). `:write` saves to the server;
if the file changed on the server since you opened it you are asked before it is overwritten. When Neovim regains focus,
open remote files that changed on the server offer to reload.

## Sync with Deployed

`:IRemote sync` compares the project (or the given paths) with the default server and lists every difference with an
action. Identical files are hidden (`i` shows them).

| Key | Action |
|---|---|
| `u` / `d` | Upload / download (works on a visual selection too) |
| `R` / `L` | Delete on the server / move the local file to the trash |
| `s` | Skip |
| `=` | Diff the file with the server version |
| `S` | Synchronize: run every action that is not *skip* (deletes ask first) |
| `r` / `c` | Compare again / compare again by content (hashes files whose size matches) |
| `q` | Close |

PhpStorm projects: `:IRemote import` reads `.idea/deployment.xml`, `webServers.xml` and `sshConfigs.xml` (plus
IDE-level servers when needed) and writes `.vscode/iremote.json`, merging with or replacing existing servers.

`require("iremote").statusline()` returns e.g. `󰒍 Production ↑` (`↑` = automatic upload on) for your statusline.

## Options

```lua
require("iremote").setup({
  node = "node",
  auto_upload = true,                               -- false: never upload on :write, whatever the project says
  state_dir = vim.fn.stdpath("state") .. "/iremote", -- trusted host keys, sync state
  global_servers_file = nil,                        -- nil = VS Code's globalStorage/itemcoder.iremote/servers.json
  known_hosts_files = {},                           -- extra known_hosts files (iremote.ssh.knownHostsFiles)
  log_level = "brief",                              -- errors | brief | details
  timeout_seconds = 20,
  idle_close_seconds = 300,
})
```

## Credentials and trust

- Passwords and key passphrases are asked for when needed and offered for saving in the system keychain: macOS
  Keychain (`security`, service `iremote`) or libsecret (`secret-tool`) on Linux. Secrets are passed to those tools on
  stdin, never as arguments. Without a keychain they are kept for the session only.
- VS Code's SecretStorage cannot be read by other programs, so each password is entered once in Neovim too.
- SSH host keys follow the same policy as VS Code (`~/.ssh/known_hosts` first, then keys you trusted in iRemote, stored
  in `state_dir/known_hosts.json`). TLS certificate pins are written to the server definition, as in VS Code.

## How it works

`dist/nvim/iremote.js` is a Node process started on first use. It bundles `src/protocol`, `src/core` and the
VS Code-free parts of `src/config` — the very code the extension runs — plus `src/nvim` (config discovery, keychain,
prompts). The Lua plugin (`lua/iremote`, `plugin/iremote.lua`) talks to it with newline-delimited JSON-RPC over stdio;
prompts (passwords, host keys, conflicts) are requests from the server back to Neovim, answered with `vim.ui.select` /
`vim.ui.input` / `inputsecret()`. Server modules: `remote.ts` (Remote Host), `sync.ts`, `autoUpload.ts`,
`import.ts`, `settings.ts`; the neo-tree source is `lua/iremote/neotree/`, the Sync view `lua/iremote/sync.lua`, the settings dialog
`lua/iremote/settings.lua`, the action menu `lua/iremote/menu.lua`.
