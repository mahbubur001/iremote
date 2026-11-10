-- iRemote for Neovim: PhpStorm-style deployment driven by the same core as the VS Code extension.
-- Reads the project's .vscode/iremote.json, so both editors share one configuration.
local rpc = require("iremote.rpc")

local M = {}

---@class iremote.Config
local defaults = {
  node = "node",
  -- Upload on :write when the project's autoUpload option is "always" or "onExplicitSave".
  auto_upload = true,
  -- Where trusted host keys and sync state are kept.
  state_dir = vim.fn.stdpath("state") .. "/iremote",
  -- VS Code's global (IDE-level) servers file; nil = the default VS Code location.
  global_servers_file = nil,
  known_hosts_files = {},
  log_level = "brief", -- errors | brief | details
  timeout_seconds = 20,
  idle_close_seconds = 300,
  -- Remote Host: open the mapped local file instead of a remote copy when it exists (PhpStorm default).
  open_local_if_mapped = true,
  -- Check open remote buffers for changes on the server when Neovim regains focus.
  check_remote_on_focus = true,
}

M.config = vim.deepcopy(defaults)

local initialized = false
local starting = {} ---@type fun()[]
local log_lines = {} ---@type string[]
local MAX_LOG = 1000
local status_cache = {} ---@type table<string, table>

local root_dir = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h:h")
local server_script = root_dir .. "/dist/nvim/iremote.js"

local function notify(msg, level, opts)
  vim.notify(msg, level or vim.log.levels.INFO, vim.tbl_extend("force", { title = "iRemote" }, opts or {}))
end

local function add_log(level, message)
  table.insert(log_lines, os.date("%H:%M:%S") .. " [" .. level .. "] " .. message)
  if #log_lines > MAX_LOG then
    table.remove(log_lines, 1)
  end
end

--- Nearest project with a .vscode/iremote.json above `path` (cheap check, done before starting Node).
local function find_project(path)
  local found = vim.fs.find(".vscode/iremote.json", { path = vim.fs.dirname(path), upward = true, type = "file" })[1]
  return found and vim.fs.dirname(vim.fs.dirname(found)) or nil
end

local function register_handlers()
  rpc.on_request("prompt", function(p, reply)
    vim.schedule(function()
      if p.secret then
        local ok, value = pcall(vim.fn.inputsecret, p.prompt .. ": ")
        reply(ok and value ~= "" and value or nil)
      else
        vim.ui.input({ prompt = p.prompt .. ": " }, function(value)
          reply(value)
        end)
      end
    end)
  end)

  rpc.on_request("confirm", function(p, reply)
    vim.schedule(function()
      local prompt = p.message
      if p.detail and p.detail ~= "" then
        prompt = prompt .. "\n" .. p.detail
      end
      vim.ui.select(p.choices, { prompt = prompt, kind = "iremote.confirm" }, function(choice)
        reply(choice)
      end)
    end)
  end)

  rpc.on_request("diff", function(p, reply)
    M.open_diff(p["local"], p.remote, p.title)
    reply(true)
  end)

  rpc.on_notification("log", function(p)
    add_log(p.level, p.message)
    if p.level == "error" then
      notify(p.message, vim.log.levels.ERROR)
    end
  end)

  rpc.on_notification("configChanged", function()
    status_cache = {}
    vim.api.nvim_exec_autocmds("User", { pattern = "IRemoteConfigChanged", modeline = false })
  end)

  rpc.on_notification("transfer", function(p)
    require("iremote.transfers").record(p)
    local name = vim.fn.fnamemodify(p.kind == "download" and p.target or p.source, ":t")
    if p.status == "done" then
      add_log("info", string.format("%s %s → %s", p.kind, p.source, p.target))
      if p.kind == "upload" or p.kind == "download" then
        notify(string.format("%s %s (%s)", p.kind == "upload" and "↑" or "↓", name, p.server), vim.log.levels.INFO, { id = "iremote_transfer" })
      end
    elseif p.status == "failed" then
      add_log("error", string.format("%s %s failed: %s", p.kind, p.source, p.error or "?"))
      notify(string.format("%s of %s failed: %s", p.kind, name, p.error or "?"), vim.log.levels.ERROR)
    end
  end)
end

--- Starts the Node server on first use and runs `fn` once it is initialized.
local function with_server(fn)
  if initialized and rpc.running() then
    return fn()
  end
  table.insert(starting, fn)
  if #starting > 1 then
    return
  end
  if vim.fn.filereadable(server_script) == 0 then
    starting = {}
    return notify("Server not built. Run `npm ci && npm run build` in " .. root_dir, vim.log.levels.ERROR)
  end
  register_handlers()
  local ok = rpc.start({
    cmd = { M.config.node, server_script },
    on_stderr = function(lines)
      for _, l in ipairs(lines) do
        if l ~= "" then
          add_log("stderr", l)
        end
      end
    end,
    on_exit = function(code)
      initialized = false
      -- 143 = SIGTERM from Neovim stopping the job on exit; not worth a warning.
      if code ~= 0 and code ~= 143 and vim.v.exiting == vim.NIL then
        vim.schedule(function()
          notify("Server exited with code " .. code .. " (see :IRemote log)", vim.log.levels.WARN)
        end)
      end
    end,
  })
  if not ok then
    starting = {}
    return notify("Could not start `" .. M.config.node .. "`", vim.log.levels.ERROR)
  end
  vim.fn.mkdir(M.config.state_dir, "p")
  rpc.request("initialize", {
    stateDir = M.config.state_dir,
    globalServersFile = M.config.global_servers_file,
    knownHostsFiles = M.config.known_hosts_files,
    logLevel = M.config.log_level,
    timeoutSeconds = M.config.timeout_seconds,
    idleCloseSeconds = M.config.idle_close_seconds,
  }, function(err, res)
    local queued = starting
    starting = {}
    if err then
      return notify("Initialization failed: " .. err, vim.log.levels.ERROR)
    end
    initialized = true
    for _, problem in ipairs(res.problems or {}) do
      add_log("error", "Configuration: " .. problem)
      notify("Configuration: " .. problem, vim.log.levels.WARN)
    end
    for _, f in ipairs(queued) do
      f()
    end
  end)
end

--- Calls a server method; errors are shown as notifications, `cb` gets the result on success.
local function call(method, params, cb)
  with_server(function()
    rpc.request(method, params, function(err, result)
      if err then
        add_log("error", method .. ": " .. err)
        return notify(err, vim.log.levels.ERROR)
      end
      if cb then
        cb(result)
      end
    end)
  end)
end

--- Public: raw server call for extensions (neo-tree source, sync view).
M.request = function(method, params, cb)
  call(method, params, cb)
end

local function report(verb, r)
  if not r or r == vim.NIL then
    return
  end
  if #r.failed > 0 then
    local first = r.failed[1]
    notify(string.format("%s to %s: %d failed — %s", verb, r.server, #r.failed, first.error), vim.log.levels.ERROR)
  elseif r.transferred == 0 and r.skipped > 0 then
    notify(string.format("%s to %s: skipped (%d)", verb, r.server, r.skipped), vim.log.levels.WARN)
  else
    notify(string.format("%s %d file(s) — %s", verb, r.transferred, r.server), vim.log.levels.INFO, { id = "iremote_transfer" })
  end
end

local function current_path()
  local name = vim.api.nvim_buf_get_name(0)
  if name == "" or vim.bo.buftype ~= "" then
    -- neo-tree / oil buffers: use the node under the cursor when available
    local ok, manager = pcall(require, "neo-tree.sources.manager")
    if ok and vim.bo.filetype == "neo-tree" then
      local state = manager.get_state("filesystem")
      local node = state.tree and state.tree:get_node()
      if node and state.bufnr == vim.api.nvim_get_current_buf() then
        return node:get_id()
      end
    end
    return nil
  end
  return vim.fn.fnamemodify(name, ":p")
end

local function need_path(path)
  path = path or current_path()
  if not path then
    notify("No file here.", vim.log.levels.WARN)
  end
  return path
end

-- Public API -------------------------------------------------------------------------------

M.report = report

--- Opens a remote file from the Remote Host: the mapped local file when `prefer_local` and it exists, else a temp copy
--- that is written back to the server on :write (with a "changed on the server" check).
---@param anchor string any path inside the project
function M.open_remote(anchor, server_id, remote_path, cmd, prefer_local)
  call("remoteOpen", { path = anchor, serverId = server_id, remotePath = remote_path, preferLocal = prefer_local }, function(r)
    vim.schedule(function()
      if vim.bo.filetype == "neo-tree" then
        -- open in the editor window, not inside the explorer: close a floating tree, leave a sidebar
        if vim.api.nvim_win_get_config(0).relative ~= "" then
          pcall(vim.cmd, "Neotree close")
        else
          vim.cmd("wincmd p")
        end
      end
      vim.cmd((cmd or "edit") .. " " .. vim.fn.fnameescape(r.path))
      if r.remote then
        vim.b.iremote = { anchor = anchor, tmp = r.path, server = r.server, remote_path = r.remotePath }
        notify("Editing " .. r.remotePath .. " on " .. r.server .. " — :write saves to the server")
      end
    end)
  end)
end

local function save_remote(buf)
  local info = vim.b[buf].iremote
  call("remoteSave", { path = info.anchor, tmpPath = info.tmp }, function(r)
    if r.saved then
      notify("Saved " .. info.remote_path .. " → " .. r.server, vim.log.levels.INFO, { id = "iremote_transfer" })
    else
      notify("Not saved to the server: " .. info.remote_path .. " changed there", vim.log.levels.WARN)
    end
  end)
end

--- Remote change monitor: asks to reload remote buffers that changed on the server.
local function check_remote_buffers()
  local by_anchor = {}
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    local info = vim.api.nvim_buf_is_loaded(buf) and vim.b[buf].iremote
    if info then
      by_anchor[info.anchor] = by_anchor[info.anchor] or {}
      by_anchor[info.anchor][info.tmp] = buf
    end
  end
  for anchor, bufs in pairs(by_anchor) do
    call("remoteCheck", { path = anchor, tmpPaths = vim.tbl_keys(bufs) }, function(changed)
      for _, tmp in ipairs(changed) do
        local buf = bufs[tmp]
        local info = vim.b[buf].iremote
        vim.ui.select({ "Reload from server", "Keep my version" }, { prompt = info.remote_path .. " changed on " .. info.server }, function(c)
          if c == "Reload from server" then
            call("remoteReload", { path = anchor, tmpPath = tmp }, function()
              vim.schedule(function()
                vim.api.nvim_buf_call(buf, function()
                  vim.cmd("edit!")
                end)
              end)
            end)
          end
        end)
      end
    end)
  end
end

--- Deployment settings dialog (servers, connection, mappings, excluded paths, options).
function M.settings(path)
  require("iremote.settings").open(path)
end

--- File Transfer view (live queue and history).
function M.transfers()
  require("iremote.transfers").open()
end

--- Action menu with every iRemote command.
function M.menu()
  require("iremote.menu").open()
end

--- Opens the Remote Host (neo-tree "iremote" source).
function M.remote_browser(position)
  vim.cmd("Neotree source=iremote position=" .. (position or "float") .. " toggle")
end

--- Sync with Deployed for `paths` (default: the project root of the current file).
function M.sync(paths, server_id)
  require("iremote.sync").open(paths, server_id)
end

--- neo-tree `event_handlers` that propagate file operations made in neo-tree (create / delete / rename / move) to the
--- default server, following the project's automatic-upload options.
function M.neo_tree_event_handlers()
  local function send(method, params)
    if find_project(params.path or params.to or params.from) then
      call(method, params)
    end
  end
  local function moved(args)
    send("fileRenamed", { from = args.source, to = args.destination })
  end
  return {
    { event = "file_added", handler = function(path) send("fileCreated", { path = path }) end },
    { event = "file_deleted", handler = function(path) send("fileDeleted", { path = path }) end },
    { event = "file_renamed", handler = moved },
    { event = "file_moved", handler = moved },
  }
end

---@param paths string[]|string|nil defaults to the current file (or neo-tree node)
---@param server_id string?
function M.upload(paths, server_id)
  paths = type(paths) == "string" and { paths } or paths or { need_path() }
  if not paths[1] then
    return
  end
  call("upload", { paths = paths, serverId = server_id }, function(r)
    report("Uploaded", r)
  end)
end

---@param paths string[]|string|nil
---@param server_id string?
function M.download(paths, server_id)
  paths = type(paths) == "string" and { paths } or paths or { need_path() }
  if not paths[1] then
    return
  end
  call("download", { paths = paths, serverId = server_id }, function(r)
    report("Downloaded", r)
    vim.schedule(function()
      vim.cmd("checktime")
    end)
  end)
end

--- Diffs the local file against the deployed version (PhpStorm: Compare with Deployed Version).
function M.compare(path, server_id)
  path = need_path(path)
  if not path then
    return
  end
  call("fetchRemote", { path = path, serverId = server_id }, function(r)
    if not r.exists then
      notify(r.remotePath .. " does not exist on " .. r.server, vim.log.levels.WARN)
    end
    M.open_diff(path, r.tmpPath, vim.fn.fnamemodify(path, ":t") .. " (" .. r.server .. " ↔ Local)")
  end)
end

function M.open_diff(local_path, remote_tmp, title)
  vim.schedule(function()
    vim.cmd("tabnew " .. vim.fn.fnameescape(local_path))
    vim.cmd("diffthis")
    vim.cmd("vertical leftabove split " .. vim.fn.fnameescape(remote_tmp))
    vim.bo.readonly = true
    vim.bo.modifiable = false
    vim.bo.bufhidden = "wipe"
    vim.cmd("diffthis")
    pcall(vim.api.nvim_tabpage_set_var, 0, "iremote_title", title)
    notify(title .. "  — left: remote (read-only), right: local", vim.log.levels.INFO)
  end)
end

--- Picks the project's default server (PhpStorm: Use as Default).
function M.select_server(path)
  path = path or current_path() or vim.fn.getcwd()
  call("servers", { path = path }, function(r)
    local items = vim.deepcopy(r.servers)
    table.insert(items, { id = vim.NIL, name = "None (disable default server)" })
    vim.ui.select(items, {
      prompt = "iRemote default server",
      format_item = function(s)
        if s.id == vim.NIL then
          return s.name
        end
        local mark = s.id == r.defaultServer and "● " or "  "
        local where = s.host and s.host ~= "" and (" " .. s.host) or ""
        return string.format("%s%s  [%s%s]%s", mark, s.name, s.type, where, s.scope == "global" and " (global)" or "")
      end,
    }, function(choice)
      if not choice then
        return
      end
      call("setDefaultServer", { path = path, serverId = choice.id }, function()
        status_cache = {}
        notify(choice.id == vim.NIL and "No default server" or ("Default server: " .. choice.name))
      end)
    end)
  end)
end

local AUTO_MODES = { "always", "onExplicitSave", "never" }

function M.set_auto_upload(mode, path)
  path = path or current_path() or vim.fn.getcwd()
  local function apply(m)
    call("setAutoUpload", { path = path, mode = m }, function()
      status_cache = {}
      notify("Automatic upload: " .. m)
    end)
  end
  if mode then
    return apply(mode)
  end
  vim.ui.select(AUTO_MODES, { prompt = "Upload changed files automatically" }, function(m)
    if m then
      apply(m)
    end
  end)
end

function M.open_in_browser(path)
  path = need_path(path)
  if not path then
    return
  end
  call("webUrl", { path = path }, function(url)
    if url == vim.NIL or not url then
      return notify("No web URL configured for this file.", vim.log.levels.WARN)
    end
    vim.ui.open(url)
  end)
end

function M.show_log()
  vim.cmd("botright new")
  local buf = vim.api.nvim_get_current_buf()
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "wipe"
  vim.api.nvim_buf_set_name(buf, "iRemote log")
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, #log_lines > 0 and log_lines or { "(empty)" })
  vim.bo[buf].modifiable = false
  vim.keymap.set("n", "q", "<cmd>close<cr>", { buffer = buf })
  vim.cmd("normal! G")
end

function M.reload()
  call("reload", {}, function(problems)
    status_cache = {}
    notify(#problems == 0 and "Configuration reloaded" or ("Configuration problems: " .. table.concat(problems, "; ")))
  end)
end

function M.cancel()
  call("cancel", {}, function()
    notify("Transfers cancelled")
  end)
end

function M.disconnect()
  call("disconnect", {}, function()
    notify("Disconnected")
  end)
end

function M.forget_credentials(path)
  call("forgetCredentials", { path = path or current_path() or vim.fn.getcwd() }, function(name)
    notify("Forgot saved credentials and host keys for " .. name)
  end)
end

--- Short statusline text such as "󰒍 Production ↑" ("↑" = automatic upload on). Cheap: cached per project.
function M.statusline()
  local path = vim.api.nvim_buf_get_name(0)
  if path == "" then
    return ""
  end
  local root = find_project(path)
  if not root then
    return ""
  end
  local s = status_cache[root]
  if s == nil then
    status_cache[root] = false
    call("status", { path = path }, function(r)
      status_cache[root] = r
    end)
    return ""
  end
  if not s or s.server == vim.NIL or not s.server then
    return ""
  end
  return "󰒍 " .. s.server.name .. (s.autoUpload ~= "never" and " ↑" or "")
end

local function on_write(args)
  if vim.b[args.buf].iremote then
    return save_remote(args.buf)
  end
  if not M.config.auto_upload or vim.bo[args.buf].buftype ~= "" then
    return
  end
  local path = vim.fn.fnamemodify(args.file, ":p")
  if not find_project(path) then
    return
  end
  with_server(function()
    rpc.request("fileSaved", { path = path }, function(err, r)
      if err then
        add_log("error", "auto-upload: " .. err)
        return notify("Automatic upload failed: " .. err, vim.log.levels.ERROR)
      end
      if r and r ~= vim.NIL and #r.failed > 0 then
        report("Automatic upload", r)
      end
    end)
  end)
end

---@param opts iremote.Config?
function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", vim.deepcopy(defaults), opts or {})
  local group = vim.api.nvim_create_augroup("iremote", { clear = true })
  vim.api.nvim_create_autocmd("BufWritePost", { group = group, callback = on_write })
  vim.api.nvim_create_autocmd("VimLeavePre", { group = group, callback = rpc.stop })
  if M.config.check_remote_on_focus then
    vim.api.nvim_create_autocmd("FocusGained", {
      group = group,
      callback = function()
        if initialized then
          check_remote_buffers()
        end
      end,
    })
  end
end

M._find_project = find_project
M._server_script = function()
  return server_script
end

return M
