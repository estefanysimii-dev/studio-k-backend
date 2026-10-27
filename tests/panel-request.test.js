import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchPanelResponse} from '../public/panel-request.js';

test('panel reads bypass browser cache without replaying a valid JSON response',async()=>{
  const calls=[];
  const result=await fetchPanelResponse('/auth',{method:'GET',headers:{Accept:'application/json'}},async(url,options)=>{
    calls.push({url,options});return Response.json({authenticated:false});
  });
  assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/auth');assert.equal(calls[0].options.cache,'no-store');
  assert.deepEqual(JSON.parse(result.text),{authenticated:false});
});

test('a cached hosting HTML page gets one fresh read with the existing query and headers preserved',async()=>{
  const calls=[],headers={'X-CSRF-Token':'session-bound-token'};
  const result=await fetchPanelResponse('/state?section=tickets',{method:'GET',headers},async(url,options)=>{
    calls.push({url,options});return calls.length===1?new Response('<html>Web server is not running</html>',{headers:{'Content-Type':'text/html'}}):Response.json({ok:true});
  });
  assert.equal(calls.length,2);const fresh=new URL(calls[1].url,'https://studio.example');
  assert.equal(fresh.pathname,'/api/state');assert.equal(fresh.searchParams.get('section'),'tickets');assert.ok(fresh.searchParams.get('_studio_refresh'));
  assert.equal(calls[1].options.cache,'no-store');assert.deepEqual(calls[1].options.headers,headers);assert.deepEqual(JSON.parse(result.text),{ok:true});
});

test('HTML failures never replay writes, including payment approval or ticket creation',async()=>{
  for(const method of ['POST','PUT','PATCH','DELETE']){
    const calls=[],body=JSON.stringify({confirmed:true});
    const result=await fetchPanelResponse('/orders/test/approve',{method,body},async(url,options)=>{
      calls.push({url,options});return new Response('<html>Gateway unavailable</html>',{status:502,headers:{'Content-Type':'text/html'}});
    });
    assert.equal(calls.length,1);assert.equal(calls[0].options.method,method);assert.equal(calls[0].options.body,body);assert.equal(result.response.status,502);
  }
});

test('persistent HTML has a bounded retry and JSON authorization errors remain unchanged',async()=>{
  let attempts=0;const result=await fetchPanelResponse('/auth',{},async()=>{attempts++;return new Response('<!doctype html><title>Offline</title>');});
  assert.equal(attempts,2);assert.match(result.text,/Offline/);
  attempts=0;const denied=await fetchPanelResponse('/state',{method:'GET'},async()=>{attempts++;return Response.json({error:'Entre no painel'},{status:401});});
  assert.equal(attempts,1);assert.equal(denied.response.status,401);
});
