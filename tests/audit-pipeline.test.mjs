import assert from "node:assert/strict";
import {runAuditBatch,runAuditBatchFallback,synthesizeAuditEvidence} from "../src/debate.js";
import {auditGroup,buildDeterministicAuditReport,planAuditBatches} from "../src/githubEngineering.js";

const report=[
  "# Audit Report",
  "## 執行摘要\n完成證據裁決。",
  "## 檢查範圍\nAudit Coverage 100% (1/1)。",
  "## 架構\n模組化架構。",
  "## 功能邏輯\n依可見程式碼核對。",
  "## 已證實問題\n無足夠證據確認重大問題。",
  "## 推測問題\n無。",
  "## 待驗證\n需執行測試。",
  "## 安全性與錯誤處理\n未執行動態測試。",
  "## 效能與可維護性\n待量測。",
  "## 測試部署風險\n未部署。",
  "## 修正建議\n先補測試。",
  "## 最終結論\n僅依靜態證據。",
].join("\n\n")+"\n\n"+"具體證據內容。".repeat(80);

function envWith(run){return {COUNCIL_A_PROVIDER:"cloudflare",COUNCIL_B_PROVIDER:"cloudflare",COUNCIL_C_PROVIDER:"cloudflare",AI:{run}};}

{
  const calls=[];
  const env=envWith(async(model)=>{calls.push(model);return {response:report};});
  const result=await synthesizeAuditEvidence({env,question:"審核",rawFiles:[{path:"evidence.md",content:"evidence"}],coverage:{pct:100,count:1,total:1}});
  assert.equal(result.complete,true);
  assert.equal(calls[0],"@cf/mistralai/mistral-small-3.1-24b-instruct");
  assert.equal(result.attempts,1);
}

{
  const calls=[];
  const env=envWith(async(model)=>{calls.push(model);if(model.includes("mistral-small"))throw new Error("busy");return {response:report};});
  const result=await synthesizeAuditEvidence({env,question:"審核",rawFiles:[{path:"evidence.md",content:"evidence"}],coverage:{pct:100,count:1,total:1}});
  assert.equal(result.complete,true);
  assert.deepEqual(calls.slice(0,2),["@cf/mistralai/mistral-small-3.1-24b-instruct","@cf/meta/llama-3.3-70b-instruct-fp8-fast"]);
}

{
  const counts=new Map();
  const env=envWith(async(model)=>{const n=(counts.get(model)||0)+1;counts.set(model,n);if(n===1)throw new Error("temporary");return {response:"## 架構與功能\nOK\n## 已證實問題\n無\n## 推測問題\n無\n## 安全性與錯誤處理\nOK\n## 效能與可維護性\nOK\n## 待跨檔驗證\n無"};});
  const result=await runAuditBatch({env,question:"審核",rawFiles:[{path:"a.js",content:"export const a=1;"}]});
  assert.equal(result.retried,true);
  assert.equal(result.aOk,true);
  assert.equal(result.bOk,true);
}

{
  const env=envWith(async(model)=>({response:`## 架構與功能\n${model}\n## 已證實問題\n無\n## 推測問題\n無\n## 安全性與錯誤處理\nOK\n## 效能與可維護性\nOK\n## 待跨檔驗證\n無`}));
  const result=await runAuditBatchFallback({env,question:"審核",rawFiles:[{path:"health.js",content:"export const ok=true;"}]});
  assert.match(result.source,/mistral-small/);
  assert.match(result.text,/已證實問題/);
}

assert.equal(auditGroup("functions/health-check.js"),"01-runtime-routing");
const planned=planAuditBatches(Array.from({length:6},(_,i)=>({path:`g${i}.js`,content:"x".repeat(40000),group:`0${i+1}-group`})));
assert.equal(planned.batches.length,3);
assert.deepEqual(planned.batches.map(x=>x.files.length),[2,2,2]);
const deterministic=buildDeterministicAuditReport({fullName:"o/r",base:"main",question:"審核",findings:[],coverage:{pct:100,count:1,total:1,skipped:[]}});
assert.match(deterministic,/Audit Coverage：100%/);
console.log("audit-pipeline tests: ok");
