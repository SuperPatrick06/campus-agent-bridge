#!/usr/bin/env node
'use strict';
/*
 * campus-agent-bridge CLI
 *   gab init     — configure gateway URL / key / model (writes local/, gitignored)
 *   gab start    — start the filtering proxy in the background
 *   gab codex .. — ensure proxy is up, then run Codex against it
 *   gab doctor   — check config, proxy and gateway connectivity
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOCAL = path.join(ROOT, 'local');
const CFG_PATH = path.join(LOCAL, 'config.local.json');
const CODEX_HOME = path.join(LOCAL, 'codex-home');
const CFG_TPL = path.join(ROOT, 'template', 'codex-config.toml.tpl');
const MODELS_TPL = path.join(ROOT, 'template', 'models.tpl.json');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readConfig() {
  if (!fs.existsSync(CFG_PATH)) return null;
  return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
}

function requireConfig() {
  const cfg = readConfig();
  if (!cfg) {
    console.error('[gab] Not configured yet. Run:  gab init');
    process.exit(1);
  }
  return cfg;
}

// One shared readline interface for the whole init run. Lines are buffered
// here instead of via rl.question: rl.question drops lines that arrive before
// the next question is registered (piped/automated input arrives all at once
// and would silently stall init). muted hides typed characters (API key
// prompt) by intercepting readline's own echo writer.
function createAsker() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  const queued = [];
  const waiters = [];
  let closed = false;
  let muted = false;
  if (rl.terminal) {
    rl._writeToOutput = (s) => {
      if (!muted) process.stdout.write(s);
    };
  }
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queued.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  const nextLine = () =>
    new Promise((resolve) => {
      if (queued.length) return resolve(queued.shift());
      if (closed) return resolve(null);
      waiters.push(resolve);
    });
  const read = async (q, hide) => {
    process.stdout.write(q);
    if (hide) muted = true;
    const line = await nextLine();
    if (hide) muted = false;
    // Terminal mode echoes the Enter newline itself (suppressed while muted);
    // piped input is never echoed, so terminate the prompt line manually.
    if (hide || !rl.terminal) process.stdout.write('\n');
    if (line === null) throw new Error('input closed before answers were complete');
    return line.trim();
  };
  return {
    ask: (q) => read(q, false),
    askHidden: (q) => read(q, true),
    close: () => rl.close(),
  };
}

async function fetchJson(url, token, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      /* non-json body */
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

function modelIdsFrom(json) {
  const list = (json && (json.data || json.models)) || [];
  return list.map((m) => m.id || m.slug || m.name).filter(Boolean);
}

async function pickModel(targetOrigin, token, ask) {
  const base = targetOrigin.replace(/\/+$/, '');
  for (const u of [`${base}/v1/models`, `${base}/models`]) {
    const r = await fetchJson(u, token).catch(() => null);
    if (r && r.status === 200 && r.json) {
      const ids = modelIdsFrom(r.json);
      if (ids.length) {
        console.log(`\nModels offered by your gateway (${u}):`);
        ids.forEach((id, i) => console.log(`  [${i + 1}] ${id}`));
        const ans = await ask('Pick by number, or type a model id: ');
        if (/^\d+$/.test(ans) && ids[Number(ans) - 1]) return ids[Number(ans) - 1];
        if (ans) return ans;
        return ids[0];
      }
    }
  }
  console.log('\nCould not list models from the gateway (endpoint missing or key rejected).');
  const ans = await ask('Enter the model id served by your gateway: ');
  if (!ans) throw new Error('model id is required');
  return ans;
}

function render(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
  return out;
}

async function cmdInit() {
  console.log('campus-agent-bridge — init\n');
  const io = createAsker();
  let cfg;
  try {
    let targetOrigin = (await io.ask('Gateway base URL (e.g. https://gateway.example.edu/api): ')).replace(/\/+$/, '');
    if (!/^https?:\/\//.test(targetOrigin)) throw new Error('URL must start with http(s)://');
    if (/\/v\d+$/.test(targetOrigin)) {
      console.log(`note: stripped trailing "/v1" — Codex adds /v1 itself -> using ${targetOrigin.replace(/\/v\d+$/, '')}`);
      targetOrigin = targetOrigin.replace(/\/v\d+$/, '');
    }

    let token = process.env.GAB_TOKEN || '';
    if (!token) token = await io.askHidden('API key (hidden; or set env GAB_TOKEN first): ');
    if (!token) throw new Error('API key is required');

    const providerName = (await io.ask('Provider display name [Campus Gateway]: ')) || 'Campus Gateway';
    const portStr = (await io.ask('Local proxy port [8787]: ')) || '8787';
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');

    const model = await pickModel(targetOrigin, token, io.ask);
    cfg = { targetOrigin, token, providerName, port, model };
  } finally {
    io.close();
  }

  fs.mkdirSync(CODEX_HOME, { recursive: true });
  const catalogPath = path.join(CODEX_HOME, 'models.json');
  const modelsOut = render(fs.readFileSync(MODELS_TPL, 'utf8'), { MODEL_ID: cfg.model });
  JSON.parse(modelsOut); // fail fast on broken template
  const renderedCfg = render(fs.readFileSync(CFG_TPL, 'utf8'), {
    MODEL_ID: cfg.model,
    MODEL_CATALOG_JSON: catalogPath,
    PROVIDER_NAME: cfg.providerName,
    PORT: String(cfg.port),
    TOKEN: cfg.token,
  });
  if (renderedCfg.includes('{{')) throw new Error('template placeholder not fully rendered');

  fs.writeFileSync(CFG_PATH, JSON.stringify({ ...cfg, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(CODEX_HOME, 'config.toml'), renderedCfg, { mode: 0o600 });
  fs.writeFileSync(catalogPath, modelsOut, { mode: 0o600 });

  console.log('\nWritten (all under ./local, gitignored):');
  console.log(`  ${CFG_PATH}`);
  console.log(`  ${path.join(CODEX_HOME, 'config.toml')}`);
  console.log(`  ${catalogPath}`);
  console.log('\nNext:');
  console.log('  gab codex        start a Codex session on your gateway');
  console.log('  gab doctor       verify everything');
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(800, () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function ensureProxy(cfg) {
  if (await portOpen(cfg.port)) return false;
  const child = spawn(process.execPath, [path.join(ROOT, 'proxy.js')], {
    env: { ...process.env, TARGET_ORIGIN: cfg.targetOrigin, PROXY_PORT: String(cfg.port) },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    if (await portOpen(cfg.port)) return true;
  }
  throw new Error(`proxy did not come up on 127.0.0.1:${cfg.port} (see proxy.log)`);
}

async function cmdStart() {
  const cfg = requireConfig();
  const started = await ensureProxy(cfg);
  console.log(
    started
      ? `[gab] proxy started: http://127.0.0.1:${cfg.port} -> ${cfg.targetOrigin}`
      : `[gab] proxy already running: http://127.0.0.1:${cfg.port}`
  );
}

async function cmdCodex() {
  // First run: no config yet — guide the user through setup, then continue.
  if (!readConfig()) {
    console.log("[gab] First run — let's set things up first.\n");
    await cmdInit();
  }
  const cfg = requireConfig();
  const started = await ensureProxy(cfg);
  if (started) console.log(`[gab] proxy started: http://127.0.0.1:${cfg.port}`);
  const args = process.argv.slice(3);
  const env = { ...process.env, CODEX_HOME };
  const isWin = process.platform === 'win32';
  const cmdArgs = isWin ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
  const child = spawn('codex', cmdArgs, { stdio: 'inherit', env, shell: isWin });
  child.on('error', (e) => {
    console.error(`[gab] failed to launch codex: ${e.message}`);
    console.error('[gab] Is the Codex CLI installed? https://github.com/openai/codex');
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
}

async function cmdDoctor() {
  console.log('campus-agent-bridge — doctor\n');
  const cfg = readConfig();
  if (!cfg) {
    console.log('[x] config        not found - run `gab init`');
    process.exit(1);
  }
  console.log(`[ok] config        ${CFG_PATH}`);
  const cfgToml = path.join(CODEX_HOME, 'config.toml');
  const modelsPath = path.join(CODEX_HOME, 'models.json');
  console.log(fs.existsSync(cfgToml) ? `[ok] codex config  ${cfgToml}` : '[x] codex config   missing - rerun `gab init`');
  console.log(fs.existsSync(modelsPath) ? `[ok] catalog       ${modelsPath}` : '[x] catalog        missing - rerun `gab init`');

  const listening = await portOpen(cfg.port);
  console.log(listening ? `[ok] proxy         127.0.0.1:${cfg.port} listening` : `[!] proxy         not running - \`gab start\``);

  const base = cfg.targetOrigin.replace(/\/+$/, '');
  let probed = false;
  for (const u of [`${base}/v1/models`, `${base}/models`]) {
    const r = await fetchJson(u, cfg.token).catch((e) => ({ status: 0, err: e.message }));
    if (r.status === 200) {
      const ids = modelIdsFrom(r.json);
      console.log(`[ok] gateway       ${u} -> 200 (${ids.length} models)`);
      probed = true;
      break;
    }
    if (r.status === 401 || r.status === 403) {
      console.log(`[x] gateway        ${u} -> ${r.status}: key rejected`);
      probed = true;
      break;
    }
    if (r.status && r.status !== 404) {
      console.log(`[!] gateway        ${u} -> ${r.status}`);
      probed = true;
      break;
    }
  }
  if (!probed) console.log(`[x] gateway        unreachable or path wrong: ${cfg.targetOrigin}`);
  console.log('\nAll checks done.');
}

function cmdHelp() {
  console.log(`campus-agent-bridge - give a chat-only AI gateway real agent powers

Usage:
  codex-campus [args...]   one-command entry: setup on first run, then Codex
                           (same as: gab codex)
  gab init                 configure gateway URL, key and model (interactive)
  gab start                start the local filtering proxy (background)
  gab codex [args...]      run Codex through the proxy (isolated CODEX_HOME)
  gab doctor               check config / proxy / gateway
  gab help                 this help

Privacy:
  Everything you enter stays in ./local/ (gitignored). Keys, URLs and
  institution names are never written outside ./local/.

Docs: README.md / README.zh-CN.md`);
}

(async () => {
  const cmd = process.argv[2] || 'help';
  try {
    if (cmd === 'init') await cmdInit();
    else if (cmd === 'start') await cmdStart();
    else if (cmd === 'codex') await cmdCodex();
    else if (cmd === 'doctor') await cmdDoctor();
    else cmdHelp();
  } catch (e) {
    console.error(`[gab] error: ${e.message}`);
    process.exit(1);
  }
})();
