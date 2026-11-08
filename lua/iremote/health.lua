-- :checkhealth iremote
local M = {}

local h = vim.health

function M.check()
  local ir = require("iremote")
  h.start("iRemote")

  if vim.fn.has("nvim-0.10") == 1 then
    h.ok("Neovim " .. tostring(vim.version()))
  else
    h.error("Neovim 0.10 or newer is required")
  end

  local node = ir.config.node
  if vim.fn.executable(node) == 1 then
    local v = vim.trim(vim.fn.system({ node, "--version" }))
    local major = tonumber(v:match("^v(%d+)"))
    if major and major >= 20 then
      h.ok("Node.js " .. v .. " (" .. vim.fn.exepath(node) .. ")")
    else
      h.error("Node.js 20+ is required, found " .. v, { "Install a newer Node.js or set `node` in setup()" })
    end
  else
    h.error("`" .. node .. "` not found", { "Install Node.js 20+ or set `node` in setup()" })
  end

  local script = ir._server_script()
  if vim.fn.filereadable(script) == 1 then
    h.ok("Server built: " .. vim.fn.fnamemodify(script, ":~"))
  else
    h.error("Server not built: " .. script, { "Run :Lazy build iremote (or `npm ci && npm run build` in the plugin folder)" })
  end

  if vim.fn.has("mac") == 1 then
    h.ok("Passwords: macOS Keychain (`security`)")
  elseif vim.fn.executable("secret-tool") == 1 then
    h.ok("Passwords: libsecret (`secret-tool`)")
  else
    h.warn("No system keychain: passwords are kept for the session only", { "Install libsecret-tools (secret-tool)" })
  end

  h.start("iRemote: project")
  local file = vim.api.nvim_buf_get_name(0)
  local path = (file ~= "" and vim.bo.buftype == "") and file or (vim.fn.getcwd() .. "/.")
  local root = ir._find_project(path)
  if not root then
    h.info("No .vscode/iremote.json above " .. vim.fn.fnamemodify(path, ":~:h") .. " (open :IRemote settings to create one)")
  else
    local cfg_path = root .. "/.vscode/iremote.json"
    local ok, cfg = pcall(vim.json.decode, table.concat(vim.fn.readfile(cfg_path), "\n"))
    if not ok or type(cfg) ~= "table" then
      h.error(cfg_path .. " is not valid JSON")
    else
      local servers = cfg.servers or {}
      h.ok(string.format("%s: %d server(s), default: %s, auto-upload: %s", vim.fn.fnamemodify(cfg_path, ":~"), #servers, cfg.defaultServer or "none", (cfg.options or {}).autoUpload or "never"))
      if not cfg.defaultServer then
        h.warn("No default server", { "Pick one with :IRemote server" })
      end
    end
  end

  h.start("iRemote: integrations")
  local has_neotree, nt = pcall(require, "neo-tree")
  local nt_config = has_neotree and (nt.config or (nt.ensure_config and select(2, pcall(nt.ensure_config))) or nt.config) or nil
  if not has_neotree then
    h.info("neo-tree not installed: the Remote Host tab is unavailable (:IRemote remote needs it)")
  elseif type(nt_config) == "table" and nt_config.sources and (vim.tbl_contains(nt_config.sources, "iremote") or vim.tbl_contains(nt_config.sources, "iremote.neotree")) then
    h.ok("neo-tree: Remote Host source registered")
  else
    h.warn("neo-tree: add \"iremote.neotree\" to `sources` for the Remote Host tab")
  end
end

return M
