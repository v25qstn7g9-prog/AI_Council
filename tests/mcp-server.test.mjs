import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest } from '../src/mcp.js';

const rpc = (method, params, id = 1) =>
  new Request('https://example.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

test('rejects when MCP_TOKEN is not configured', async () => {
  const env = { AI: { run: async () => ({ response: 'OK' }) } };
  const response = await handleMcpRequest(rpc('tools/list', {}), env);
  assert.equal(response.status, 403);
});

test('rejects a wrong bearer token', async () => {
  const env = { AI: { run: async () => ({ response: 'OK' }) }, MCP_TOKEN: 'secret-token' };
  const request = new Request('https://example.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const response = await handleMcpRequest(request, env);
  assert.equal(response.status, 401);
});

test('initialize and tools/list succeed with the correct token', async () => {
  const env = { AI: { run: async () => ({ response: 'OK' }) }, MCP_TOKEN: 'secret-token' };

  const init = await (await handleMcpRequest(rpc('initialize', {}), env)).json();
  assert.equal(init.result.serverInfo.name, 'ai-council-mcp');

  const list = await (await handleMcpRequest(rpc('tools/list', {}), env)).json();
  assert.equal(list.result.tools.length, 1);
  assert.equal(list.result.tools[0].name, 'ai_council_debate');
  assert.equal(list.result.tools[0].inputSchema.required[0], 'question');
});

test('tools/call runs the council and returns a text summary', async () => {
  const env = {
    AI: { run: async () => ({ response: '這是測試回覆，包含結論內容。' }) },
    MCP_TOKEN: 'secret-token',
  };
  const response = await handleMcpRequest(
    rpc('tools/call', { name: 'ai_council_debate', arguments: { question: '今天天氣如何？' } }),
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
  const env = { AI: { run: async () => { calls++; return { response: 'OK' }; } }, MCP_TOKEN: 'secret-token' };
  const response = await handleMcpRequest(
    rpc('tools/call', { name: 'ai_council_debate', arguments: { question: '  ' } }),
    env
  );
  const result = await response.json();
  assert.equal(result.error.message, 'question 不能是空的');
  assert.equal(calls, 0);
});

test('unknown tool name and unknown method are reported as JSON-RPC errors', async () => {
  const env = { AI: { run: async () => ({ response: 'OK' }) }, MCP_TOKEN: 'secret-token' };
  const badTool = await (await handleMcpRequest(rpc('tools/call', { name: 'nope' }), env)).json();
  assert.equal(badTool.error.code, -32602);

  const badMethod = await (await handleMcpRequest(rpc('nope/method', {}), env)).json();
  assert.equal(badMethod.error.code, -32601);
});
