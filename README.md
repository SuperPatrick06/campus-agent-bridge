<div align="center">

# 🌉 campus-agent-bridge

### Give any chat-only AI gateway real **agent** powers

Your school or company issues an OpenAI-compatible API key. Codex wants to plan,
run commands, and edit files. They speak different dialects of the same protocol —
this tiny local proxy translates between them.

**Zero gateway changes · Zero cloud relay · Zero npm dependencies**

[![License: MIT](https://img.shields.io/badge/license-MIT-2d8cff)](LICENSE)
[![Node.js ≥ 18](https://img.shields.io/badge/node-%E2%89%A5%2018-339933)](https://nodejs.org)
[![npm dependencies](https://img.shields.io/badge/npm%20deps-0-blueviolet)](package.json)
[![Tests](https://img.shields.io/badge/tests-19%20passed-brightgreen)](test/run.js)

🌐 **English** | [简体中文](README.zh-CN.md)

[✨ Features](#-features) · [🚀 Quick Start](#-quick-start) · [🧭 How It Works](#-how-it-works) · [⚠️ Pitfalls](#%EF%B8%8F-the-three-pitfalls) · [🔒 Privacy](#-privacy)

</div>

---

## 😩 The Problem

Institutional AI platforms (universities, companies) usually expose an
OpenAI-compatible **chat** API — great for asking questions, useless as a
coding agent. Meanwhile, agents like [Codex](https://github.com/openai/codex)
can plan, execute shell commands, edit your repo and iterate… but only if the
API accepts its full **Responses** dialect. Strict gateways don't:

| What Codex sends | What the gateway replies |
|---|---|
| `include`, `prompt_cache_key`, `client_metadata`, … | ❌ `property include should not exist` |
| tool output containing images | ❌ `input must be a non-empty string...` |
| `custom_tool_call` history items | ❌ not a "supported message/function item" |
| `custom` / `namespace` tool types | ❌ only `type: "function"` allowed |

**campus-agent-bridge** runs on `127.0.0.1` between them: it cleans requests
before they reach the gateway, and rewrites responses back into Codex's dialect.

```
┌────────────┐  Responses API   ┌───────────────────────────┐  strict subset  ┌─────────┐
│   Codex    │ ───────────────► │ campus-agent-bridge proxy │ ──────────────► │ gateway │
│ agent+tools│ ◄─────────────── │   127.0.0.1:8787          │ ◄────────────── │ (brain) │
└────────────┘  Codex dialect   └───────────────────────────┘  clean dialect  └─────────┘
        ▲                                                       ▲
        └── tools run locally (shell, files, apply_patch)       └── your institution's API
```

The gateway stays the **brain**; the tools execute locally on your machine.

## ✨ Features

- 🧼 **Protocol sanitizer** — strips unknown params, trims `reasoning` / `text`,
  whitelists history items, flattens tool namespaces
- 🖼️ **Image tools keep working** — image tool outputs are moved into user
  messages (the only place strict gateways accept `input_image`), so the model
  can still *see* the screenshots
- 🔄 **Bidirectional tool translation** — `custom_tool_call` ⇄ `function_call`
  on both request and response paths (JSON **and** SSE streams)
- 🛡️ **Sandbox unlock** — generates the config Codex 0.16x needs; without it,
  approvals are *silently* auto-rejected and the agent looks dead
- 🔒 **Privacy by design** — your URL, key and model live only in gitignored
  `./local/`; the proxy holds no keys and phones nothing home
- 🧪 **Tested against a mock strict gateway** — 19 tests, including a full
  end-to-end run through a gateway that enforces every real-world rule
- ⚡ **Zero dependencies** — one `node` binary is enough; no `npm install`
- 🩺 **Self-diagnosis** — `gab doctor` checks config, proxy and gateway connectivity

## 🚀 Quick Start

**Requirements:** [Node.js](https://nodejs.org) ≥ 18 ·
[Codex CLI](https://github.com/openai/codex) ≥ 0.16x · your gateway URL + key

```sh
git clone https://github.com/SuperPatrick06/campus-agent-bridge.git
cd campus-agent-bridge
./codex-campus          # Windows: codex-campus.cmd
```

The **first run walks you through setup** (gateway URL → API key → model),
then opens Codex. After that, typing `codex-campus` is all you need — it
starts the local proxy automatically and drops you into an isolated session.

> 💡 **Make it global:** add the folder to your `PATH` (Windows), or
> `ln -s "$PWD/codex-campus" /usr/local/bin/codex-campus` (macOS / Linux).

<details>
<summary><b>Manual commands</b> (same thing, one layer down)</summary>

```sh
gab init        # interactive setup — writes ./local (gitignored)
gab codex       # identical to ./codex-campus
gab start       # just start the proxy in the background
gab doctor      # check config / proxy / gateway connectivity
npm test        # run the test suite (unit + end-to-end)
```

</details>

### 🧩 What `init` writes

| File | Purpose | Ever committed? |
|---|---|---|
| `local/config.local.json` | gateway URL, key, model, port | ❌ gitignored |
| `local/codex-home/config.toml` | isolated Codex config → proxy | ❌ gitignored |
| `local/codex-home/models.json` | model catalog for your gateway's model | ❌ gitignored |

Your main `~/.codex` config is **never touched** — sessions launched via
`codex-campus` use `CODEX_HOME=local/codex-home`, so any other providers and
keys you keep there keep working exactly as before.

## ⚠️ The Three Pitfalls

Battle-tested fixes for what everyone hits with Codex × strict gateways.
The proxy handles all three automatically:

1. **`property include should not exist`** — Codex 0.16x sends params outside
   the gateway's whitelist (`include`, `prompt_cache_key`, `client_metadata`, …).
   → stripped before forwarding; `reasoning` keeps only `effort`,
   `text` keeps only `format`.

2. **`approval required by policy, but sandbox_approval is false`** — in a
   fresh directory Codex silently auto-rejects *every* command and file read
   with no prompt, so the agent appears dead. → the generated config sets
   `sandbox_mode = "danger-full-access"` (+ `[windows] sandbox = "elevated"`).

3. **`input must be a non-empty string or an array of supported
   message/function items`** — viewing an image makes Codex send a non-string
   tool output (array of content parts), which gateways reject. → output is
   stringified and the image rides along in a user message, so the model
   still sees it.

Every error has a full entry in [docs/troubleshooting.md](docs/troubleshooting.md)
(error → cause → fix).

## 🔒 Privacy

Designed so that **nothing you type in setup ever leaves `./local/`**:

- 🔑 The proxy holds no keys — it forwards Codex's `Authorization` header as-is
- 📡 No telemetry; the only network calls go to *your* gateway
- 🚫 No institution names, URLs or keys anywhere in the tracked source
- 🧹 `DUMP=1` debug dumps (`dump-*.json`) are gitignored — delete them when done
- ✅ Publish-time self-check:

  ```sh
  grep -rniE 'yourname|yourschool|sk-[0-9a-f]{8}|[0-9]{1,3}(\.[0-9]{1,3}){3}' \
    . --exclude-dir=local --exclude-dir=.git
  ```

## 🧪 Development

```sh
npm test                        # 19 tests: unit + mock-gateway end-to-end
node --check proxy.js bin/cli.js
```

The suite includes a **mock strict gateway** that enforces the same rules real
gateways do — unknown params, item whitelist, string-only tool outputs,
function-only tools — and runs the real proxy in front of it.

Contributions welcome — protocol fixes for other gateways especially!

## ⚖️ Disclaimer

This is an independent community project, not affiliated with OpenAI or any
institution. If your gateway belongs to a university or employer, **check that
their terms allow automated clients** — complying is on you. Agent sessions can
run local commands; review what the model does, as with any coding agent.
Full text: [DISCLAIMER.md](DISCLAIMER.md) · Security: [SECURITY.md](SECURITY.md)

## 📄 License

[MIT](LICENSE) © campus-agent-bridge contributors.
Model catalog data derived from [openai/codex](https://github.com/openai/codex)
(Apache-2.0) — see [NOTICE](NOTICE).

<div align="center">
If this unlocked your campus AI — a ⭐ star would be lovely!
</div>
