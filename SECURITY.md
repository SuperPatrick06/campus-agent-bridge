# Security Policy

## Design guarantees

- The proxy binds to `127.0.0.1` only — never a public interface.
- The proxy stores no credentials. Codex's `Authorization` header is forwarded
  to your gateway as-is; nothing is logged to disk by default.
- No telemetry, analytics, or outbound calls except to the gateway URL you
  configure.
- All user-supplied configuration (gateway URL, API key, model id) is written
  exclusively under `./local/`, which is gitignored.

## Known risk areas — read before running

1. **`sandbox_mode = "danger-full-access"`** in the generated Codex config is
   required for Codex ≥ 0.16x to function (otherwise approvals are silently
   auto-rejected). This disables Codex's command/file sandbox: the model can
   execute local commands without approval prompts. Only use it with gateways
   and models you trust. If you prefer, edit `local/codex-home/config.toml`
   and relax this — but expect tool-execution to be denied (see
   docs/troubleshooting.md, "approval required by policy").
2. **API key confidentiality**: the key sits in `local/config.local.json` and
   `local/codex-home/config.toml` with file mode 0600 where the OS supports it.
   Do not commit these files (they are gitignored — do not remove that entry).
   Do not paste them into issues or logs.
3. **`DUMP=1` request dumps**: when debugging, the proxy writes full request
   bodies (including conversation content) to `dump-*.json`. Treat as
   sensitive; delete when finished. These are gitignored.
4. **TLS**: the proxy talks to your gateway using `fetch`. If you configure an
   `http://` gateway URL, the API key crosses your network unencrypted —
   prefer `https://`.

## Reporting a vulnerability

This is a small community project. If you find a security issue, please open a
private security advisory on the repository (or an issue marked
`security`, without exploit details) and we will respond as soon as possible.
