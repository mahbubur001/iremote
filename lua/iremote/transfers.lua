-- File Transfer view: live list of queued / running / finished transfers (PhpStorm & VS Code: File Transfer).
local M = {}

local MAX = 500
local tasks = {} ---@type table<integer, table>
local order = {} ---@type integer[] newest first
local view ---@type { buf: integer, scheduled: boolean }?
local ns = vim.api.nvim_create_namespace("iremote_transfers")

local ICON = { queued = "…", running = "⇅", done = "✔", failed = "✖", cancelled = "⊘" }
local HL = { queued = "Comment", running = "DiagnosticInfo", done = "DiagnosticOk", failed = "DiagnosticError", cancelled = "Comment" }

local function size(n)
  if not n or n <= 0 then
    return ""
  end
  if n < 1024 then
    return n .. " B"
  elseif n < 1024 * 1024 then
    return string.format("%.1f KB", n / 1024)
  end
  return string.format("%.1f MB", n / 1048576)
end

local function render()
  if not view or not vim.api.nvim_buf_is_valid(view.buf) then
    view = nil
    return
  end
  view.scheduled = false
  local lines = { "File Transfer — x cancel all · c clear finished · q close", "" }
  local marks = {}
  for _, id in ipairs(order) do
    local t = tasks[id]
    local progress = ""
    if t.status == "running" and t.total and t.total > 0 then
      progress = string.format("%3d%%  %s / %s", math.floor(t.bytes * 100 / t.total), size(t.bytes), size(t.total))
    elseif t.status == "done" then
      progress = size(t.total)
    elseif t.error and t.error ~= vim.NIL then
      progress = t.error
    end
    local when = t.finishedAt and t.finishedAt ~= vim.NIL and os.date("%H:%M:%S", math.floor(t.finishedAt / 1000)) or ""
    local file = t.kind == "download" and t.target or t.source
    table.insert(lines, string.format(" %s %-8s %-9s %-14s %s  %s", ICON[t.status] or "?", when, t.kind, t.server, vim.fn.fnamemodify(file, ":~:."), progress))
    table.insert(marks, { #lines - 1, HL[t.status] or "Normal" })
  end
  if #order == 0 then
    table.insert(lines, " (no transfers yet)")
  end
  vim.bo[view.buf].modifiable = true
  vim.api.nvim_buf_set_lines(view.buf, 0, -1, false, lines)
  vim.bo[view.buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(view.buf, ns, 0, -1)
  vim.api.nvim_buf_set_extmark(view.buf, ns, 0, 0, { end_col = #lines[1], hl_group = "Title" })
  for _, m in ipairs(marks) do
    vim.api.nvim_buf_set_extmark(view.buf, ns, m[1], 0, { end_col = 2, hl_group = m[2] })
  end
end

local function schedule_render()
  if view and not view.scheduled then
    view.scheduled = true
    vim.defer_fn(render, 100)
  end
end

--- Called for every `transfer` notification from the server.
function M.record(t)
  if not t.id or t.id == vim.NIL then
    return
  end
  if not tasks[t.id] then
    table.insert(order, 1, t.id)
    if #order > MAX then
      tasks[table.remove(order)] = nil
    end
  end
  tasks[t.id] = t
  schedule_render()
end

function M.clear_finished()
  local keep = {}
  for _, id in ipairs(order) do
    local s = tasks[id].status
    if s == "queued" or s == "running" then
      table.insert(keep, id)
    else
      tasks[id] = nil
    end
  end
  order = keep
  render()
end

function M.open()
  if view and vim.api.nvim_buf_is_valid(view.buf) then
    local win = vim.fn.bufwinid(view.buf)
    if win ~= -1 then
      return vim.api.nvim_set_current_win(win)
    end
  end
  vim.cmd("botright 12new")
  local buf = vim.api.nvim_get_current_buf()
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = "iremote-transfers"
  pcall(vim.api.nvim_buf_set_name, buf, "iRemote File Transfer")
  vim.wo.wrap = false
  view = { buf = buf, scheduled = false }
  local function map(lhs, fn)
    vim.keymap.set("n", lhs, fn, { buffer = buf, nowait = true, silent = true })
  end
  map("q", "<cmd>close<cr>")
  map("c", M.clear_finished)
  map("x", function()
    require("iremote").cancel()
  end)
  render()
end

--- For tests.
function M._tasks()
  return tasks, order
end

return M
