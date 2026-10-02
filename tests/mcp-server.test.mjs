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
  const response = await handleMcpRequest(rpc('tools/list', {})(), env);
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /oauth-protected-resource/);
});

test('rejects a bearer token that was never issued', async () => {
  const env = { AI: { run: async () => ({ response: 'OK' }) }, council_kv: fakeKv() };
  const response = await handleMcpRequest(rpc('tools/list', {})('not-a-real-token'), env);
  assert.equal(response.status, 401);
});

test('initialize and tools/list succeed with a valid issued token', async () => {
  const env = { AI: { run: async () => ({ response: 'OK' }) }, council_kv: fakeKv() };
  const token = await issueAccessToken(env);

  const init = await (await handleMcpRequest(rpc('initialize', {})(token), env)).json();
  assert.equal(init.result.serverInfo.name, 'ai-council-mcp');

  const list = await (await handleMcpRequest(rpc('tools/list', {})(token), env)).json();
  assert.equal(list.result.tools.length, 1);
  assert.equal(list.result.tools[0].name, 'ai_council_debate');
  assert.equal(list.result.tools[0].inputSchema.required[0], 'question');
});

test('tools/call runs the council and returns a text summary', async () => {
  const env = {
    AI: { run: async () => ({ response: '這是測試回覆，包含結論內容。' }) },
    council_kv: fakeKv(),
  };
  const token = await issueAccessToken(env);
  const response = await handleMcpRequest(
    rpc('tools/call', { name: 'ai_council_debate', arguments: { question: '今天天氣如何？' } })(token),
    env
  );
  const result = await response.json();
  assert.equal(response.status, 200);
  const text = result.result.content[0].text;
  assert.match(text, /【結論】/);
  assert.match(text, /測試回覆/);
});

test('tools/call rejects an empty question without calling the AI', async () => {
  let calls = 0;
  const env = { AI: { run: async () => { calls++; return { response: 'OK' }; } }, council_kv: fakeKv() };
  const token = await issueAccessToken(env);
  const response = await handleMcpRequest(
    rpc('tools/call', { name: 'ai_council_debate', arguments: { question: '  ' } })(token),
    env
  );
  const result = await response.json();
  assert.equal(result.error.message, 'question 不能是空的');
  assert.equal(calls, 0);
});

test('unknown tool name and unknown method are reported as JSON-RPC errors', async () => {
  const env = { AI: { run: async () => ({ response: 'OK' }) }, council_kv: fakeKv() };
  const token = await issueAccessToken(env);
  const badTool = await (await handleMcpRequest(rpc('tools/call', { name: 'nope' })(token), env)).json();
  assert.equal(badTool.error.code, -32602);

  const badMethod = await (await handleMcpRequest(rpc('nope/method', {})(token), env)).json();
  assert.equal(badMethod.error.code, -32601);
});
