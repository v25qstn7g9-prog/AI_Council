import test from 'node:test';
import assert from 'node:assert/strict';
import { runRoundtableWatchdog } from '../src/roundtable-watchdog.js';
import { createProgressSession, addActiveRoundtable, getProgress, makeProgressUpdater } from '../src/progress.js';

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

test('watchdog ignores a session that updated recently (not stalled)', async () => {
  const env = { council_kv: fakeKv() };
  const meta = { chosen: ['cloudflare', 'gemini'], labels: { cloudflare: 'Cloudflare', gemini: 'Gemini' }, baseBrief: 'brief', effectiveMaxRounds: 5 };
  const sessionId = await createProgressSession(env, { question: 'Q', participants: [], meta });
  await addActiveRoundtable(env, sessionId);
  const updateProgress = makeProgressUpdater(env, sessionId);
  await updateProgress({ stage: 'round', round: 1, entries: [{ id: 'cloudflare', label: 'Cloudflare', status: 'ok', text: 'hi' }], consensus: false });

  const result = await runRoundtableWatchdog(env);
  assert.equal(result.checked, 1);
  assert.equal(result.resumed, 0);
  const progress = await getProgress(env, sessionId);
  assert.equal(progress.status, 'running');
});

test('watchdog resumes a stalled session by running the next round', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ candidates: [{ content: { parts: [{ text: '狀態：同意\n這是測試回覆，包含結論內容。' }] } }] });
  try {
    const env = { council_kv: fakeKv(), AI: { run: async () => ({ response: '狀態：同意\n這是測試回覆，包含結論內容。' }) }, GEMINI_API_KEY: 'mock' };
    const meta = { chosen: ['cloudflare', 'gemini'], labels: { cloudflare: 'Cloudflare', gemini: 'Gemini' }, baseBrief: 'brief', effectiveMaxRounds: 5 };
    const sessionId = await createProgressSession(env, { question: 'Q', participants: [], meta });
    await addActiveRoundtable(env, sessionId);
    const updateProgress = makeProgressUpdater(env, sessionId);
    await updateProgress({ stage: 'round', round: 1, entries: [{ id: 'cloudflare', label: 'Cloudflare', status: 'ok', text: '第一輪意見' }, { id: 'gemini', label: 'Gemini', status: 'ok', text: '第一輪意見' }], consensus: false });

    // 手動把 updatedAt 往回調，模擬「已經卡住超過 100 秒沒動靜」
    const stale = await getProgress(env, sessionId);
    stale.updatedAt = Date.now() - 200 * 1000;
    await env.council_kv.put(`progress:${sessionId}`, JSON.stringify(stale));

    const result = await runRoundtableWatchdog(env);
    assert.equal(result.resumed, 1);

    const progress = await getProgress(env, sessionId);
    assert.equal(progress.round, 2);
    assert.equal(progress.status, 'done'); // 兩個參與者這輪都回「狀態：同意」，接手這輪後就結案
  } finally {
    globalThis.fetch = original;
  }
});

test('watchdog cleans up a session with no meta (not a roundtable / stale schema)', async () => {
  const env = { council_kv: fakeKv() };
  const sessionId = await createProgressSession(env, { question: 'Q', participants: [] }); // 沒給 meta
  await addActiveRoundtable(env, sessionId);

  const result = await runRoundtableWatchdog(env);
  assert.equal(result.cleaned, 1);
});
