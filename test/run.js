'use strict';
/*
 * campus-agent-bridge test suite (no dependencies).
 *   node test/run.js   /   npm test
 * 1) Unit tests for the pure request/response rewrite functions.
 * 2) End-to-end: proxy in front of a mock STRICT gateway that enforces the
 *    same validation rules real gateways do (unknown params, item whitelist,
 *    string-only tool outputs).
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const { sanitize, normalizeToolOutput, rewriteItem, rewriteJsonBody, sseRewriteLine } = require('../proxy.js');

let passed = 0;
const failures = [];
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL - ${name}: ${e.message}`);
  }
}

function baseInput(extra) {
  return Object.assign({ model: 'test-model', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }, extra);
}

console.log('unit: top-level param stripping');
ok('strips include/prompt_cache_key/client_metadata', () => {
  const b = baseInput({ include: ['reasoning.encrypted_content'], prompt_cache_key: 'k', client_metadata: {} });
  const { removed } = sanitize(b);
  assert(!('include' in b) && !('prompt_cache_key' in b) && !('client_metadata' in b));
  assert(removed.includes('include') && removed.includes('prompt_cache_key'));
});
ok('reasoning keeps only effort', () => {
  const b = baseInput({ reasoning: { effort: 'high', summary: 'auto', context: 'x' } });
  sanitize(b);
  assert.deepStrictEqual(b.reasoning, { effort: 'high' });
});
ok('text keeps only format', () => {
  const b = baseInput({ text: { format: { type: 'text' }, verbosity: 'low' } });
  sanitize(b);
  assert.deepStrictEqual(b.text, { format: { type: 'text' } });
});

console.log('unit: tools normalization');
ok('flattens additional_tools namespaces and converts custom tools', () => {
  const b = baseInput({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      {
        type: 'additional_tools',
        role: 'assistant',
        tools: [
          { type: 'namespace', name: 'ns', tools: [{ type: 'function', name: 'shell', parameters: {} }] },
          { type: 'custom', name: 'exec', description: 'run' },
        ],
      },
    ],
    tool_choice: 'auto',
  });
  const { convertedNames, dropped } = sanitize(b);
  assert.strictEqual(b.tools.length, 2);
  assert(b.tools.every((t) => t.type === 'function'));
  assert(convertedNames.has('exec'));
  assert(b.input.every((it) => it.type !== 'additional_tools'));
  assert(dropped.some((d) => d.includes('namespace')));
});
ok('drops tool_choice when no tools survive', () => {
  const b = baseInput({ tools: [{ type: 'web_search' }], tool_choice: 'auto', parallel_tool_calls: true });
  sanitize(b);
  assert(!('tools' in b) && !('tool_choice' in b) && !('parallel_tool_calls' in b));
});

console.log('unit: history item conversion');
ok('custom_tool_call -> function_call wrapping input JSON', () => {
  const b = baseInput({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch', id: 'ctc_1' },
    ],
  });
  const { dropped } = sanitize(b);
  const fc = b.input.find((i) => i.type === 'function_call');
  assert(fc, 'function_call present');
  assert.strictEqual(JSON.parse(fc.arguments).input, '*** Begin Patch');
  assert(dropped.some((d) => d.includes('custom_tool_call->function_call')));
});
ok('same-length conversion is actually applied (regression)', () => {
  const b = baseInput({ input: [{ type: 'custom_tool_call', call_id: 'c1', name: 'x', input: 'y' }] });
  sanitize(b);
  assert.strictEqual(b.input[0].type, 'function_call');
});
ok('custom_tool_call_output string output + fc id prefix', () => {
  const b = baseInput({
    input: [
      { type: 'custom_tool_call_output', call_id: 'c1', id: 'ctco_9', output: 'done', name: 'exec' },
    ],
  });
  sanitize(b);
  const o = b.input[0];
  assert.strictEqual(o.type, 'function_call_output');
  assert.strictEqual(o.output, 'done');
  assert.strictEqual(o.id, 'fc_9');
});
ok('image array output -> string output + image user message', () => {
  const b = baseInput({
    input: [
      { type: 'custom_tool_call_output', call_id: 'c1', id: 'ctco_1', output: [{ type: 'input_image', image_url: 'data:image/png;base64,QQ==' }] },
    ],
  });
  const { dropped } = sanitize(b);
  const out = b.input.find((i) => i.type === 'function_call_output');
  assert(out && typeof out.output === 'string');
  const msg = b.input.find((i) => i.type === 'message' && Array.isArray(i.content) && i.content.some((p) => p.type === 'input_image'));
  assert(msg, 'image message appended');
  assert(dropped.some((d) => d.startsWith('image-output->message')));
});
ok('non-string function_call_output normalized to string', () => {
  const b = baseInput({
    input: [{ type: 'function_call_output', call_id: 'c1', output: [{ type: 'output_text', text: 'ok' }] }],
  });
  sanitize(b);
  assert.strictEqual(b.input[0].output, 'ok');
});
ok('unknown item types are dropped', () => {
  const b = baseInput({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', id: 'r1', summary: [] },
      { type: 'agent_message', author: 'a', recipient: 'b', content: [] },
    ],
  });
  sanitize(b);
  assert(b.input.every((i) => i.type === 'message'));
});

console.log('unit: output normalization + response rewrite');
ok('normalizeToolOutput handles string/array/payload', () => {
  assert.strictEqual(normalizeToolOutput('x').output, 'x');
  const arr = normalizeToolOutput([{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }]);
  assert.strictEqual(arr.output, 'a\nb');
  const pl = normalizeToolOutput({ body: { type: 'text', text: 'z' } });
  assert.strictEqual(pl.output, 'z');
});
ok('rewriteItem converts function_call back to custom_tool_call', () => {
  const names = new Set(['exec']);
  const out = rewriteItem({ type: 'function_call', call_id: 'c1', name: 'exec', arguments: '{"input":"dir"}' }, names);
  assert.strictEqual(out.type, 'custom_tool_call');
  assert.strictEqual(out.input, 'dir');
  const passthrough = rewriteItem({ type: 'function_call', call_id: 'c2', name: 'shell', arguments: '{}' }, names);
  assert.strictEqual(passthrough.type, 'function_call');
});
ok('rewriteJsonBody handles response.output', () => {
  const names = new Set(['exec']);
  const obj = { response: { output: [{ type: 'function_call', call_id: 'c', name: 'exec', arguments: '{"input":"x"}' }] } };
  rewriteJsonBody(obj, names);
  assert.strictEqual(obj.response.output[0].type, 'custom_tool_call');
});
ok('sseRewriteLine rewrites item events only', () => {
  const names = new Set(['exec']);
  const line = 'data: ' + JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c', name: 'exec', arguments: '{"input":"ls"}' } }) + '\n';
  const out = sseRewriteLine(line, names);
  assert(out.includes('"custom_tool_call"') && out.includes('"input":"ls"'));
  assert.strictEqual(sseRewriteLine('event: ping\n', names), 'event: ping\n');
});

// --- end-to-end against a mock strict gateway ---------------------------
const MOCK_PORT = 19876;
const PROXY_PORT = 18787;
let lastSeen = null;

function strictReject(body) {
  const known = new Set([
    'model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls',
    'stream', 'max_output_tokens', 'reasoning', 'text', 'store', 'metadata', 'temperature', 'top_p', 'user',
  ]);
  for (const k of Object.keys(body)) {
    if (!known.has(k)) return `property ${k} should not exist`;
  }
  if ('tool_choice' in body && !Array.isArray(body.tools)) return 'tool_choice requires tools to be provided';
  if (!Array.isArray(body.input) || body.input.length === 0) {
    return 'input must be a non-empty string or an array of supported message/function items';
  }
  const allowed = new Set(['message', 'function_call', 'function_call_output']);
  for (const it of body.input) {
    if (!allowed.has(it.type)) return 'input must be a non-empty string or an array of supported message/function items';
    if (it.type === 'function_call_output' && typeof it.output !== 'string') {
      return 'input must be a non-empty string or an array of supported message/function items';
    }
  }
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) if (t.type !== 'function') return `type must be one of the following values: function`;
  }
  if (body.reasoning) for (const k of Object.keys(body.reasoning)) if (k !== 'effort') return `property reasoning.${k} should not exist`;
  return null;
}

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        lastSeen = body;
        const err = strictReject(body);
        if (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err, type: 'invalid_request_error', code: 'invalid_parameter' } }));
          return;
        }
        const hasExec = Array.isArray(body.tools) && body.tools.some((t) => t.name === 'exec');
        const output = hasExec
          ? [{ type: 'function_call', call_id: 'cc1', name: 'exec', arguments: '{"input":"dir"}' }]
          : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'plain reply' }] }];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'response', status: 'completed', output }));
      });
    });
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server));
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(500, () => { s.destroy(); resolve(false); });
  });
}

async function e2e() {
  console.log('e2e: proxy in front of mock strict gateway');
  const mock = await startMock();
  const proxy = spawn(process.execPath, [path.join(__dirname, '..', 'proxy.js')], {
    env: { ...process.env, TARGET_ORIGIN: `http://127.0.0.1:${MOCK_PORT}/api`, PROXY_PORT: String(PROXY_PORT) },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 40 && !(await portOpen(PROXY_PORT)); i++) await sleep(100);
    assert(await portOpen(PROXY_PORT), 'proxy came up');

    const body = {
      model: 'test-model',
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'abc',
      reasoning: { effort: 'high', summary: 'auto' },
      tool_choice: 'auto',
      input: [
        { type: 'additional_tools', role: 'assistant', tools: [{ type: 'custom', name: 'exec', description: 'run' }] },
        { type: 'custom_tool_call', call_id: 'k1', name: 'exec', input: 'dir' },
        { type: 'custom_tool_call_output', call_id: 'k1', id: 'ctco_1', output: [{ type: 'input_image', image_url: 'data:image/png;base64,QQ==' }] },
        { type: 'reasoning', id: 'r1', summary: [] },
      ],
    };
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    ok('gateway accepted sanitized request (200)', () => assert.strictEqual(res.status, 200));
    ok('strict gateway saw no forbidden top-level params', () => {
      assert(!('include' in lastSeen) && !('prompt_cache_key' in lastSeen));
    });
    ok('strict gateway saw only function tools and valid history', () => {
      assert(lastSeen.tools.every((t) => t.type === 'function'));
      assert(lastSeen.input.every((i) => ['message', 'function_call', 'function_call_output'].includes(i.type)));
      assert(lastSeen.input.some((i) => i.type === 'message' && i.content.some((p) => p.type === 'input_image')));
      const fo = lastSeen.input.find((i) => i.type === 'function_call_output');
      assert(typeof fo.output === 'string');
      assert.strictEqual(fo.id, 'fc_1');
      assert.deepStrictEqual(lastSeen.reasoning, { effort: 'high' });
      assert('tool_choice' in lastSeen, 'tool_choice survives when tools exist');
    });
    ok('response rewritten back to custom_tool_call for Codex', () => {
      assert.strictEqual(json.output[0].type, 'custom_tool_call');
      assert.strictEqual(json.output[0].input, 'dir');
    });
  } finally {
    proxy.kill();
    mock.close();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const guard = setTimeout(() => {
    console.error('TIMEOUT');
    process.exit(1);
  }, 30000);
  await e2e();
  clearTimeout(guard);
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((f) => console.log('  ' + f));
    process.exit(1);
  }
})();
