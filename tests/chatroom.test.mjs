import test from 'node:test';
import assert from 'node:assert/strict';
import { startChatroom, stopChatroom, getChatState, getChatLog, runChatTick } from '../src/chatroom.js';

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

function cloudflareOnlyEnv() {
  return { AI: { run: async () => ({ response: '嗨，今天天氣不錯' }) }, council_kv: fakeKv() };
}

function twoProviderEnv() {
  return {
    AI: { run: async () => ({ response: '嗨，今天天氣不錯' }) },
    council_kv: fakeKv(),
    GEMINI_API_KEY: 'mock',
  };
}

test('startChatroom rejects fewer than 2 available AIs', async () => {
  const env = cloudflareOnlyEnv();
  await assert.rejects(startChatroom(env, {}), /至少要放 2 個/);
});

test('startChatroom seeds state + a system log line; stopChatroom flips enabled off', async () => {
  const env = twoProviderEnv();
  const state = await startChatroom(env, { participants: ['cloudflare', 'gemini'] });
  assert.equal(state.enabled, true);
  assert.equal(state.participants.length, 2);

  const log = await getChatLog(env);
  assert.equal(log.length, 1);
  assert.equal(log[0].id, 'system');

  const stopped = await stopChatroom(env, 'user_requested');
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.stoppedReason, 'user_requested');

  const logAfterStop = await getChatLog(env);
  assert.equal(logAfterStop.length, 2);
});

test('runChatTick is a cheap no-op when the chatroom is off', async () => {
  const env = twoProviderEnv();
  const result = await runChatTick(env);
  assert.deepEqual(result, { skipped: true });
});

test('runChatTick appends one message from a participant other than the last speaker', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ candidates: [{ content: { parts: [{ text: '我也覺得天氣不錯' }] } }] });
  try {
    const env = twoProviderEnv();
    await startChatroom(env, { participants: ['cloudflare', 'gemini'] });

    const result = await runChatTick(env);
    assert.equal(result.ok, true);

    const log = await getChatLog(env);
    const nonSystem = log.filter((m) => m.id !== 'system');
    assert.equal(nonSystem.length, 1);

    const state = await getChatState(env);
    assert.equal(state.messageCount, 1);
    assert.equal(state.lastSpeakerId, nonSystem[0].id);
  } finally {
    globalThis.fetch = original;
  }
});

test('runChatTick auto-stops once the safety message cap is hit', async () => {
  const env = twoProviderEnv();
  await startChatroom(env, { participants: ['cloudflare', 'gemini'] });
  // 直接把 messageCount 推到安全上限，不用真的跑 300 次 tick。
  const state = await getChatState(env);
  state.messageCount = 300;
  await env.council_kv.put('chatroom:state', JSON.stringify(state));

  const result = await runChatTick(env);
  assert.equal(result.stopped, 'safety_cap');

  const after = await getChatState(env);
  assert.equal(after.enabled, false);
  assert.match(after.stoppedReason, /安全上限/);
});

test('runChatTick auto-stops after too many consecutive failures', async () => {
  const env = { AI: { run: async () => { throw new Error('mock failure'); } }, council_kv: fakeKv() };
  // 只用 cloudflare 會因為 <2 個可用 AI 被拒絕，所以手動塞一個會失敗的 provider 搭配 cloudflare。
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    env.GEMINI_API_KEY = 'mock';
    await startChatroom(env, { participants: ['cloudflare', 'gemini'] });

    let last;
    for (let i = 0; i < 5; i++) last = await runChatTick(env);
    assert.equal(last.stopped, 'consecutive_failures');

    const state = await getChatState(env);
    assert.equal(state.enabled, false);
  } finally {
    globalThis.fetch = original;
  }
});
