import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest } from '../src/mcp.js';

function fakeKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

// No ctx.waitUntil in these tests, so callDebateStartTool falls back to awaiting
// the debate synchronously (see mcp.js) — the test still observes the same
// start -> result flow a real ctx-backed deployment would go through.
const fakeCtx = undefined;

async function issueAccessToken(env) {
  // Directly seed a token the same way oauth.js's token endpoint would,
  // without re-running the whole authorize/PKCE dance in every test here
  // (that flow has its own dedicated coverage in tests/oauth.test.mjs).
  const token = 'test-access-token';
  await env.council_kv.put(`oauth:token:${token}`, JSON.stringify({ client_id: 'test-client' }));
  return token;
}

const rpc = (method, params, id = 1) =>
  (token) =>
    new Request('https://example.test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

test('rejects an unauthenticated call with 401 + WWW-Authenticate pointing at resource metadata', async () => {
  const env = { AI: { run: async () => ({ response: 'OK' }) }, council_kv: fakeKv() };
  const response = await handleMcpRequest(rpc('tools/list', {})(), env, fakeCtx);
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /oauth-protected-resource/);
});

test('rejects a bearer token that was never issued', async () => {
  const env = { AI: { run: async () => ({ response: 'OK' }) }, council_kv: fakeKv() };
  const response = await handleMcpRequest(rpc('tools/list', {})('not-a-real-token'), env, fakeCtx);
  assert.equal(response.status, 401);
});

test('initialize and tools/list succeed with a valid issued token', async () => {
  const env = { AI: { run: async () => ({ response: 'OK' }) }, council_kv: fakeKv() };
  const token = await issueAccessToken(env);

  const init = await (await handleMcpRequest(rpc('initialize', {})(token), env, fakeCtx)).json();
  assert.equal(init.result.serverInfo.name, 'ai-council-mcp');

  const list = await (await handleMcpRequest(rpc('tools/list', {})(token), env, fakeCtx)).json();
  assert.equal(list.result.tools.length, 2);
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ['ai_council_debate_start', 'ai_council_debate_result']
  );
  assert.equal(list.result.tools[0].inputSchema.required[0], 'question');
  assert.equal(list.result.tools[1].inputSchema.required[0], 'sessionId');
});

test('ai_council_debate_start runs a 2-AI roundtable to consensus and returns a watch link + sessionId', async () => {
  const original = globalThis.fetch;
  // cloudflare 跟 gemini 這兩位參與者，模擬成第一輪就都「同意」同一個版本，兩輪內結案（第一輪不檢查共識，
  // 第二輪才看大家是否都標「狀態：同意」，所以用同一份內容讓它很快收斂，測試不用真的跑很多輪）。
  globalThis.fetch = async () =>
    Response.json({ candidates: [{ content: { parts: [{ text: '狀態：同意\n這是測試回覆，包含結論內容。' }] } }] });
  try {
    const env = {
      AI: { run: async () => ({ response: '狀態：同意\n這是測試回覆，包含結論內容。' }) },
      council_kv: fakeKv(),
      GEMINI_API_KEY: 'mock',
    };
    const token = await issueAccessToken(env);
    const response = await handleMcpRequest(
      rpc('tools/call', {
        name: 'ai_council_debate_start',
        arguments: { question: '今天天氣如何？', providers: ['cloudflare', 'gemini'] },
      })(token),
      env,
      fakeCtx
    );
    const result = await response.json();
    assert.equal(response.status, 200);
    const text = result.result.content[0].text;
    assert.match(text, /watch\//);
    assert.match(text, /sessionId/);
    assert.match(text, /Cloudflare/);
    assert.match(text, /Gemini/);

    const sessionIdMatch = text.match(/sessionId：(\S+)/);
    assert.ok(sessionIdMatch);
    const sessionId = sessionIdMatch[1];

    const resultResponse = await handleMcpRequest(
      rpc('tools/call', { name: 'ai_council_debate_result', arguments: { sessionId } })(token),
      env,
      fakeCtx
    );
    const resultBody = await resultResponse.json();
    const resultText = resultBody.result.content[0].text;
    assert.match(resultText, /結案/);
    assert.match(resultText, /測試回覆/);
  } finally {
    globalThis.fetch = original;
  }
});

test('ai_council_debate_start rejects fewer than 2 available AIs', async () => {
  const env = {
    AI: { run: async () => ({ response: 'OK' }) },
    council_kv: fakeKv(), // 沒有設定任何其他 provider 的金鑰，只有 cloudflare 可用
  };
  const token = await issueAccessToken(env);
  const response = await handleMcpRequest(
    rpc('tools/call', { name: 'ai_council_debate_start', arguments: { question: '今天天氣如何？' } })(token),
    env,
    fakeCtx
  );
  const result = await response.json();
  assert.match(result.error.message, /至少要放 2 個/);
});

test('ai_council_debate_result reports an unknown sessionId without erroring', async () => {
  const env = { AI: { run: async () => ({ response: 'OK' }) }, council_kv: fakeKv() };
  const token = await issueAccessToken(env);
  const response = await handleMcpRequest(
    rpc('tools/call', { name: 'ai_council_debate_result', arguments: { sessionId: 'does-not-exist' } })(token),
    env,
    fakeCtx
  );
  const result = await response.json();
  assert.match(result.result.content[0].text, /找不到這場討論/);
});

test('ai_council_debate_start rejects an empty question without calling the AI', async () => {
  let calls = 0;
  const env = { AI: { run: async () => { calls++; return { response: 'OK' }; } }, council_kv: fakeKv() };
  const token = await issueAccessToken(env);
  const response = await handleMcpRequest(
    rpc('tools/call', { name: 'ai_council_debate_start', arguments: { question: '  ' } })(token),
    env,
    fakeCtx
  );
  const result = await response.json();
  assert.equal(result.error.message, 'question 不能是空的');
  assert.equal(calls, 0);
});

test('unknown tool name and unknown method are reported as JSON-RPC errors', async () => {
  const env = { AI: { run: async () => ({ response: 'OK' }) }, council_kv: fakeKv() };
  const token = await issueAccessToken(env);
  const badTool = await (await handleMcpRequest(rpc('tools/call', { name: 'nope' })(token), env, fakeCtx)).json();
  assert.equal(badTool.error.code, -32602);

  const badMethod = await (await handleMcpRequest(rpc('nope/method', {})(token), env, fakeCtx)).json();
  assert.equal(badMethod.error.code, -32601);
});
