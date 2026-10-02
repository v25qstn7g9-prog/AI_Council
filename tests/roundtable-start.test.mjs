import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRoundtableStart } from '../src/roundtable-start.js';

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

// 沒有 ctx.waitUntil 時，handleRoundtableStart 退化成同步等待（跟 mcp.js 同一套模式）。
const fakeCtx = undefined;

function req(body, headers = {}) {
  return new Request('https://example.test/roundtable/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('starts a 2-AI roundtable without any auth and returns sessionId + watchUrl', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ candidates: [{ content: { parts: [{ text: '狀態：同意\n這是測試回覆，包含結論內容。' }] } }] });
  try {
    const env = {
      AI: { run: async () => ({ response: '狀態：同意\n這是測試回覆，包含結論內容。' }) },
      council_kv: fakeKv(),
      GEMINI_API_KEY: 'mock',
    };
    const response = await handleRoundtableStart(
      req({ question: '今天天氣如何？', providers: ['cloudflare', 'gemini'] }),
      env,
      fakeCtx
    );
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.ok(result.sessionId);
    assert.match(result.watchUrl, /\/watch\//);
    assert.equal(result.participants.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('rejects an empty question', async () => {
  const env = { AI: { run: async () => ({ response: 'OK' }) }, council_kv: fakeKv() };
  const response = await handleRoundtableStart(req({ question: '  ' }), env, fakeCtx);
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.match(result.error, /問題/);
});

test('rejects fewer than 2 available AIs', async () => {
  const env = { AI: { run: async () => ({ response: 'OK' }) }, council_kv: fakeKv() };
  const response = await handleRoundtableStart(req({ question: '今天天氣如何？' }), env, fakeCtx);
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.match(result.error, /至少要放 2 個/);
});

test('rate limit kicks in when COUNCIL_RATE_LIMIT is exceeded', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ candidates: [{ content: { parts: [{ text: '狀態：同意\n這是測試回覆，包含結論內容。' }] } }] });
  try {
    const env = {
      AI: { run: async () => ({ response: '狀態：同意\n這是測試回覆，包含結論內容。' }) },
      council_kv: fakeKv(),
      GEMINI_API_KEY: 'mock',
      COUNCIL_RATE_LIMIT: '1:1800',
    };
    const ipHeaders = { 'cf-connecting-ip': '1.2.3.4' };
    const first = await handleRoundtableStart(req({ question: 'Q1', providers: ['cloudflare', 'gemini'] }, ipHeaders), env, fakeCtx);
    assert.equal(first.status, 200);

    const second = await handleRoundtableStart(req({ question: 'Q2', providers: ['cloudflare', 'gemini'] }, ipHeaders), env, fakeCtx);
    assert.equal(second.status, 429);
    const result = await second.json();
    assert.match(result.error, /頻繁/);
  } finally {
    globalThis.fetch = original;
  }
});
