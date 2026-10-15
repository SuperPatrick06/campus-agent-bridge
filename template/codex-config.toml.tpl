# campus-agent-bridge — Codex provider config template.
# `gab init` renders this into local/codex-home/config.toml with your values.
# local/ is gitignored: your URL / key / paths never enter version control.
model_provider = "campus"
model = "{{MODEL_ID}}"
model_reasoning_effort = "high"
model_catalog_json = '{{MODEL_CATALOG_JSON}}'
# Codex must not sandbox-restrict this provider-driven session; without it
# Codex 0.16x may silently auto-reject every command for new directories.
sandbox_mode = "danger-full-access"

[model_providers.campus]
name = "{{PROVIDER_NAME}}"
base_url = "http://127.0.0.1:{{PORT}}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "{{TOKEN}}"

# Optional: mark project folders as trusted to skip the one-time trust prompt.
# [projects.'D:\your\project']
# trust_level = "trusted"

# Windows-only sandbox backend level. Comment out if it misbehaves locally.
[windows]
sandbox = "elevated"
