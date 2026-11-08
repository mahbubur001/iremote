-- Sync with Deployed: a buffer listing local ↔ server differences with a per-file action (PhpStorm's Sync dialog).
local M = {}

local ns = vim.api.nvim_create_namespace("iremote_sync")

local STATE_LABEL = {
  same = "identical",
  localOnly = "local only",
  remoteOnly = "remote only",
  localNewer = "local newer",
  remoteNewer = "remote newer",
  conflict = "conflict",
}

local ACTION_ICON = {
  upload = "↑ upload",
  download = "↓ download",
  deleteRemote = "✗ del remote",
  deleteLocal = "✗ del local",
  skip = "· skip",
}

local ACTION_HL = {
  upload = "DiagnosticOk",
  download = "DiagnosticInfo",
  deleteRemote = "DiagnosticError",
  deleteLocal = "DiagnosticError",
  skip = "Comment",
}

local HELP = "u upload · d download · R del remote · L del local · s skip · = diff · S synchronize · r refresh · c compare contents · i identical · q close"

local function iremote()
  return require("iremote")
end

local function size(n)
  if not n then
    return "—"
  end
  if n < 1024 then
    return n .. " B"
  end
  return string.format("%.1f KB", n / 1024)
end

local function when(ms)
  return (ms and ms > 0) and os.date("%m-%d %H:%M", math.floor(ms / 1000)) or ""
end

---@class iremote.SyncView
---@field buf integer
---@field token integer?
---@field items table[]
---@field rows table<integer, table> line → item
---@field show_same boolean
---@field paths string[]
---@field server_id string?
---@field server string?
---@field status table<integer, { status: string, error: string? }>

local function render(view)
  local lines = {
    string.format("Sync with %s  —  %s", view.server or "?", table.concat(vim.tbl_map(function(p)
      return vim.fn.fnamemodify(p, ":~")
    end, view.paths), ", ")),
    HELP,
    "",
  }
  view.rows = {}
  local marks = {}
  local shown, hidden = 0, 0
  for _, item in ipairs(view.items) do
    if item.state == "same" and not view.show_same and item.action == "skip" then
      hidden = hidden + 1
    else
      shown = shown + 1
      local st = view.status[item.id]
      local status = st and (st.status == "done" and "✔ " or "✖ " .. (st.error or "")) or ""
      local line = string.format(
        "%-14s %-13s %-50s %9s %-11s │ %9s %-11s %s",
        ACTION_ICON[item.action],
        STATE_LABEL[item.state] or item.state,
        item.rel,
        item["local"] and size(item["local"].size) or "—",
        item["local"] and when(item["local"].mtime) or "",
        item.remote and size(item.remote.size) or "—",
        item.remote and when(item.remote.mtime) or "",
        status
      )
      table.insert(lines, line)
      view.rows[#lines] = item
      table.insert(marks, { #lines - 1, ACTION_HL[item.action], #ACTION_ICON[item.action] })
    end
  end
  if shown == 0 then
    table.insert(lines, "Everything is in sync.")
  end
  if hidden > 0 then
    table.insert(lines, "")
    table.insert(lines, string.format("(%d identical file(s) hidden — press i to show)", hidden))
  end
  vim.bo[view.buf].modifiable = true
  vim.api.nvim_buf_set_lines(view.buf, 0, -1, false, lines)
  vim.bo[view.buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(view.buf, ns, 0, -1)
  vim.api.nvim_buf_set_extmark(view.buf, ns, 0, 0, { end_col = #lines[1], hl_group = "Title" })
  vim.api.nvim_buf_set_extmark(view.buf, ns, 1, 0, { end_col = #lines[2], hl_group = "Comment" })
  for _, m in ipairs(marks) do
    vim.api.nvim_buf_set_extmark(view.buf, ns, m[1], 0, { end_col = m[3], hl_group = m[2] })
  end
end

local function compare(view, contents)
  vim.bo[view.buf].modifiable = true
  vim.api.nvim_buf_set_lines(view.buf, 0, -1, false, { "Comparing with the server…" })
  vim.bo[view.buf].modifiable = false
  if view.token then
    iremote().request("syncClose", { token = view.token })
  end
  iremote().request("syncCompare", { paths = view.paths, serverId = view.server_id, compareContents = contents }, function(r)
    view.token = r.token
    view.items = r.items
    view.server = r.server
    view.server_id = r.serverId
    view.status = {}
    vim.schedule(function()
      if vim.api.nvim_buf_is_valid(view.buf) then
        render(view)
      end
    end)
  end)
end

--- Items on the given (1-based) line range.
local function items_in(view, first, last)
  local out = {}
  for l = first, last do
    if view.rows[l] then
      table.insert(out, view.rows[l])
    end
  end
  return out
end

local function set_action(view, action, first, last)
  for _, item in ipairs(items_in(view, first, last)) do
    if action == "upload" and not item["local"] then
      goto continue
    end
    if action == "download" and not item.remote then
      goto continue
    end
    if action == "deleteRemote" and not item.remote then
      goto continue
    end
    if action == "deleteLocal" and not item["local"] then
      goto continue
    end
    item.action = action
    view.status[item.id] = nil
    ::continue::
  end
  render(view)
end

local function synchronize(view)
  local actions = {}
  for _, item in ipairs(view.items) do
    if item.action ~= "skip" then
      table.insert(actions, { id = item.id, action = item.action })
    end
  end
  if #actions == 0 then
    return vim.notify("Nothing to synchronize.", vim.log.levels.INFO, { title = "iRemote" })
  end
  iremote().request("syncRun", { token = view.token, actions = actions }, function(results)
    if results == vim.NIL or not results then
      return
    end
    local failed = 0
    for _, res in ipairs(results) do
      view.status[res.id] = res
      if res.status == "failed" then
        failed = failed + 1
      end
    end
    vim.schedule(function()
      render(view)
      vim.cmd("checktime")
      vim.notify(
        string.format("Synchronized %d file(s)%s with %s", #results - failed, failed > 0 and (", " .. failed .. " failed") or "", view.server),
        failed > 0 and vim.log.levels.ERROR or vim.log.levels.INFO,
        { title = "iRemote" }
      )
    end)
  end)
end

local function diff(view)
  local item = view.rows[vim.api.nvim_win_get_cursor(0)[1]]
  if not item then
    return
  end
  if not item["local"] then
    return vim.notify("Only on the server; nothing to compare.", vim.log.levels.WARN, { title = "iRemote" })
  end
  iremote().compare(item.localPath, view.server_id)
end

---@param paths string[]|string|nil
---@param server_id string?
function M.open(paths, server_id)
  if type(paths) == "string" then
    paths = { paths }
  end
  if not paths or #paths == 0 then
    local file = vim.api.nvim_buf_get_name(0)
    local root = iremote()._find_project(file ~= "" and file or (vim.fn.getcwd() .. "/x"))
    if not root then
      return vim.notify("No .vscode/iremote.json found for this file.", vim.log.levels.WARN, { title = "iRemote" })
    end
    paths = { root }
  end
  vim.cmd("tabnew")
  local buf = vim.api.nvim_get_current_buf()
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = "iremote-sync"
  pcall(vim.api.nvim_buf_set_name, buf, "iRemote Sync")
  vim.wo.wrap = false
  vim.wo.cursorline = true

  local view = { buf = buf, items = {}, rows = {}, show_same = false, paths = paths, server_id = server_id, status = {} }

  local function map(lhs, fn, mode)
    vim.keymap.set(mode or "n", lhs, fn, { buffer = buf, nowait = true, silent = true })
  end
  local function act(action)
    return function()
      local l = vim.api.nvim_win_get_cursor(0)[1]
      set_action(view, action, l, l)
    end
  end
  local function act_visual(action)
    return function()
      local a, b = vim.fn.line("v"), vim.fn.line(".")
      vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "n", false)
      set_action(view, action, math.min(a, b), math.max(a, b))
    end
  end
  for key, action in pairs({ u = "upload", d = "download", R = "deleteRemote", L = "deleteLocal", s = "skip" }) do
    map(key, act(action))
    map(key, act_visual(action), "x")
  end
  map("=", function()
    diff(view)
  end)
  map("S", function()
    synchronize(view)
  end)
  map("r", function()
    compare(view, false)
  end)
  map("c", function()
    compare(view, true)
  end)
  map("i", function()
    view.show_same = not view.show_same
    render(view)
  end)
  map("q", function()
    vim.cmd("tabclose")
  end)
  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = buf,
    once = true,
    callback = function()
      if view.token then
        iremote().request("syncClose", { token = view.token })
      end
    end,
  })
  compare(view, false)
  return view
end

return M
