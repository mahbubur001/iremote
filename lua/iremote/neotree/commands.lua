-- Commands for the neo-tree "iremote" source (Remote Host).
local cc = require("neo-tree.sources.common.commands")
local manager = require("neo-tree.sources.manager")
local source = require("iremote.neotree")

local M = {}

local function iremote()
  return require("iremote")
end

local function call(method, params, cb)
  iremote().request(method, params, cb)
end

local function parent_dir(node)
  if node.type == "directory" then
    return node.path
  end
  return vim.fs.dirname(node.path)
end

--- Re-lists the folder that contains (or is) `path`, keeping expanded folders.
local function refresh(state)
  manager.refresh(source.name)
end

M.refresh = function(state)
  refresh(state)
end

M.toggle_node = function(state)
  local node = state.tree:get_node()
  if node.type == "directory" and not node.loaded then
    return source.load_children(state, node)
  end
  cc.toggle_node(state)
end

local function open_with(state, cmd)
  local node = state.tree:get_node()
  if node.type == "directory" then
    return M.toggle_node(state)
  end
  iremote().open_remote(source.anchor(state), state.iremote_server, node.path, cmd, iremote().config.open_local_if_mapped)
end

M.open = function(state)
  open_with(state, "edit")
end
M.open_split = function(state)
  open_with(state, "split")
end
M.open_vsplit = function(state)
  open_with(state, "vsplit")
end
M.open_tabnew = function(state)
  open_with(state, "tabnew")
end

--- Opens the remote file itself even when a mapped local copy exists.
M.open_local = function(state)
  local node = state.tree:get_node()
  if node.type == "file" then
    iremote().open_remote(source.anchor(state), state.iremote_server, node.path, "edit", true)
  end
end

M.close_node = cc.close_node
M.close_all_nodes = cc.close_all_nodes

M.add = function(state)
  local node = state.tree:get_node()
  local dir = parent_dir(node)
  vim.ui.input({ prompt = "New file (end with / for a folder) in " .. dir .. ": " }, function(name)
    if not name or name == "" then
      return
    end
    local target = dir:gsub("/$", "") .. "/" .. name
    local is_dir = name:sub(-1) == "/"
    call(is_dir and "remoteMkdir" or "remoteNewFile", { path = source.anchor(state), serverId = state.iremote_server, remotePath = is_dir and target:sub(1, -2) or target }, function()
      refresh(state)
      if not is_dir then
        iremote().open_remote(source.anchor(state), state.iremote_server, target, "edit", false)
      end
    end)
  end)
end

M.add_directory = function(state)
  local dir = parent_dir(state.tree:get_node())
  vim.ui.input({ prompt = "New folder in " .. dir .. ": " }, function(name)
    if not name or name == "" then
      return
    end
    call("remoteMkdir", { path = source.anchor(state), serverId = state.iremote_server, remotePath = dir:gsub("/$", "") .. "/" .. name }, function()
      refresh(state)
    end)
  end)
end

M.delete = function(state)
  local node = state.tree:get_node()
  if node.extra and node.extra.is_root then
    return
  end
  vim.ui.select({ "Delete", "Cancel" }, { prompt = "Delete " .. node.path .. " on the server?" }, function(choice)
    if choice ~= "Delete" then
      return
    end
    call("remoteDelete", { path = source.anchor(state), serverId = state.iremote_server, remotePaths = { { path = node.path, isDir = node.type == "directory" } } }, function()
      refresh(state)
    end)
  end)
end

--- Rename or move: edit the full remote path.
M.rename = function(state)
  local node = state.tree:get_node()
  if node.extra and node.extra.is_root then
    return
  end
  vim.ui.input({ prompt = "Rename / move to: ", default = node.path }, function(to)
    if not to or to == "" or to == node.path then
      return
    end
    call("remoteRename", { path = source.anchor(state), serverId = state.iremote_server, from = node.path, to = to }, function()
      refresh(state)
    end)
  end)
end
M.move = M.rename

M.download = function(state)
  local node = state.tree:get_node()
  call("remoteDownload", { path = source.anchor(state), serverId = state.iremote_server, remotePaths = { node.path } }, function(r)
    iremote().report("Downloaded", r)
    vim.schedule(function()
      vim.cmd("checktime")
    end)
  end)
end

--- Upload local files/folders into this remote folder (paths separated by spaces; <Tab> completes).
M.upload_here = function(state)
  local dir = parent_dir(state.tree:get_node())
  vim.ui.input({ prompt = "Upload to " .. dir .. " (local paths): ", default = vim.fn.getcwd() .. "/", completion = "file" }, function(input)
    if not input or vim.trim(input) == "" then
      return
    end
    local paths = vim.tbl_map(function(p)
      return vim.fn.fnamemodify(vim.fn.expand(p), ":p"):gsub("/$", "")
    end, vim.split(vim.trim(input), "%s+"))
    call("remoteUploadHere", { path = source.anchor(state), serverId = state.iremote_server, localPaths = paths, remoteDir = dir }, function(r)
      iremote().report("Uploaded", r)
      refresh(state)
    end)
  end)
end

--- Diff the remote file with its mapped local copy.
M.compare = function(state)
  local node = state.tree:get_node()
  local local_path = node.extra and node.extra["local"]
  if node.type ~= "file" or not local_path or local_path == vim.NIL then
    return vim.notify("No mapped local file for " .. node.path, vim.log.levels.WARN, { title = "iRemote" })
  end
  iremote().compare(local_path, state.iremote_server)
end

M.chmod = function(state)
  local node = state.tree:get_node()
  local current = node.extra and node.extra.mode
  local default = (type(current) == "number") and string.format("%o", current % 4096) or ""
  vim.ui.input({ prompt = "Permissions (octal) for " .. node.path .. ": ", default = default }, function(mode)
    if not mode or mode == "" then
      return
    end
    local function apply(recursive)
      call("remoteChmod", { path = source.anchor(state), serverId = state.iremote_server, remotePaths = { node.path }, mode = mode, recursive = recursive }, function()
        refresh(state)
      end)
    end
    if node.type == "directory" then
      vim.ui.select({ "This folder only", "Folder and contents" }, { prompt = "Apply to" }, function(c)
        if c then
          apply(c == "Folder and contents")
        end
      end)
    else
      apply(false)
    end
  end)
end

M.open_in_browser = function(state)
  local node = state.tree:get_node()
  call("remoteWebUrl", { path = source.anchor(state), serverId = state.iremote_server, remotePath = node.path }, function(url)
    if not url or url == vim.NIL then
      return vim.notify("No web URL for " .. node.path, vim.log.levels.WARN, { title = "iRemote" })
    end
    vim.ui.open(url)
  end)
end

M.copy_path = function(state)
  local node = state.tree:get_node()
  vim.fn.setreg("+", node.path)
  vim.notify("Copied: " .. node.path, vim.log.levels.INFO, { title = "iRemote" })
end

M.navigate_up = function(state)
  local up = vim.fs.dirname(state.path or "/")
  if up and up ~= state.path then
    state.iremote_dir = up
    refresh(state)
  end
end

M.set_root = function(state)
  local node = state.tree:get_node()
  if node.type == "directory" then
    state.iremote_dir = node.path
    refresh(state)
  end
end

M.switch_server = function(state)
  call("servers", { path = source.anchor(state) }, function(r)
    vim.ui.select(r.servers, {
      prompt = "Remote Host server",
      format_item = function(s)
        return string.format("%s  [%s %s]", s.name, s.type, s.host or "")
      end,
    }, function(s)
      if s then
        state.iremote_server = s.id
        state.iremote_dir = nil
        refresh(state)
      end
    end)
  end)
end

M.show_debug_info = function(state)
  print(vim.inspect(state.iremote_server), state.path)
end

-- Clipboard / trash / undo work on local files only; keep neo-tree's global mappings valid but explain.
for _, name in ipairs({ "copy_to_clipboard", "cut_to_clipboard", "paste_from_clipboard", "clear_clipboard", "trash", "undo" }) do
  M[name] = function()
    vim.notify(name .. " is not available in the Remote Host; use D (download), U (upload here), r (rename/move).", vim.log.levels.INFO, { title = "iRemote" })
  end
end

-- Only generic tree/window commands: the filesystem ones (paste, cut, ...) assume local paths.
cc._add_common_commands(M, "node")
cc._add_common_commands(M, "select")
cc._add_common_commands(M, "preview")
cc._add_common_commands(M, "^quick_jump$")
cc._add_common_commands(M, "^toggle_auto_expand_width$")
cc._add_common_commands(M, "^open_with_window_picker$")
cc._add_common_commands(M, "^close_window$")
cc._add_common_commands(M, "^next_source$")
cc._add_common_commands(M, "^prev_source$")
cc._add_common_commands(M, "^show_help$")
cc._add_common_commands(M, "^cancel$")

return M
