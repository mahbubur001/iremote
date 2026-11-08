# iRemote for Neovim

The same deployment engine as the VS Code extension, driven from Neovim. It reads the project's
`.vscode/iremote.json` (and VS Code's global servers), so one configuration works in both editors.

Status: **phase 1** — upload / download, automatic upload on save, compare with the deployed version, default server
and auto-upload mode, keychain passwords, host-key and TLS trust prompts. The Remote Host browser and the Sync dialog
are not available in Neovim yet; edit `.vscode/iremote.json` directly (or in VS Code's Deployment Settings).

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
  },
}
```

## Commands

| Command | PhpStorm / VS Code equivalent |
|---|---|
| `:IRemote upload [server-id]` | Upload to default server (current file, or the neo-tree node under the cursor — files and folders) |
| `:IRemote download [server-id]` | Download from default server |
| `:IRemote compare [server-id]` | Compare with Deployed Version — opens a diff tab (left: remote, read-only) |
| `:IRemote server` | Pick the default server (written to `defaultServer`) |
| `:IRemote autoupload [always\|onExplicitSave\|never]` | Upload changed files automatically |
| `:IRemote browser` | Open the file's web URL (mapping `web` + server `webUrl`) |
| `:IRemote log` | Transfer and connection log |
| `:IRemote cancel` / `disconnect` / `reload` | Cancel transfers, close connections, re-read config |
| `:IRemote forget` | Forget the default server's saved password and trusted host key |

Automatic upload runs on `:write` (`BufWritePost`) when the project's `autoUpload` is `always` or `onExplicitSave`.
It honours mappings, excluded paths and *warn when uploading over newer file* (Overwrite / Compare / Skip). Changes
made outside Neovim (git checkout, build tools) are not uploaded in phase 1.

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
`vim.ui.input` / `inputsecret()`.
