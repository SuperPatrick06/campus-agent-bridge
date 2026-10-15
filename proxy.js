'use strict';
/*
 * campus-agent-bridge — local request/response filtering proxy.
 *
 * Codex (0.16x) always sends Responses-API parameters and tool/history item
 * shapes that strict OpenAI-compatible gateways reject with
 * `unknown_parameter` / `invalid_parameter` errors. This proxy normalizes
 * requests before forwarding them, and rewrites responses back into the
 * shapes Codex expects. The gateway stays the "brain"; tools execute locally.
 *
 * - Listens on 127.0.0.1 only.
 * - Holds no keys: the Authorization header from Codex is forwarded as-is.
 * - Configure the upstream via TARGET_ORIGIN (set by `gab init` / `gab start`).
 */
const http = require('http');
const { Readable, Transform } = require('stream');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PROXY_PORT || 8787);
const TARGET = process.env.TARGET_ORIGIN || '';
const LOG = path.join(__dirname, 'proxy.log');

if (!TARGET && require.main === module) {
  console.error('[gab] TARGET_ORIGIN is not set.');
  console.error('[gab] Run `gab init` first (or: TARGET_ORIGIN=https://your-gateway/api node proxy.js).');
  process.exit(1);
}

// Top-level request params strict gateways reject with unknown_parameter.
const STRIP_TOP = new Set([
  'include',
  'stream_options',
  'service_tier',
  'prompt_cache_key',
  'client_metadata',
  'access_programs',
]);

// Input item types the gateway accepts ("supported message/function items").
// custom_tool_call{,_output} are NOT listed: they are converted to function
// equivalents below because the gateway rejects them.
const KEEP_INPUT_TYPES = new Set([
  'message',
  'function_call',
  'function_call_output',
]);

function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  fs.appendFile(LOG, entry, () => {});
  process.stdout.write(entry);
}

function textOf(item) {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return null;
}

// Gateway only accepts a STRING for function_call_output.output. Codex may
// send a content-item array (e.g. view_image returns input_image parts with
// base64 data). Normalize to text; images are re-sent as a user message
// (gateways accept input_image inside user message content).
function normalizeToolOutput(output) {
  const imageParts = [];
  const texts = [];
  const collect = (part) => {
    if (!part || typeof part !== 'object') return;
    if (part.type === 'input_image' && typeof part.image_url === 'string') {
      imageParts.push(part);
    } else if (typeof part.text === 'string' && (part.type === 'output_text' || part.type === 'input_text')) {
      texts.push(part.text);
    }
  };
  if (typeof output === 'string') return { output, imageParts };
  if (Array.isArray(output)) {
    output.forEach(collect);
  } else if (output && typeof output === 'object') {
    // FunctionCallOutputPayload { body: ... } fallback.
    if (Array.isArray(output.body)) output.body.forEach(collect);
    else if (output.body && typeof output.body.text === 'string') texts.push(output.body.text);
    else texts.push(JSON.stringify(output));
  } else if (output != null) {
    texts.push(String(output));
  }
  let text = texts.join('\n');
  if (!text && imageParts.length) text = `(image output x${imageParts.length})`;
  return { output: text, imageParts };
}

function pushImageMessages(kept, imageParts, dropped) {
  if (!imageParts.length) return;
  kept.push({
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: `(image tool output: ${imageParts.length} attached)` },
      ...imageParts,
    ],
  });
  dropped.push(`image-output->message x${imageParts.length}`);
}

function sanitize(body) {
  const removed = [];
  const dropped = [];
  // Names of custom (freeform) tools converted to function on the wire;
  // their response stream events must be converted back.
  const convertedNames = new Set();

  for (const key of STRIP_TOP) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      delete body[key];
      removed.push(key);
    }
  }

  // Gateways reject reasoning.summary / reasoning.context; keep effort only.
  if (body.reasoning && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)) {
    const keep = {};
    if ('effort' in body.reasoning) keep.effort = body.reasoning.effort;
    const extra = Object.keys(body.reasoning).filter((k) => !(k in keep));
    if (extra.length) removed.push(extra.map((k) => `reasoning.${k}`).join(','));
    if (Object.keys(keep).length > 0) body.reasoning = keep;
    else delete body.reasoning;
  }

  if (Array.isArray(body.input)) {
    const kept = [];
    let inputChanged = false;
    for (const item of body.input) {
      const t = item && item.type;
      if (t === 'function_call_output' && item.output != null && typeof item.output !== 'string') {
        const norm = normalizeToolOutput(item.output);
        kept.push({ ...item, output: norm.output });
        pushImageMessages(kept, norm.imageParts, dropped);
        inputChanged = true;
        dropped.push('history:fn_output->string');
      } else if (KEEP_INPUT_TYPES.has(t)) {
        kept.push(item);
      } else if (t === 'additional_tools') {
        // Flatten the deferred tool registry into top-level tools. Entries may
        // be namespaces (recurse) or plain tools (function/custom) directly.
        const flat = [];
        const flattenInto = (arr) => {
          for (const tool of arr || []) {
            if (tool && tool.type === 'namespace') {
              dropped.push(`namespace(${tool.name})->flat`);
              flattenInto(tool.tools);
            } else if (tool && typeof tool === 'object') flat.push(tool);
          }
        };
        flattenInto(item.tools);
        if (flat.length) {
          body.tools = (Array.isArray(body.tools) ? body.tools : []).concat(flat);
        }
        dropped.push('additional_tools->tools');
      } else if (t === 'instructions') {
        // Rebuild prompt-only instructions as a system message.
        const text = textOf(item);
        if (text) {
          kept.push({ type: 'message', role: 'system', content: [{ type: 'input_text', text }] });
          inputChanged = true;
          dropped.push('instructions->system');
        } else {
          dropped.push('instructions(unparseable)');
        }
      } else if (t === 'custom_tool_call') {
        // Gateway only accepts message/function history items. Re-encode the
        // freeform call as a function_call whose arguments match the schema
        // used when the custom tool was converted to a function.
        const call = {
          type: 'function_call',
          call_id: item.call_id,
          name: item.name,
          arguments: JSON.stringify({ input: item.input }),
        };
        if (item.id) call.id = item.id;
        if (item.status) call.status = item.status;
        if (item.namespace) call.namespace = item.namespace;
        kept.push(call);
        inputChanged = true;
        dropped.push('history:custom_tool_call->function_call');
      } else if (t === 'custom_tool_call_output') {
        // Output must be a string for the gateway; images move into a
        // following user message (gateway accepts input_image there).
        const norm = normalizeToolOutput(item.output);
        const out = { type: 'function_call_output', call_id: item.call_id, output: norm.output };
        // Gateways validate output item ids against the "fc" prefix.
        if (item.id) out.id = String(item.id).replace(/^ctco_/, 'fc_');
        if (item.name) out.name = item.name;
        kept.push(out);
        pushImageMessages(kept, norm.imageParts, dropped);
        inputChanged = true;
        dropped.push('history:custom_tool_call_output->function_call_output');
      } else {
        dropped.push(t || 'unknown-item');
      }
    }
    if (kept.length > 0 && (inputChanged || kept.length !== body.input.length)) body.input = kept;
    else if (kept.length === 0 && body.input.length > 0) dropped.push('ALL-ITEMS-DROPPED(kept raw)');
  }

  // Gateways reject text.verbosity; keep only known text fields.
  if (body.text && typeof body.text === 'object' && !Array.isArray(body.text)) {
    const keep = {};
    if ('format' in body.text) keep.format = body.text.format;
    const extra = Object.keys(body.text).filter((k) => !(k in keep));
    if (extra.length) removed.push(extra.map((k) => `text.${k}`).join(','));
    if (Object.keys(keep).length > 0) body.text = keep;
    else delete body.text;
  }

  // Gateways only accept type:"function" tools. Flatten namespaces and
  // convert custom (freeform) tools to a function with a string input.
  if (Array.isArray(body.tools)) {
    const asFunction = (tool, out) => {
      if (!tool || typeof tool !== 'object') return;
      if (tool.type === 'function') {
        const { format, ...rest } = tool;
        out.push(rest);
      } else if (tool.type === 'namespace') {
        for (const inner of tool.tools || []) asFunction(inner, out);
        dropped.push(`namespace(${tool.name})->flat`);
      } else if (tool.type === 'custom') {
        out.push({
          type: 'function',
          name: tool.name,
          description: tool.description || 'Freeform tool. Pass raw text as {"input": "..."}',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: 'Raw tool input text' } },
            required: ['input'],
            additionalProperties: false,
          },
        });
        convertedNames.add(tool.name);
        dropped.push(`custom(${tool.name})->function`);
      } else {
        dropped.push(`tool(${tool.name || tool.type})`);
      }
    };
    const flat = [];
    for (const tool of body.tools) asFunction(tool, flat);
    if (flat.length > 0) body.tools = flat;
    else {
      delete body.tools;
      delete body.tool_choice;
      delete body.parallel_tool_calls;
      removed.push('tools(empty)+tool_choice+parallel_tool_calls');
    }
  } else if ('tool_choice' in body) {
    delete body.tool_choice;
    delete body.parallel_tool_calls;
    removed.push('tool_choice(no tools)+parallel_tool_calls');
  }

  return { removed, dropped, convertedNames };
}

// --- Response-side rewrites ---------------------------------------------

// function_call item -> custom_tool_call item (unwrap {"input": ...} JSON).
function rewriteItem(item, names) {
  if (!item || item.type !== 'function_call' || !names.has(item.name)) return item;
  let input = typeof item.arguments === 'string' ? item.arguments : '';
  try {
    const obj = JSON.parse(input);
    if (obj && typeof obj === 'object' && typeof obj.input === 'string') input = obj.input;
  } catch (_) {
    /* keep raw arguments */
  }
  const out = { type: 'custom_tool_call', call_id: item.call_id, name: item.name, input };
  if (item.id) out.id = item.id;
  if (item.status) out.status = item.status;
  if (item.namespace) out.namespace = item.namespace;
  return out;
}

function rewriteOutputArray(arr, names) {
  let changed = false;
  const next = arr.map((item) => {
    const rewritten = rewriteItem(item, names);
    if (rewritten !== item) changed = true;
    return rewritten;
  });
  return changed ? next : null;
}

function rewriteJsonBody(obj, names) {
  if (Array.isArray(obj.output)) {
    const next = rewriteOutputArray(obj.output, names);
    if (next) obj.output = next;
  }
  if (obj.response && Array.isArray(obj.response.output)) {
    const next = rewriteOutputArray(obj.response.output, names);
    if (next) obj.response.output = next;
  }
  return obj;
}

// Rewrite one SSE line; non-data lines and unrelated events pass through.
function sseRewriteLine(line, names) {
  const nlIdx = Math.max(line.lastIndexOf('\n'), line.lastIndexOf('\r'));
  const body = nlIdx === -1 ? line : line.slice(0, nlIdx);
  const eol = nlIdx === -1 ? '' : line.slice(nlIdx);
  if (!body.startsWith('data:')) return line;
  const payload = body.slice(5);
  const jsonText = payload.startsWith(' ') ? payload.slice(1) : payload;
  if (!jsonText.startsWith('{')) return line;
  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch (_) {
    return line;
  }
  const t = obj.type;
  if ((t === 'response.output_item.added' || t === 'response.output_item.done') && obj.item) {
    const rewritten = rewriteItem(obj.item, names);
    if (rewritten === obj.item) return line;
    obj.item = rewritten;
    return 'data: ' + JSON.stringify(obj) + eol;
  }
  if ((t === 'response.completed' || t === 'response.incomplete') && obj.response) {
    const before = JSON.stringify(obj.response.output);
    rewriteJsonBody(obj, names);
    if (JSON.stringify(obj.response.output) === before) return line;
    return 'data: ' + JSON.stringify(obj) + eol;
  }
  return line;
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    let outBody = raw;
    let note = '';
    let namesForResponse = new Set();

    const ctype = String(req.headers['content-type'] || '');
    if (raw.length > 0 && ctype.includes('application/json')) {
      try {
        const body = JSON.parse(raw.toString('utf8'));
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          const { removed, dropped, convertedNames } = sanitize(body);
          namesForResponse = convertedNames;
          if (removed.length || dropped.length) {
            note = ` removed=[${removed.join(';')}] dropped=[${dropped.join(',')}]`;
          }
          if (process.env.DUMP === '1') {
            const dumpFile = path.join(__dirname, `dump-${Date.now()}.json`);
            fs.writeFile(dumpFile, JSON.stringify({ raw: JSON.parse(raw.toString('utf8')), sanitized: body }, null, 2), () => {});
          }
          outBody = Buffer.from(JSON.stringify(body), 'utf8');
        }
      } catch (e) {
        note = ` (json-parse-failed: ${e.message})`;
      }
    }

    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    if (outBody.length > 0) headers['content-length'] = String(outBody.length);

    const url = TARGET + req.url;
    let upstream;
    try {
      upstream = await fetch(url, {
        method: req.method,
        headers,
        body: outBody.length > 0 ? outBody : undefined,
      });
    } catch (e) {
      log(`${req.method} ${req.url}${note} -> upstream-error: ${e.message}`);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `proxy upstream error: ${e.message}`, type: 'proxy_error' } }));
      return;
    }

    log(`${req.method} ${req.url}${note} -> ${upstream.status}`);

    const outHeaders = {};
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (lk === 'content-encoding' || lk === 'transfer-encoding' || lk === 'content-length') return;
      outHeaders[k] = v;
    });

    res.writeHead(upstream.status, outHeaders);
    if (!upstream.body) {
      res.end();
      return;
    }

    const upType = String(upstream.headers.get('content-type') || '');
    const doRewrite = namesForResponse.size > 0 && upstream.ok;

    if (doRewrite && upType.includes('text/event-stream')) {
      const dec = new StringDecoder('utf8');
      let buf = '';
      const trans = new Transform({
        transform(chunk, _enc, cb) {
          buf += dec.write(chunk);
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl + 1);
            buf = buf.slice(nl + 1);
            this.push(sseRewriteLine(line, namesForResponse));
          }
          cb();
        },
        flush(cb) {
          const rest = buf + dec.end();
          if (rest) this.push(sseRewriteLine(rest, namesForResponse));
          buf = '';
          cb();
        },
      });
      Readable.fromWeb(upstream.body).pipe(trans).pipe(res);
    } else if (doRewrite && upType.includes('application/json')) {
      try {
        const text = await upstream.text();
        const obj = JSON.parse(text);
        res.end(JSON.stringify(rewriteJsonBody(obj, namesForResponse)));
      } catch (_) {
        res.end();
      }
    } else {
      Readable.fromWeb(upstream.body).pipe(res);
    }
  });
});

function start() {
  server.listen(PORT, '127.0.0.1', () => {
    log(`proxy listening on http://127.0.0.1:${PORT} -> ${TARGET}`);
  });
}

if (require.main === module) start();

module.exports = {
  sanitize,
  normalizeToolOutput,
  rewriteItem,
  rewriteJsonBody,
  sseRewriteLine,
};
