-- One-key action menu for iRemote (all deployment actions in a picker, with the current server in the title).
local M = {}

local ACTIONS = {
  { "Upload current file", "upload" },
  { "Download current file", "download" },
  { "Compare with deployed version", "compare" },
  { "Remote Host", "remote_browser" },
  { "Sync with deployed", "sync" },
  { "Select default server", "select_server" },
  { "Automatic upload mode", "set_auto_upload" },
  { "Deployment settings…", "settings" },
  { "Open in browser", "open_in_browser" },
  { "File transfers", "transfers" },
  { "Transfer log", "show_log" },
  { "Cancel transfers", "cancel" },
  { "Disconnect", "disconnect" },
  { "Forget saved password / host key", "forget_credentials" },
}

function M.open()
  local ir = require("iremote")
  local function show(title)
    vim.ui.select(ACTIONS, {
      prompt = title,
      format_item = function(a)
        return a[1]
      end,
    }, function(choice)
      if choice then
        vim.schedule(function()
          ir[choice[2]]()
        end)
      end
    end)
  end
  local file = vim.api.nvim_buf_get_name(0)
  local path = (file ~= "" and vim.bo.buftype == "") and file or (vim.fn.getcwd() .. "/.")
  if not ir._find_project(path) then
    return show("iRemote · no .vscode/iremote.json here")
  end
  ir.request("status", { path = path }, function(s)
    local server = (s.server and s.server ~= vim.NIL) and (s.server.name .. " (" .. s.server.type .. ")") or "no default server"
    local mode = ({ always = "always", onExplicitSave = "on save", never = "off" })[s.autoUpload] or "?"
    vim.schedule(function()
      show(string.format("iRemote · %s · auto-upload: %s", server, mode))
    end)
  end)
end

return M
