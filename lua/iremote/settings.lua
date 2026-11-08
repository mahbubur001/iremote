-- Deployment settings dialog (PhpStorm: Settings → Deployment): servers on the left; Connection / Mappings /
-- Excluded / Options tabs on the right. Edits a draft of .vscode/iremote.json; <C-s> saves it.
local M = {}

local ns = vim.api.nvim_create_namespace("iremote_settings")
local TABS = { "Connection", "Mappings", "Excluded", "Options" }
local TYPES = { "sftp", "ftp", "ftps", "ftps-implicit", "webdav", "local" }

local S -- dialog state (one dialog at a time)

local function iremote()
  return require("iremote")
end

local function notify(msg, level)
  vim.notify(msg, level or vim.log.levels.INFO, { title = "iRemote" })
end

-- Model --------------------------------------------------------------------------------------

--- Servers shown in the list: project servers (editable) then global ones (connection read-only).
local function entries()
  local list = {}
  for _, s in ipairs(S.draft.servers) do
    table.insert(list, { server = s, global = false })
  end
  for _, g in ipairs(S.globals) do
    table.insert(list, { server = g, global = true })
  end
  return list
end

local function current()
  return entries()[S.sel]
end

--- Mappings / excludes live on the server (project) or in globalServerData (global servers).
local function server_data(entry)
  if not entry.global then
    return entry.server
  end
  S.draft.globalServerData = S.draft.globalServerData or {}
  local d = S.draft.globalServerData[entry.server.id]
  if not d then
    d = { mappings = {}, excludedLocal = {}, excludedRemote = {} }
    S.draft.globalServerData[entry.server.id] = d
  end
  return d
end

local function mark_dirty()
  S.dirty = true
end

local function slug(name)
  local id = name:lower():gsub("[^%w._-]+", "-"):gsub("^-+", ""):gsub("-+$", "")
  if id == "" then
    id = "server"
  end
  local taken = {}
  for _, e in ipairs(entries()) do
    taken[e.server.id] = true
  end
  local candidate, i = id, 2
  while taken[candidate] do
    candidate = id .. "-" .. i
    i = i + 1
  end
  return candidate
end

local function new_server(name, type)
  return {
    id = slug(name),
    name = name,
    type = type,
    host = "",
    port = S.default_ports[type] ~= vim.NIL and S.default_ports[type] or nil,
    username = "",
    auth = type == "sftp" and "password" or nil,
    rootPath = "/",
    webUrl = "",
    passive = true,
    mappings = { { ["local"] = "", remote = "/", web = "/" } },
    excludedLocal = {},
    excludedRemote = {},
  }
end

-- Field descriptors ----------------------------------------------------------------------------

local function connection_fields(s)
  local f = {}
  local function add(key, label, kind, extra)
    table.insert(f, vim.tbl_extend("force", { key = key, label = label, kind = kind }, extra or {}))
  end
  add("name", "Name", "text")
  add("type", "Type", "enum", { options = TYPES, labels = S.type_labels })
  if s.type == "local" then
    add("rootPath", "Folder", "path")
  else
    if s.type == "webdav" then
      add("host", "URL", "text")
    else
      add("host", "Host", "text")
      add("port", "Port", "number")
    end
    add("username", "User name", "text")
    if s.type == "sftp" then
      add("auth", "Authentication", "enum", {
        options = { "password", "key", "agent", "openssh" },
        labels = { password = "Password", key = "Key pair", agent = "SSH agent", openssh = "OpenSSH config and agent" },
      })
      if s.auth == "key" then
        add("privateKeyPath", "Private key file", "path")
      end
      if s.auth == "openssh" then
        add("sshConfigHost", "~/.ssh/config host", "text")
      end
      if s.auth == "password" or s.auth == "key" or s.auth == nil then
        add("_secret", s.auth == "key" and "Key passphrase" or "Password", "secret")
      end
      add("jumpHost", "Jump host (user@host:port)", "text")
      add("keepAliveSeconds", "Keep-alive (seconds)", "number")
      add("allowShellCommands", "Allow shell commands (sha1sum)", "bool")
    elseif s.type == "webdav" then
      add("webdavAuth", "Authentication", "enum", { options = { "basic", "digest", "none" } })
      if s.webdavAuth ~= "none" then
        add("_secret", "Password", "secret")
      end
      add("allowUntrustedCertificate", "Accept untrusted certificate", "bool")
    else
      add("_secret", "Password", "secret")
      add("passive", "Passive mode", "bool")
      add("encoding", "File name encoding", "enum", { options = { "utf8", "latin1", "ascii", "utf16le" } })
      if s.type ~= "ftp" then
        add("allowUntrustedCertificate", "Accept untrusted certificate", "bool")
      end
    end
    add("rootPath", "Root path", "text")
    add("maxConnections", "Max connections", "number")
  end
  add("webUrl", "Web server URL", "text")
  return f
end

local OPTION_FIELDS = {
  { key = "autoUpload", label = "Upload changed files automatically", kind = "enum", options = { "always", "onExplicitSave", "never" }, labels = { always = "Always", onExplicitSave = "On explicit save", never = "Never" } },
  { key = "skipExternalChanges", label = "Skip external changes", kind = "bool" },
  { key = "deleteRemoteOnLocalDelete", label = "Delete remote files when local are deleted", kind = "bool" },
  { key = "warnOnNewerRemote", label = "Warn when uploading over newer file", kind = "enum", options = { "none", "timestampAndSize", "content" }, labels = { none = "No", timestampAndSize = "Compare timestamp & size", content = "Compare content" } },
  { key = "createEmptyDirectories", label = "Create empty directories", kind = "bool" },
  { key = "preserveTimestamps", label = "Preserve files timestamps", kind = "bool" },
  { key = "filePermissions", label = "File permissions (octal, empty = default)", kind = "text" },
  { key = "folderPermissions", label = "Folder permissions (octal, empty = default)", kind = "text" },
  { key = "excludeNames", label = "Exclude items by name (comma separated)", kind = "list" },
  { key = "confirmRemoteDelete", label = "Confirm deleting remote files", kind = "bool" },
  { key = "overwriteUpToDate", label = "Overwrite up-to-date files (sync)", kind = "bool" },
  { key = "notifyRemoteChanges", label = "Notify about remote changes", kind = "bool" },
  { key = "concurrency", label = "Parallel transfers", kind = "number" },
}

local function show_value(field, v)
  if field.kind == "bool" then
    return v and "[x]" or "[ ]"
  elseif field.kind == "secret" then
    return "[ Set… ]"
  elseif field.kind == "enum" then
    local label = field.labels and field.labels[v] or v
    return (label ~= nil and tostring(label) or "—") .. "  ▾"
  elseif field.kind == "list" then
    return table.concat(v or {}, ", ")
  end
  if v == nil or v == vim.NIL or v == "" then
    return ""
  end
  return tostring(v)
end

-- Rendering ------------------------------------------------------------------------------------

local function set_lines(buf, lines)
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
end

local function render_list()
  local lines, marks = {}, {}
  for i, e in ipairs(entries()) do
    local default = S.draft.defaultServer == e.server.id
    local line = string.format(" %s %-22s %s%s", default and "●" or " ", e.server.name, e.server.type, e.global and " (global)" or "")
    table.insert(lines, line)
    if default then
      table.insert(marks, { i - 1, "DiagnosticOk" })
    elseif e.global then
      table.insert(marks, { i - 1, "Comment" })
    end
  end
  if #lines == 0 then
    lines = { " (no servers — press a)" }
  end
  set_lines(S.lbuf, lines)
  vim.api.nvim_buf_clear_namespace(S.lbuf, ns, 0, -1)
  for _, m in ipairs(marks) do
    vim.api.nvim_buf_set_extmark(S.lbuf, ns, m[1], 0, { line_hl_group = m[2] })
  end
  local title = " Deployment" .. (S.dirty and " ●" or "") .. " "
  pcall(vim.api.nvim_win_set_config, S.lwin, { title = title, title_pos = "left" })
end

local function render_detail()
  local entry = current()
  local lines, hls = {}, {}
  S.rows = {}
  -- tab bar
  local bar, col = "", 0
  for i, t in ipairs(TABS) do
    local label = string.format(" %d %s ", i, t)
    table.insert(hls, { 0, col, col + #label, i == S.tab and "TabLineSel" or "TabLine" })
    bar = bar .. label
    col = col + #label
  end
  table.insert(lines, bar)
  table.insert(lines, "")

  local function row(text, item, hl)
    table.insert(lines, text)
    if item then
      S.rows[#lines] = item
    end
    if hl then
      table.insert(hls, { #lines - 1, 0, -1, hl })
    end
  end
  local function field_row(field, value, readonly)
    local text = string.format("  %-36s %s", field.label, show_value(field, value))
    row(text, not readonly and { field = field } or nil, readonly and "Comment" or nil)
  end

  if not entry and S.tab ~= 4 then
    row("  Add a server with  a  in the list on the left.", nil, "Comment")
  elseif S.tab == 1 then
    local s = entry.server
    if entry.global then
      row("  Global server: connection settings are edited in VS Code (Deployment Settings).", nil, "DiagnosticInfo")
      row("")
    end
    for _, field in ipairs(connection_fields(s)) do
      if not (entry.global and field.kind == "secret") then
        field_row(field, field.key ~= "_secret" and s[field.key] or nil, entry.global and field.kind ~= "secret")
      end
    end
    row("")
    row("  T  test connection     <CR> edit     <Space> toggle", nil, "Comment")
  elseif S.tab == 2 then
    local d = server_data(entry)
    row(string.format("  %-34s %-28s %s", "Local path (project)", "Deployment path", "Web path"), nil, "Title")
    for i, m in ipairs(d.mappings or {}) do
      local loc = (m["local"] == nil or m["local"] == "") and "(project root)" or m["local"]
      row(string.format("  %-34s %-28s %s", loc, m.remote ~= "" and m.remote or "/", m.web ~= "" and m.web or "/"), { mapping = i })
    end
    if #(d.mappings or {}) == 0 then
      row("  (no mappings — nothing can be deployed)", nil, "DiagnosticWarn")
    end
    row("")
    row("  a add     <CR> edit     d delete", nil, "Comment")
  elseif S.tab == 3 then
    local d = server_data(entry)
    row("  Local excluded paths (project-relative)", nil, "Title")
    for i, p in ipairs(d.excludedLocal or {}) do
      row("    " .. p, { excluded = "excludedLocal", index = i })
    end
    row("")
    row("  Remote excluded paths (absolute)", nil, "Title")
    for i, p in ipairs(d.excludedRemote or {}) do
      row("    " .. p, { excluded = "excludedRemote", index = i })
    end
    row("")
    row("  a add     <CR> edit     d delete", nil, "Comment")
  else
    row("  Project options (all servers)", nil, "Title")
    for _, field in ipairs(OPTION_FIELDS) do
      local text = string.format("  %-44s %s", field.label, show_value(field, S.draft.options[field.key]))
      row(text, { field = field, options = true })
    end
  end

  set_lines(S.rbuf, lines)
  vim.api.nvim_buf_clear_namespace(S.rbuf, ns, 0, -1)
  for _, h in ipairs(hls) do
    local end_col = h[3] == -1 and #lines[h[1] + 1] or h[3]
    vim.api.nvim_buf_set_extmark(S.rbuf, ns, h[1], h[2], { end_col = end_col, hl_group = h[4] })
  end
  local title = entry and string.format(" %s ", entry.server.name) or " "
  pcall(vim.api.nvim_win_set_config, S.rwin, { title = title, title_pos = "left" })
end

local function render()
  if not S or not vim.api.nvim_buf_is_valid(S.lbuf) then
    return
  end
  local n = #entries()
  S.sel = math.max(1, math.min(S.sel, math.max(n, 1)))
  render_list()
  render_detail()
end

-- Editing --------------------------------------------------------------------------------------

local function input(prompt, default, completion, cb)
  vim.ui.input({ prompt = prompt .. ": ", default = default or "", completion = completion }, function(v)
    if v ~= nil then
      vim.schedule(function()
        cb(v)
      end)
    end
  end)
end

local function select(items, prompt, format, cb)
  vim.ui.select(items, { prompt = prompt, format_item = format }, function(choice)
    if choice ~= nil then
      vim.schedule(function()
        cb(choice)
      end)
    end
  end)
end

local function secret_kind(s)
  return (s.type == "sftp" and s.auth == "key") and "passphrase" or "password"
end

local function edit_field(target, field, on_done)
  local v = target[field.key]
  local function set(value)
    target[field.key] = value
    mark_dirty()
    if on_done then
      on_done(value, v)
    end
    render()
  end
  if field.kind == "bool" then
    return set(not v)
  elseif field.kind == "enum" then
    return select(field.options, field.label, function(o)
      return field.labels and field.labels[o] or o
    end, set)
  elseif field.kind == "secret" then
    local s = current().server
    local kind = secret_kind(s)
    vim.schedule(function()
      local ok, value = pcall(vim.fn.inputsecret, (kind == "password" and "Password" or "Key passphrase") .. " for " .. s.name .. ": ")
      if not ok or value == "" then
        return
      end
      iremote().request("setSecret", { serverId = s.id, kind = kind, value = value }, function(where)
        notify(where == "keychain" and ("Saved the " .. kind .. " for " .. s.name .. " in the keychain") or ("Using the " .. kind .. " for this session"))
      end)
    end)
    return
  elseif field.kind == "list" then
    return input(field.label, table.concat(v or {}, ", "), nil, function(text)
      local list = {}
      for item in text:gmatch("[^,]+") do
        item = vim.trim(item)
        if item ~= "" then
          table.insert(list, item)
        end
      end
      set(list)
    end)
  elseif field.kind == "number" then
    return input(field.label, v and tostring(v) or "", nil, function(text)
      text = vim.trim(text)
      if text == "" then
        return set(nil)
      end
      local n = tonumber(text)
      if not n then
        return notify(field.label .. ": not a number", vim.log.levels.WARN)
      end
      set(math.floor(n))
    end)
  end
  input(field.label, v ~= vim.NIL and v or "", field.kind == "path" and "file" or nil, set)
end

local function on_type_change(s, new_type, old_type)
  local old_default = S.default_ports[old_type]
  if s.port == nil or s.port == old_default then
    local d = S.default_ports[new_type]
    s.port = d ~= vim.NIL and d or nil
  end
  if new_type == "sftp" and not s.auth then
    s.auth = "password"
  end
end

local function edit_mapping(d, index)
  local m = index and d.mappings[index] or { ["local"] = "", remote = "/", web = "/" }
  input("Local path (relative to the project, empty = root)", m["local"], "dir", function(loc)
    input("Deployment path (relative to the server root path)", m.remote, nil, function(remote)
      input("Web path", m.web, nil, function(web)
        local new = { ["local"] = vim.trim(loc), remote = vim.trim(remote), web = vim.trim(web) }
        if index then
          d.mappings[index] = new
        else
          d.mappings = d.mappings or {}
          table.insert(d.mappings, new)
        end
        mark_dirty()
        render()
      end)
    end)
  end)
end

local function action_edit()
  local item = S.rows[vim.api.nvim_win_get_cursor(S.rwin)[1]]
  if not item then
    return
  end
  local entry = current()
  if item.field then
    if item.options then
      return edit_field(S.draft.options, item.field)
    end
    if entry.global then
      return
    end
    local on_done = item.field.key == "type" and function(new, old)
      on_type_change(entry.server, new, old)
    end or nil
    return edit_field(entry.server, item.field, on_done)
  elseif item.mapping then
    return edit_mapping(server_data(entry), item.mapping)
  elseif item.excluded then
    local list = server_data(entry)[item.excluded]
    input("Excluded path", list[item.index], item.excluded == "excludedLocal" and "file" or nil, function(v)
      list[item.index] = vim.trim(v)
      mark_dirty()
      render()
    end)
  end
end

local function action_toggle()
  local item = S.rows[vim.api.nvim_win_get_cursor(S.rwin)[1]]
  if item and item.field and item.field.kind == "bool" then
    action_edit()
  end
end

local function action_add()
  local entry = current()
  if not entry then
    return
  end
  if S.tab == 2 then
    return edit_mapping(server_data(entry), nil)
  elseif S.tab == 3 then
    select({ "Local path", "Remote path" }, "Exclude", nil, function(which)
      local key = which == "Local path" and "excludedLocal" or "excludedRemote"
      input(which .. " to exclude", "", key == "excludedLocal" and "file" or nil, function(v)
        local d = server_data(entry)
        d[key] = d[key] or {}
        table.insert(d[key], vim.trim(v))
        mark_dirty()
        render()
      end)
    end)
  end
end

local function action_delete_row()
  local item = S.rows[vim.api.nvim_win_get_cursor(S.rwin)[1]]
  local entry = current()
  if not item or not entry then
    return
  end
  if item.mapping then
    table.remove(server_data(entry).mappings, item.mapping)
  elseif item.excluded then
    table.remove(server_data(entry)[item.excluded], item.index)
  else
    return
  end
  mark_dirty()
  render()
end

local function add_server()
  input("Server name", "", nil, function(name)
    name = vim.trim(name)
    if name == "" then
      return
    end
    select(TYPES, "Type", function(t)
      return S.type_labels[t] or t
    end, function(type)
      table.insert(S.draft.servers, new_server(name, type))
      if not S.draft.defaultServer then
        S.draft.defaultServer = S.draft.servers[#S.draft.servers].id
      end
      S.sel = #S.draft.servers
      S.tab = 1
      mark_dirty()
      render()
      vim.api.nvim_win_set_cursor(S.lwin, { S.sel, 0 })
    end)
  end)
end

local function clone_server()
  local entry = current()
  if not entry or entry.global then
    return
  end
  local copy = vim.deepcopy(entry.server)
  copy.name = copy.name .. " (copy)"
  copy.id = slug(copy.name)
  table.insert(S.draft.servers, S.sel + 1, copy)
  S.sel = S.sel + 1
  mark_dirty()
  render()
end

local function delete_server()
  local entry = current()
  if not entry or entry.global then
    return notify("Global servers are removed in VS Code.", vim.log.levels.WARN)
  end
  select({ "Delete", "Cancel" }, "Delete server " .. entry.server.name .. "?", nil, function(c)
    if c ~= "Delete" then
      return
    end
    table.remove(S.draft.servers, S.sel)
    if S.draft.defaultServer == entry.server.id then
      S.draft.defaultServer = nil
    end
    mark_dirty()
    render()
  end)
end

local function toggle_default()
  local entry = current()
  if not entry then
    return
  end
  S.draft.defaultServer = S.draft.defaultServer ~= entry.server.id and entry.server.id or nil
  mark_dirty()
  render()
end

local function test_connection()
  local entry = current()
  if not entry then
    return
  end
  local server = vim.tbl_extend("force", vim.deepcopy(entry.server), entry.global and server_data(entry) or {})
  notify("Testing " .. server.name .. "…")
  iremote().request("testConnection", { server = server }, function(r)
    notify(r.message, r.ok and vim.log.levels.INFO or vim.log.levels.ERROR)
  end)
end

local function save(after)
  local config = vim.deepcopy(S.draft)
  config.version = 1
  iremote().request("configSave", { root = S.root, config = config }, function(r)
    if not r.saved then
      return notify("Not saved:\n" .. table.concat(r.errors, "\n"), vim.log.levels.ERROR)
    end
    S.dirty = false
    notify("Saved " .. vim.fn.fnamemodify(r.configPath, ":~"))
    render()
    if after then
      after()
    end
  end)
end

local function close(force)
  if not S then
    return
  end
  local function really()
    local st = S
    S = nil
    for _, w in ipairs({ st.lwin, st.rwin }) do
      if vim.api.nvim_win_is_valid(w) then
        pcall(vim.api.nvim_win_close, w, true)
      end
    end
  end
  if force or not S.dirty then
    return really()
  end
  select({ "Save", "Discard changes", "Cancel" }, "Unsaved deployment settings", nil, function(c)
    if c == "Save" then
      save(really)
    elseif c == "Discard changes" then
      really()
    end
  end)
end

-- Window setup ---------------------------------------------------------------------------------

local function scratch(name)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].filetype = "iremote-settings"
  pcall(vim.api.nvim_buf_set_name, buf, name)
  return buf
end

local function map(buf, lhs, fn)
  vim.keymap.set("n", lhs, fn, { buffer = buf, nowait = true, silent = true })
end

local function layout()
  local cols, lines = vim.o.columns, vim.o.lines
  local width = math.min(130, math.floor(cols * 0.9))
  local height = math.min(32, math.floor(lines * 0.8))
  local row = math.floor((lines - height) / 2) - 1
  local col = math.floor((cols - width) / 2)
  local left_w = math.max(30, math.floor(width * 0.28))
  return {
    left = { relative = "editor", row = row, col = col, width = left_w, height = height, border = "rounded", style = "minimal" },
    right = { relative = "editor", row = row, col = col + left_w + 2, width = width - left_w - 2, height = height, border = "rounded", style = "minimal" },
  }
end

local FOOTER = " a add · c clone · d delete · * default · T test · <Tab> pane · 1-4 tabs · <C-s> save · q close "

function M.open(path)
  if S then
    return vim.api.nvim_set_current_win(S.lwin)
  end
  path = path or vim.api.nvim_buf_get_name(0)
  if path == "" or vim.bo.buftype ~= "" then
    path = vim.fn.getcwd()
  end
  iremote().request("configGet", { path = path }, function(r)
    vim.schedule(function()
      S = {
        root = r.root,
        draft = vim.deepcopy(r.config),
        globals = r.globalServers or {},
        type_labels = r.typeLabels or {},
        default_ports = r.defaultPorts or {},
        sel = 1,
        tab = 1,
        rows = {},
        dirty = false,
      }
      S.draft.servers = S.draft.servers or {}
      S.draft.options = S.draft.options or r.defaultOptions
      for i, e in ipairs(entries()) do
        if e.server.id == S.draft.defaultServer then
          S.sel = i
        end
      end
      S.lbuf = scratch("iRemote Deployment")
      S.rbuf = scratch("iRemote Deployment details")
      local l = layout()
      S.rwin = vim.api.nvim_open_win(S.rbuf, false, vim.tbl_extend("force", l.right, { footer = FOOTER, footer_pos = "right" }))
      S.lwin = vim.api.nvim_open_win(S.lbuf, true, vim.tbl_extend("force", l.left, { title = " Deployment ", footer = " " .. vim.fn.fnamemodify(r.root, ":~") .. " ", footer_pos = "left" }))
      for _, w in ipairs({ S.lwin, S.rwin }) do
        vim.wo[w].cursorline = true
        vim.wo[w].wrap = false
      end

      local function focus_right()
        vim.api.nvim_set_current_win(S.rwin)
        local first = vim.tbl_keys(S.rows)
        table.sort(first)
        if first[1] then
          pcall(vim.api.nvim_win_set_cursor, S.rwin, { first[1], 2 })
        end
      end
      local function focus_left()
        vim.api.nvim_set_current_win(S.lwin)
      end
      local function set_tab(t)
        return function()
          S.tab = t
          render()
          if vim.api.nvim_get_current_win() == S.rwin then
            focus_right()
          end
        end
      end

      for _, buf in ipairs({ S.lbuf, S.rbuf }) do
        map(buf, "q", function()
          close(false)
        end)
        map(buf, "<Esc>", function()
          close(false)
        end)
        map(buf, "<C-s>", function()
          save()
        end)
        map(buf, "T", test_connection)
        for i = 1, #TABS do
          map(buf, tostring(i), set_tab(i))
        end
      end
      -- list pane
      map(S.lbuf, "a", add_server)
      map(S.lbuf, "c", clone_server)
      map(S.lbuf, "d", delete_server)
      map(S.lbuf, "*", toggle_default)
      map(S.lbuf, "<CR>", focus_right)
      map(S.lbuf, "l", focus_right)
      map(S.lbuf, "<Tab>", focus_right)
      vim.api.nvim_create_autocmd("CursorMoved", {
        buffer = S.lbuf,
        callback = function()
          if S and S.sel ~= vim.api.nvim_win_get_cursor(S.lwin)[1] then
            S.sel = vim.api.nvim_win_get_cursor(S.lwin)[1]
            render_detail()
          end
        end,
      })
      -- detail pane
      map(S.rbuf, "<CR>", action_edit)
      map(S.rbuf, "e", action_edit)
      map(S.rbuf, "<Space>", action_toggle)
      map(S.rbuf, "a", action_add)
      map(S.rbuf, "d", action_delete_row)
      map(S.rbuf, "<Tab>", function()
        S.tab = S.tab % #TABS + 1
        render()
        focus_right()
      end)
      map(S.rbuf, "<S-Tab>", function()
        S.tab = (S.tab - 2) % #TABS + 1
        render()
        focus_right()
      end)
      map(S.rbuf, "h", focus_left)
      map(S.rbuf, "<C-h>", focus_left)
      -- closing either window closes the dialog
      for _, w in ipairs({ S.lwin, S.rwin }) do
        vim.api.nvim_create_autocmd("WinClosed", {
          pattern = tostring(w),
          once = true,
          callback = function()
            vim.schedule(function()
              if S then
                close(true)
              end
            end)
          end,
        })
      end
      render()
      pcall(vim.api.nvim_win_set_cursor, S.lwin, { S.sel, 0 })
    end)
  end)
end

--- For tests: the dialog state.
function M._state()
  return S
end

return M
