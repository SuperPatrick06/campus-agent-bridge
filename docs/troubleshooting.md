# Troubleshooting

Error → cause → fix. The proxy logs every request to `proxy.log` (gitignored);
set `DUMP=1` to also write full request bodies to `dump-*.json`.

## Gateway errors

### `property include should not exist` (or `prompt_cache_key`, `client_metadata`, `stream_options`, `service_tier`, `access_programs`)

- **Cause:** Codex 0.16x sends Responses-API parameters outside the gateway's
  whitelist. Strict gateways reject with `unknown_parameter` / `invalid_parameter`.
- **Fix:** handled automatically — `sanitize()` strips these top-level params.
  If you still see it, confirm the request actually passes through the proxy
  (`gab doctor`, check `proxy.log` for the request line).

### `property reasoning.summary should not exist` / `text.verbosity`

- **Cause:** Codex sends `reasoning:{effort, summary, context}` and
  `text:{format, verbosity}`; gateways often allow only `effort` / `format`.
- **Fix:** automatic — the proxy trims `reasoning` to `effort` and `text` to
  `format`.

### `input must be a non-empty string or an array of supported message/function items`

- **Cause (most common):** `function_call_output.output` was not a plain
  string. Codex's image-viewing tool returns an array of content parts
  (`input_image` with base64) — gateways accept images only inside **user
  message** content, and require `output` to be a string.
- **Cause (also):** history contains item types the gateway doesn't list —
  `custom_tool_call`, `custom_tool_call_output`, `reasoning`,
  `additional_tools`, `agent_message`.
- **Fix:** automatic — `normalizeToolOutput()` stringifies `output` and moves
  `input_image` parts into a following user message; `custom_tool_call*`
  items are re-encoded as `function_call*` (with `ctco_` → `fc_` id prefixes);
  unknown item types are dropped. If it persists, grab `dump-*.json` and
  inspect which item the gateway still dislikes.

### `tool_choice requires tools to be provided`

- **Cause:** all tools were stripped (e.g. only non-function tools present)
  but `tool_choice` remained.
- **Fix:** automatic — when no function tool survives, `tools`,
  `tool_choice`, and `parallel_tool_calls` are removed together.

### `type must be one of the following values: function`

- **Cause:** Codex sent `custom` or `namespace` tool definitions; gateways
  only accept `type:"function"`.
- **Fix:** automatic — custom tools become functions with a
  `{"input": string}` schema; namespaces are flattened. The proxy remembers
  converted tool names and rewrites the response side back to
  `custom_tool_call` so Codex sees its own wire format.

### 404 from the gateway on every request

- **Cause:** wrong `TARGET_ORIGIN` path prefix — Codex calls
  `/v1/responses`, and the proxy forwards `TARGET_ORIGIN + /v1/responses`.
  If your gateway lives at `https://host/api` (handling `/api/v1/...`), set
  `TARGET_ORIGIN=https://host/api`. If you entered a URL ending in `/v1`,
  `gab init` strips it for you.
- **Fix:** re-run `gab init`, or edit `local/config.local.json` and restart
  the proxy (`gab start` after killing the old process).

### `proxy upstream error: ...` (502)

- **Cause:** gateway unreachable from the proxy (wrong host, TLS failure,
  offline).
- **Fix:** `gab doctor` probes `{base}/v1/models` and `{base}/models`.

## Codex-side errors

### `approval required by policy, but AskForApproval::Granular.sandbox_approval is false`

- **Cause:** Codex 0.16x defaults new directories to `workspace-write` +
  granular approval; with `sandbox_approval=false` approvals are **silently
  auto-rejected** — every command and file read fails with no prompt. Looks
  like "the agent can't do anything".
- **Fix:** the generated `local/codex-home/config.toml` already sets
  `sandbox_mode = "danger-full-access"` and `[windows] sandbox = "elevated"`.
  Verify with `codex doctor`. If you removed those lines, put them back.
  Note this disables the command sandbox — see SECURITY.md.

### Codex uses the wrong gateway / your other keys stopped working

- **Cause:** launching plain `codex` uses your main `~/.codex` config.
- **Fix:** always launch via `codex-campus` (or `gab codex`) — it sets
  `CODEX_HOME=local/codex-home`, so your main config (and any other providers
  or keys in it) is never touched.

### Model not in catalog / model errors at startup

- **Cause:** `local/codex-home/models.json` must contain an entry whose
  `slug` equals the model id your gateway serves.
- **Fix:** re-run `gab init` and pick the right model (it lists models from
  `GET /v1/models`). If the list endpoint doesn't exist, type the id manually.

## Proxy problems

### `codex-campus` says proxy started but requests fail

- Check `proxy.log` for the request lines and status codes.
- Confirm nothing else occupies the port (`gab doctor` shows listening state).
- Another process may hold the port: kill it or choose a different port in
  `local/config.local.json` (then restart).

### Port already in use

- Pick a free port during `gab init`, or edit `local/config.local.json`
  (`port`) and restart the proxy.

### Nothing appears in `proxy.log`

- The proxy only logs when it receives requests. Start Codex with
  `codex-campus` (it auto-starts the proxy if not already running).
