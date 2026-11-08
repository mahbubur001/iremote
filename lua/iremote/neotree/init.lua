-- neo-tree source "iremote": PhpStorm's Remote Host tool window. Add "iremote.neotree" to neo-tree's `sources`.
local renderer = require("neo-tree.ui.renderer")
local manager = require("neo-tree.sources.manager")

local M = {
  name = "iremote",
  display_name = " 󰒍 Remote ",
}

--- Path used to find the project (.vscode/iremote.json): the last real file, else the cwd.
function M.anchor(state)
  if state.iremote_anchor then
    return state.iremote_anchor
  end
  local ok, utils = pcall(require, "neo-tree.utils")
  if ok then
    local win = utils.get_appropriate_window(state)
    local buf = vim.api.nvim_win_get_buf(win)
    local name = vim.api.nvim_buf_get_name(buf)
    if name ~= "" and vim.bo[buf].buftype == "" and not vim.b[buf].iremote then
      return name
    end
  end
  return vim.fn.getcwd()
end

--- neo-tree items for a remote listing.
function M.to_items(entries)
  local items = {}
  for _, e in ipairs(entries) do
    table.insert(items, {
      id = e.path,
      name = e.name,
      type = e.type,
      path = e.path,
      loaded = e.type ~= "directory",
      children = e.type == "directory" and {} or nil,
      extra = { size = e.size, mtime = e.mtime, mode = e.mode, link = e.link, excluded = e.excluded, ["local"] = e["local"] },
    })
  end
  return items
end

local function call(method, params, cb)
  require("iremote").request(method, params, cb)
end

--- Loads a directory's children into the tree and expands it.
function M.load_children(state, node, callback)
  call("remoteList", { path = M.anchor(state), serverId = state.iremote_server, remotePath = node.path }, function(entries)
    renderer.show_nodes(M.to_items(entries), state, node:get_id(), function()
      local n = state.tree:get_node(node:get_id())
      if n then
        n.loaded = true
        n:expand()
        renderer.redraw(state)
      end
      if callback then
        callback()
      end
    end)
  end)
end

M.navigate = function(state, path, path_to_reveal, callback, async)
  state.iremote_anchor = state.iremote_anchor or M.anchor(state)
  call("remoteRoot", { path = state.iremote_anchor, serverId = state.iremote_server }, function(root)
    state.iremote_server = root.serverId
    local dir = state.iremote_dir or root.root
    state.path = dir
    call("remoteList", { path = state.iremote_anchor, serverId = root.serverId, remotePath = dir }, function(entries)
      local label = string.format("%s  %s:%s%s", root.name, root.type, dir, root.isDefault and "  (default)" or "")
      local items = {
        {
          id = dir,
          name = label,
          type = "directory",
          path = dir,
          loaded = true,
          children = M.to_items(entries),
          extra = { is_root = true },
        },
      }
      renderer.show_nodes(items, state, nil, callback)
    end)
  end)
end

M.setup = function(config, global_config)
  -- Re-list when the project's servers change (default server switched, config edited).
  vim.api.nvim_create_autocmd("User", {
    pattern = "IRemoteConfigChanged",
    group = vim.api.nvim_create_augroup("iremote_neotree", { clear = true }),
    callback = function()
      manager.refresh(M.name)
    end,
  })
end

M.default_config = {
  renderers = {
    directory = {
      { "indent" },
      { "icon" },
      {
        "container",
        content = {
          { "name", zindex = 10 },
          { "remote_meta", zindex = 10, align = "right" },
        },
      },
    },
    file = {
      { "indent" },
      { "icon" },
      {
        "container",
        content = {
          { "name", zindex = 10 },
          { "remote_meta", zindex = 10, align = "right" },
        },
      },
    },
  },
  window = {
    mappings = {
      ["<cr>"] = "open",
      ["l"] = "open",
      ["h"] = "close_node",
      ["s"] = "open_vsplit",
      ["S"] = "open_split",
      ["t"] = "open_tabnew",
      ["R"] = "refresh",
      ["a"] = "add",
      ["A"] = "add_directory",
      ["d"] = "delete",
      ["r"] = "rename",
      ["D"] = "download",
      ["U"] = "upload_here",
      ["="] = "compare",
      ["c"] = "chmod",
      ["gx"] = "open_in_browser",
      ["Y"] = "copy_path",
      ["<bs>"] = "navigate_up",
      ["."] = "set_root",
      ["sv"] = "switch_server",
      ["L"] = "open_local",
    },
  },
}

return M
