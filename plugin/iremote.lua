if vim.g.loaded_iremote then
  return
end
vim.g.loaded_iremote = true

local subcommands = {
  upload = function(a)
    require("iremote").upload(nil, a[1])
  end,
  download = function(a)
    require("iremote").download(nil, a[1])
  end,
  compare = function(a)
    require("iremote").compare(nil, a[1])
  end,
  server = function()
    require("iremote").select_server()
  end,
  autoupload = function(a)
    require("iremote").set_auto_upload(a[1])
  end,
  browser = function()
    require("iremote").open_in_browser()
  end,
  log = function()
    require("iremote").show_log()
  end,
  reload = function()
    require("iremote").reload()
  end,
  cancel = function()
    require("iremote").cancel()
  end,
  disconnect = function()
    require("iremote").disconnect()
  end,
  forget = function()
    require("iremote").forget_credentials()
  end,
}

vim.api.nvim_create_user_command("IRemote", function(cmd)
  local name = cmd.fargs[1] or "server"
  local fn = subcommands[name]
  if not fn then
    return vim.notify("iRemote: unknown subcommand " .. name, vim.log.levels.ERROR)
  end
  fn(vim.list_slice(cmd.fargs, 2))
end, {
  nargs = "*",
  desc = "iRemote deployment",
  complete = function(arg, line)
    local words = vim.split(line, "%s+")
    if #words <= 2 then
      return vim.tbl_filter(function(s)
        return s:find(arg, 1, true) == 1
      end, vim.tbl_keys(subcommands))
    end
    if words[2] == "autoupload" then
      return { "always", "onExplicitSave", "never" }
    end
    return {}
  end,
})
