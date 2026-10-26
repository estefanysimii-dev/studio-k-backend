import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortfolioProcessRunner } from '../server/portfolio-process.js';

const executable=process.execPath,linux=process.platform==='linux';
const freeEnv={...process.env,CONVERTER_RESOURCE_PROFILE:'wisp-free'};
const idleResources=()=>({cpu:0,workingSet:100*1024*1024});

test('converter output is bounded and nonzero exits retain a reviewable error',async()=>{
  const run=createPortfolioProcessRunner({env:{...process.env,CONVERTER_RESOURCE_PROFILE:''}});
  const result=await run(executable,['-e',"process.stdout.write('x'.repeat(16000));process.stderr.write('warning')"]);
  assert.equal(result.stdout.length,12000);assert.equal(result.stderr,'warning');
  await assert.rejects(run(executable,['-e',"process.stderr.write('invalid model');process.exit(2)"]),error=>error.status===422&&error.message==='invalid model');
  await assert.rejects(run('studio-k-processor-that-does-not-exist',[]),error=>error.status===503);
});

test('a hung converter is terminated and the runner can start a later job',async()=>{
  const run=createPortfolioProcessRunner();
  await assert.rejects(run(executable,['-e','setInterval(()=>{},1000)'],100),error=>error.status===504);
  assert.equal((await run(executable,['-e',"console.log('recovered')"])).stdout.trim(),'recovered');
});

test('free profile rejects parallel jobs and releases its slot after completion',{skip:!linux},async()=>{
  const run=createPortfolioProcessRunner({env:freeEnv,readResources:idleResources});
  const first=run(executable,['-e','setTimeout(()=>{},250)']);
  await assert.rejects(run(executable,['-e','process.exit(0)']),error=>error.status===503&&/processamento/.test(error.message));
  await first;
  assert.equal((await run(executable,['-e',"console.log('next')"])).stdout.trim(),'next');
});

test('free profile refuses missing counters or insufficient headroom before spawning',{skip:!linux},async()=>{
  for(const readResources of [()=>{throw new Error('unreadable')},()=>({cpu:0,workingSet:430*1024*1024})]){
    const run=createPortfolioProcessRunner({env:freeEnv,readResources});
    await assert.rejects(run(executable,['-e',"throw new Error('must not run')"]),error=>error.status===503);
  }
});

test('free profile stops the process group at the memory ceiling and recovers',{skip:!linux},async()=>{
  let busy=true,reads=0;
  const run=createPortfolioProcessRunner({env:freeEnv,readResources:()=>({cpu:0,workingSet:(busy&&++reads>1?460:100)*1024*1024})});
  await assert.rejects(run(executable,['-e','setInterval(()=>{},1000)']),error=>error.status===422&&/memória/.test(error.message));
  busy=false;
  assert.equal((await run(executable,['-e',"console.log('alive')"])).stdout.trim(),'alive');
});

test('free profile fails closed when resource accounting is lost during a job',{skip:!linux},async()=>{
  let reads=0;
  const run=createPortfolioProcessRunner({env:freeEnv,readResources:()=>{if(++reads>1)throw new Error('unreadable');return idleResources()}});
  await assert.rejects(run(executable,['-e','setInterval(()=>{},1000)']),error=>error.status===503&&/recursos/.test(error.message));
});

test('free profile passes bounded ImageMagick and BLAS settings to the child',{skip:!linux},async()=>{
  const run=createPortfolioProcessRunner({env:freeEnv,readResources:idleResources});
  const result=JSON.parse((await run(executable,['-e',"console.log(JSON.stringify({threads:process.env.MAGICK_THREAD_LIMIT,memory:process.env.MAGICK_MEMORY_LIMIT,blas:process.env.OPENBLAS_NUM_THREADS}))"])).stdout);
  assert.deepEqual(result,{threads:'1',memory:'48MiB',blas:'1'});
});
