import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectBatch, pollBatch, aggregateMetrics, jobMetrics } from '../worker/fastops.js';

const dev1='11111111-1111-4111-8111-111111111111';
const dev2='22222222-2222-4222-8222-222222222222';

test('batched inspection dispatches independent requests concurrently', async () => {
  const seen=[], callbacks=[];
  let active=0,maxActive=0;
  const enqueue=async(_,account,operation,args)=>{
    assert.equal(account,'account');
    active++;maxActive=Math.max(maxActive,active);
    seen.push([operation,args.device_id]);
    await new Promise(resolve=>setTimeout(resolve,20));
    active--;
    return {status:'done',result:{ok:true}};
  };
  const result=await inspectBatch({},'account',[
    {device_id:dev1,operation:'status'},
    {device_id:dev2,operation:'health'},
    {device_id:dev1,operation:'list',args:{path:'src'}}
  ],enqueue);
  assert.equal(result.count,3);
  assert.equal(maxActive,3);
  assert.deepEqual(result.items.map(v=>v.status),['done','done','done']);
});
test('batch refuses mutating or arbitrary requests before dispatch', async()=>{
  let calls=0;
  const enqueue=()=>{calls++;throw Error('should not call');};
  for(const entry of [
    {device_id:dev1,operation:'run',args:{command:'whoami'}},
    {device_id:dev1,operation:'project',args:{action:'write_file'}},
    {device_id:dev1,operation:'status',args:{approved:true}},
    {device_id:dev1,operation:'read',args:{}}
  ]) {
    await assert.rejects(()=>inspectBatch({},'account',[entry],enqueue));
  }
  assert.equal(calls,0);
});
test('batch refuses too many targets and malformed device identifiers',async()=>{
  await assert.rejects(()=>inspectBatch({},'account',Array.from({length:9},()=>({device_id:dev1,operation:'status'})),async()=>{}));
  await assert.rejects(()=>inspectBatch({},'account',[{device_id:'not-id',operation:'status'}],async()=>{}));
});
test('batch scopes user identity and returns errors per unavailable device',async()=>{
  const result=await inspectBatch({},'trusted',[{device_id:dev1,operation:'health'},{device_id:dev2,operation:'health'}],
    async(_,owner,op,args)=>{
      assert.equal(owner,'trusted');
      if(args.device_id===dev2)throw Error('Computer not found');
      return {status:'done'};
    });
  assert.deepEqual(result.items.map(i=>i.status),['done','error']);
});
test('poll_jobs retains existing job IDs and does not resubmit',async()=>{
  const result=await pollBatch({},'account',[dev1,dev2],async(_,account,id,wait)=>{
    assert.equal(account,'account');assert.equal(wait,0);
    return {job_id:id,status:'queued'};
  });
  assert.equal(result.jobs.length,2);
  assert.deepEqual(result.jobs.map(i=>i.job_id),[dev1,dev2]);
});
test('aggregated latency includes correct p50 and p95',()=>{
  const list=[100,200,300,400,500,600,700,800,900,1000].map(ms=>({operation:'screen',created:1,completed:ms+1}));
  const summary=aggregateMetrics(list);
  const row=summary.operations[0];
  assert.equal(row.count,10);assert.equal(row.p50_ms,500);assert.equal(row.p95_ms,1000);
  assert.equal(row.mean_ms,550);
});
test('job_metrics uses account filter and shows only aggregate statistics',async()=>{
  let ownerValue;
  const env={DB:{prepare:sql=>({bind:(owner)=>{ownerValue=owner;return{all:async()=>({results:[{operation:'read',created:100,completed:400}]})}}})}};
  const r=await jobMetrics(env,'expected-owner');
  assert.equal(ownerValue,'expected-owner');
  assert.equal(r.operations[0].mean_ms,300);
  assert.equal(JSON.stringify(r).includes('password'),false);
});
