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
  settings = function()
    require("iremote").settings()
  end,
  menu = function()
    require("iremote").menu()
  end,
  remote = function(a)
    require("iremote").remote_browser(a[1])
  end,
  sync = function(a)
    require("iremote").sync(#a > 0 and vim.tbl_map(function(p)
      return vim.fn.fnamemodify(vim.fn.expand(p), ":p"):gsub("/$", "")
    end, a) or nil)
  end,
  import = function(a)
    require("iremote").import_phpstorm(a[1] and vim.fn.fnamemodify(a[1], ":p") or nil)
  end,
  transfers = function()
    require("iremote").transfers()
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
  local name = cmd.fargs[1] or "menu"
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
    if words[2] == "remote" then
      return { "float", "left", "right", "current" }
    end
    if words[2] == "sync" or words[2] == "import" then
      return vim.fn.getcompletion(arg, "file")
    end
    return {}
  end,
})
