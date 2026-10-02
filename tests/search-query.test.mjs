import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchQuery } from '../src/debate.js';

test('short single-line question passes through unchanged (no AI call needed)', async () => {
  const env = { AI: { run: async () => { throw new Error('不該被呼叫'); } } };
  const result = await buildSearchQuery(env, 'BMW i4 M60 評價');
  assert.equal(result, 'BMW i4 M60 評價');
});

test('long instruction-heavy question gets condensed via the AI before hitting Tavily', async () => {
  const env = {
    AI: {
      run: async () => ({ response: 'BMW i4 M60' }),
    },
  };
  const longQuestion = '這次請在 5 輪內務實收斂出一個大家都能接受的結論，不要無止盡發散，幫我查一下 BMW i4 M60 的實際路測評價跟續航表現，特別是冬天的表現';
  const result = await buildSearchQuery(env, longQuestion);
  assert.equal(result, 'BMW i4 M60');
});

test('falls back to a truncated version of the original question if the AI call fails', async () => {
  const env = {
    AI: {
      run: async () => {
        throw new Error('模擬 AI 呼叫失敗');
      },
    },
  };
  const longQuestion = 'x'.repeat(300);
  const result = await buildSearchQuery(env, longQuestion);
  assert.equal(result, longQuestion.slice(0, 200));
});

test('no env.AI binding falls back to truncation without throwing', async () => {
  const env = {};
  const longQuestion = '這是一段很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長的問題';
  const result = await buildSearchQuery(env, longQuestion);
  assert.equal(result, longQuestion.slice(0, 200));
});

test('empty question returns empty string', async () => {
  const env = { AI: { run: async () => { throw new Error('不該被呼叫'); } } };
  const result = await buildSearchQuery(env, '   ');
  assert.equal(result, '');
});
