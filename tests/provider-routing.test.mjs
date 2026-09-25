import test from 'node:test';
import assert from 'node:assert/strict';
import {councilModelConfig,configureCouncil,onRequestPost} from '../src/debate.js';

const request=(body)=>new Request('https://example.test/debate',{method:'POST',body:JSON.stringify({question:'請解釋此方案的優缺點',chatMode:true,...body})});

test('configuration exposes availability, never secret values; rejects invalid routes',async()=>{
  const env={AI:{run:async()=>({response:'OK'})},GEMINI_API_KEY:'private-test-secret'};
  const config=await councilModelConfig(env);
  assert(!JSON.stringify(config).includes('private-test-secret'));
  assert(config.providers.find(p=>p.id==='gemini').available);
  await assert.rejects(configureCouncil(env,{primary:'openai'}),e=>e.status===400);
  await assert.rejects(configureCouncil(env,{primary:'gemini',backup:'gemini'}),e=>e.status===400);
  await assert.rejects(configureCouncil(env,{primary:'https://untrusted.example'}),e=>e.status===400);
});

test('failed primary switches to backup once and preserves the question and history',async()=>{
  const original=globalThis.fetch;let requests=0;const calls=[];
  globalThis.fetch=async()=>{requests++;return new Response('rate limited',{status:429});};
  try{
    const env={AI:{run:async(model,input)=>{calls.push({model,input});return {response:'備援回答'};}},GEMINI_API_KEY:'mock'};
    const body={routing:{primary:'gemini',backup:'cloudflare'},history:[{who:'you',text:'請保持繁體中文'}]};
    const response=await onRequestPost({request:request(body),env});const result=await response.json();
    assert.equal(response.status,200);assert.equal(result.a,'備援回答');assert.equal(result.b,'備援回答');
    assert.match(result.labels.a,/備援/);assert.match(result.labels.b,/備援/);assert.equal(requests,1);
    assert(calls[0].input.messages[1].content.includes('請保持繁體中文'));
    assert.equal(calls[0].input.max_tokens,1800);assert.equal(calls[1].input.max_tokens,1400);
    await onRequestPost({request:request(body),env});assert.equal(requests,2,'new request retries primary');
  }finally{globalThis.fetch=original;}
});

test('Cloudflare outage switches to configured Gemini for both collaborators',async()=>{
  const original=globalThis.fetch;let cloudCalls=0,geminiCalls=0;
  globalThis.fetch=async()=>{geminiCalls++;return Response.json({candidates:[{content:{parts:[{text:'Gemini 回答'}]}}]});};
  try{
    const env={AI:{run:async()=>{cloudCalls++;throw Error('429');}},GEMINI_API_KEY:'mock'};
    const result=await (await onRequestPost({request:request({routing:{primary:'cloudflare',backup:'gemini'}}),env})).json();
    assert.equal(result.a,'Gemini 回答');assert.equal(result.b,'Gemini 回答');assert.equal(cloudCalls,1);assert.equal(geminiCalls,2);
  }finally{globalThis.fetch=original;}
});

test('reviewer failure retains the completed primary answer',async()=>{
  let count=0;const env={AI:{run:async()=>{if(++count===1)return {response:'主答保留'};throw Error('unavailable');}}};
  const result=await(await onRequestPost({request:request({}),env})).json();
  assert.equal(result.a,'主答保留');assert.equal(result.partial,true);assert.match(result.b,/主答已保留/);
});

test('complete outage gives an error without leaking upstream details',async()=>{
  const env={AI:{run:async()=>{throw Error('secret=do-not-show');}}};
  const response=await onRequestPost({request:request({}),env});const result=await response.json();
  assert.equal(response.status,500);assert(!JSON.stringify(result).includes('do-not-show'));
});
