# How it works

## The problem

Codex speaks the OpenAI **Responses API** wire in full. A typical
institutional gateway implements a strict subset and validates everything:

| Codex → gateway | Gateway rule | Result without a proxy |
|---|---|---|
| top-level `include`, `prompt_cache_key`, `client_metadata`, `stream_options`, `service_tier`, `access_programs` | whitelist → `unknown_parameter` | 400 on every request |
| `reasoning: {effort, summary, context}` | only `effort` allowed | 400 |
| `text: {format, verbosity}` | only `format` allowed | 400 |
| history items `custom_tool_call`, `custom_tool_call_output`, `reasoning`, `agent_message`, `additional_tools` | "supported **message/function** items" only | 400 |
| `function_call_output.output` as content array (image tools) | `output` must be a **string** | 400 after viewing an image |
| tools `type: "custom"` / `type: "namespace"` | `type: "function"` only | 400 |
| `tool_choice` present while tools empty | `tool_choice requires tools` | 400 |

Separately, Codex ≥ 0.16x in a fresh directory defaults to
`workspace-write` sandbox with granular approval and
`sandbox_approval=false`, so **approvals are silently auto-rejected** — every
local command fails with
`approval required by policy, but AskForApproval::Granular.sandbox_approval is false`.

## The architecture

```
┌────────────┐  Responses API   ┌──────────────────────────┐  strict subset  ┌─────────┐
│   Codex    │ ───────────────► │ campus-agent-bridge proxy │ ──────────────► │ gateway │
│ agent+tools│ ◄─────────────── │ 127.0.0.1:<port>          │ ◄────────────── │ (brain) │
└────────────┘  Codex shapes    └──────────────────────────┘  clean shapes   └─────────┘
```

Three layers:

1. **Protocol-cleaning core** (`proxy.js`, the open-source module):
   request sanitization + response/SSE rewrite. Stateless, no config, no keys.
2. **Instance config** (`local/`, gitignored): your URL, key, model — written
   only by `gab init`, read only by your machine.
3. **Integration layer** (`bin/cli.js`): interactive init, proxy lifecycle,
   isolated `CODEX_HOME` launch, doctor checks.

## Request path

`sanitize(body)` runs on every JSON request body:

1. **Strip top-level params** in `STRIP_TOP`.
2. **Trim `reasoning`** → `{effort}` only; **trim `text`** → `{format}` only.
3. **Input items**, in order per item:
   - `function_call_output` with non-string `output` → stringify via
     `normalizeToolOutput()`; `input_image` parts are appended as a user
     message (`pushImageMessages`) because gateways accept images in user
     message content but not in tool output.
   - `message` / `function_call` / `function_call_output` → kept as-is.
   - `additional_tools` → namespaces flattened into `body.tools`.
   - `instructions` item → rebuilt as a `system` message.
   - `custom_tool_call` → `function_call` with
     `arguments = JSON.stringify({input: ...})` (matches the schema used when
     the custom tool is converted to a function below).
   - `custom_tool_call_output` → `function_call_output`, string output,
     id prefix `ctco_` → `fc_`, images pushed as a user message.
   - anything else (`reasoning`, `agent_message`, …) → dropped.
4. **Tools**: `function` → kept (its `format` field stripped); `namespace` →
   recursed/flattened; `custom` → converted to a function whose parameters
   are `{"input": string}` and whose name is recorded in `convertedNames`;
   other types → dropped. If nothing survives: delete `tools`, `tool_choice`,
   `parallel_tool_calls`.

The transformation is applied only when something actually changed, so
identical-length histories are still replaced correctly (regression covered
by tests).

## Response path

When `convertedNames` is non-empty (at least one custom tool was converted),
successful upstream responses are rewritten back to Codex's wire:

- **JSON bodies** (`rewriteJsonBody`): `output[]` / `response.output[]`
  items with `type: "function_call"` and `name ∈ convertedNames` become
  `custom_tool_call` with `input` unwrapped from `{"input": ...}`.
- **SSE streams** (`sseRewriteLine`): same rewrite applied to
  `response.output_item.added`, `response.output_item.done`,
  `response.completed`, `response.incomplete` events, line by line.

Tools that were already `function` type are passed through untouched.

## Isolation model

- The proxy listens on `127.0.0.1` only and holds **no keys** — it forwards
  Codex's `Authorization` header verbatim.
- `codex-campus` (or `gab codex`) runs Codex with `CODEX_HOME=local/codex-home`, so the generated
  config (proxy base URL, model catalog, sandbox mode) applies only to these
  sessions. Your main Codex config and its providers/keys are never modified.
- All instance data lives under `local/`, excluded by `.gitignore`.

## Test strategy

`npm test` (zero dependencies):

1. **Unit tests** against the exported pure functions (`sanitize`,
   `normalizeToolOutput`, `rewriteItem`, `rewriteJsonBody`, `sseRewriteLine`).
2. **End-to-end**: a mock strict gateway (port 19876) enforces the same rules
   as real gateways — unknown params, item whitelist, string-only tool
   outputs, function-only tools. The real `proxy.js` (port 18787) sits in
   front of it; the test sends a "worst case" Codex request and asserts the
   gateway accepted it, saw sanitized input, and that the response came back
   as `custom_tool_call`.
