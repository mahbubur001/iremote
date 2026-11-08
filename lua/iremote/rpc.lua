-- Newline-delimited JSON-RPC over the stdio of the Node server (dist/nvim/iremote.js).
-- Both sides send requests: we call server methods; the server calls back for prompts, confirms and diffs.
local M = {}

local job ---@type integer?
local next_id = 1
local pending = {} ---@type table<integer, fun(err: string?, result: any)>
local handlers = {} ---@type table<string, fun(params: table, reply: fun(result: any))>
local notification_handlers = {} ---@type table<string, fun(params: table)>
local partial = ""

local function send(msg)
  if not job then
    return
  end
  msg.jsonrpc = "2.0"
  vim.fn.chansend(job, vim.json.encode(msg) .. "\n")
end

local function dispatch(line)
  local ok, msg = pcall(vim.json.decode, line, { luanil = { object = true, array = true } })
  if not ok or type(msg) ~= "table" then
    return
  end
  if msg.method and msg.id then
    local handler = handlers[msg.method]
    local reply = function(result)
      send({ id = msg.id, result = result == nil and vim.NIL or result })
    end
    if handler then
      handler(msg.params or {}, reply)
    else
      send({ id = msg.id, error = { code = -32601, message = "Unknown method " .. msg.method } })
    end
  elseif msg.method then
    local handler = notification_handlers[msg.method]
    if handler then
      handler(msg.params or {})
    end
  elseif msg.id then
    local cb = pending[msg.id]
    pending[msg.id] = nil
    if cb then
      cb(msg.error and msg.error.message or nil, msg.result)
    end
  end
end

local function on_stdout(_, data)
  -- jobstart splits on newlines; the first item continues the previous chunk's last line.
  data[1] = partial .. data[1]
  partial = table.remove(data)
  for _, line in ipairs(data) do
    if line ~= "" then
      vim.schedule(function()
        dispatch(line)
      end)
    end
  end
end

---@param opts { cmd: string[], on_exit?: fun(code: integer), on_stderr?: fun(lines: string[]) }
function M.start(opts)
  if job then
    return true
  end
  partial = ""
  job = vim.fn.jobstart(opts.cmd, {
    on_stdout = on_stdout,
    on_stderr = function(_, data)
      if opts.on_stderr then
        opts.on_stderr(data)
      end
    end,
    on_exit = function(_, code)
      job = nil
      for id, cb in pairs(pending) do
        pending[id] = nil
        cb("iRemote server exited", nil)
      end
      if opts.on_exit then
        opts.on_exit(code)
      end
    end,
  })
  if job <= 0 then
    job = nil
    return false
  end
  return true
end

function M.running()
  return job ~= nil
end

---@param method string
---@param params table?
---@param cb fun(err: string?, result: any)?
function M.request(method, params, cb)
  local id = next_id
  next_id = next_id + 1
  pending[id] = cb or function() end
  send({ id = id, method = method, params = params or vim.empty_dict() })
end

--- Handles a request from the server; call `reply(result)` exactly once.
---@param method string
---@param handler fun(params: table, reply: fun(result: any))
function M.on_request(method, handler)
  handlers[method] = handler
end

---@param method string
---@param handler fun(params: table)
function M.on_notification(method, handler)
  notification_handlers[method] = handler
end

function M.stop()
  if job then
    M.request("shutdown")
    local j = job
    vim.defer_fn(function()
      if job == j then
        vim.fn.jobstop(j)
      end
    end, 1000)
  end
end

return M
