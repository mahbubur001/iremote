-- Components for the neo-tree "iremote" source; everything else comes from neo-tree's common components.
local common = require("neo-tree.sources.common.components")

local M = {}

local function human(size)
  if not size then
    return ""
  end
  local units = { "B", "KB", "MB", "GB" }
  local i = 1
  while size >= 1024 and i < #units do
    size = size / 1024
    i = i + 1
  end
  return i == 1 and string.format("%d %s", size, units[i]) or string.format("%.1f %s", size, units[i])
end

--- "12.3 KB  2026-11-08 14:02  644" — size for files, modified time and permissions when the server reports them.
M.remote_meta = function(config, node, state)
  local e = node.extra or {}
  if e.is_root then
    return {}
  end
  local parts = {}
  if node.type == "file" then
    table.insert(parts, human(e.size))
  end
  if type(e.mtime) == "number" and e.mtime > 0 then
    table.insert(parts, os.date("%Y-%m-%d %H:%M", math.floor(e.mtime / 1000)))
  end
  if type(e.mode) == "number" then
    table.insert(parts, string.format("%o", e.mode % 512))
  end
  return { text = " " .. table.concat(parts, "  ") .. " ", highlight = e.excluded and "NeoTreeDimText" or "NeoTreeFileStats" }
end

return vim.tbl_deep_extend("force", common, M)
