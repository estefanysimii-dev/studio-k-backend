import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID,createHmac } from 'node:crypto';
import express from 'express';
import { openStore } from '../server/store.js';
import { productSchema } from '../server/schema.js';
import { createPurinCash,installPurinCashWebhook } from '../server/purincash.js';

const secret='fixture-webhook-secret-only-not-a-credential';
const config={PURINCASH_ENABLED:'true',PURINCASH_API_KEY:'ps_live_fixture',PURINCASH_WEBHOOK_SECRET:secret,PUBLIC_URL:'https://studio.example.com',STUDIO_DEMO:'false'};
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'studio-k-purin-')),store=openStore(dir);t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});return store;}
function order(store){const id=randomUUID(),p=productSchema.parse({name:'Licença',type:'digital',priceCents:2990});store.run('INSERT INTO products VALUES(?,?,?)',id,JSON.stringify(p),store.now());store.run('INSERT INTO stock(id,product_id,secret) VALUES(?,?,?)',randomUUID(),id,store.encrypt('REAL-STOCK-DO-NOT-RELEASE-IN-SANDBOX'));return store.createOrder(id,'123456789012345678');}
function provider({environment='live',amount=2990,getStatus='paid',failGet=false,failPost=false}={}){
  const calls=[];
  return{calls,async fetch(url,options){calls.push({url,options});if(options.method==='POST'){if(failPost)throw new Error('network');return Response.json({paymentId:'psc_fixture',status:'pending',amountCents:amount,currency:'BRL',environment,pix:{brCode:'SANDBOX_OR_MOCK_PIX',qrCodeImage:'data:image/png;base64,AAAA'},expiresAt:new Date(Date.now()+1800000).toISOString()},{status:201});}if(failGet)throw new Error('network');return Response.json({paymentId:'psc_fixture',status:getStatus,amountCents:amount,currency:'BRL',paidAt:new Date().toISOString()});}};
}
function webhook(payments,{amount=2990,sandbox=false,event='charge.paid',signatureSecret=secret}={}){
  const body=Buffer.from(JSON.stringify({event,paymentId:'psc_fixture',status:'paid',amountCents:amount,...(sandbox?{sandbox:true}:{}),cpf:'PRIVATE-PAYER-DATA'}));
  return payments.acceptWebhook(body,{'x-webhook-id':`${event}:psc_fixture`,'x-webhook-signature':createHmac('sha256',signatureSecret).update(body).digest('hex')});
}

test('PurinCash absent, incomplete, disabled or demo config leaves manual PIX and makes no request',async t=>{
  const s=fixture(t),o=order(s);let calls=0;
  for(const env of [{},{...config,PURINCASH_ENABLED:'false'},{...config,PURINCASH_API_KEY:''},{...config,PURINCASH_WEBHOOK_SECRET:''},{...config,PUBLIC_URL:'http://localhost:3000'},{...config,STUDIO_DEMO:'true'}]){
    const p=createPurinCash({store:s,env,fetchImpl:()=>{calls++;throw new Error('must not call');}});assert.equal(p.enabled,false);assert.equal((await p.forOrders([o.id])).provider,'manual');
  }assert.equal(calls,0);
});

test('charge creation uses official contract and concurrent retries reuse the same PIX',async t=>{
  const s=fixture(t),o=order(s),api=provider(),p=createPurinCash({store:s,env:config,fetchImpl:api.fetch});
  const [first,second]=await Promise.all([p.forOrders([o.id]),p.forOrders([o.id])]);assert.deepEqual(first,second);assert.equal((await p.forOrders([o.id])).paymentId,'psc_fixture');assert.equal(api.calls.length,1);
  const call=api.calls[0],body=JSON.parse(call.options.body);assert.equal(call.url,'https://api.purincash.com/v1/charges');assert.equal(body.valueCents,2990);assert.equal(body.callbackUrl,'https://studio.example.com/api/webhooks/purincash');assert.equal(typeof body.metadata,'string');assert.equal(typeof body.expiresIn,'number');assert.ok(!JSON.stringify(first).includes(config.PURINCASH_API_KEY));
});

test('uncertain creation is never automatically POSTed a second time',async t=>{
  const s=fixture(t),o=order(s),api=provider({failPost:true}),p=createPurinCash({store:s,env:config,fetchImpl:api.fetch});
  await assert.rejects(p.forOrders([o.id]),/consultar/);await assert.rejects(p.forOrders([o.id]),/conferência/);assert.equal(api.calls.length,1);assert.equal(s.one('SELECT status FROM orders WHERE id=?',o.id).status,'pending');
});

test('checkout keeps a reviewable payment result when the provider fails',async t=>{
  const s=fixture(t),o=order(s),api=provider({failPost:true}),p=createPurinCash({store:s,env:config,fetchImpl:api.fetch});
  const payment=await p.forCheckout([o.id]);assert.equal(payment.status,'unknown');assert.equal(payment.brCode,'');assert.match(payment.instructions,/Pedido criado/);assert.equal((await p.forCheckout([o.id])).status,'unknown');assert.equal(api.calls.length,1);
});

test('an authenticated callback can recover a charge after a lost creation response',async t=>{
  const s=fixture(t),o=order(s),api=provider({failPost:true}),p=createPurinCash({store:s,env:config,fetchImpl:api.fetch});await p.forCheckout([o.id]);
  const local=s.one('SELECT id FROM purincash_charges'),event={event:'charge.paid',paymentId:'psc_fixture',amountCents:2990,status:'paid',metadata:JSON.stringify({chargeId:local.id})},body=Buffer.from(JSON.stringify(event));
  p.acceptWebhook(body,{'x-webhook-id':'charge.paid:psc_fixture','x-webhook-signature':createHmac('sha256',secret).update(body).digest('hex')});await p.processPending();assert.equal(s.one('SELECT status FROM orders WHERE id=?',o.id).status,'paid');assert.equal(api.calls.length,2);
});

test('forged signature, altered raw bytes, missing id and sandbox events in live mode cannot approve',async t=>{
  const s=fixture(t),o=order(s),api=provider(),p=createPurinCash({store:s,env:config,fetchImpl:api.fetch});await p.forOrders([o.id]);
  assert.throws(()=>webhook(p,{signatureSecret:'wrong'}),/Assinatura/);assert.throws(()=>webhook(p,{sandbox:true}),/Ambiente/);
  const body=Buffer.from('{"event":"charge.paid","paymentId":"psc_fixture","status":"paid","amountCents":2990}'),sig=createHmac('sha256',secret).update(body).digest('hex');
  assert.throws(()=>p.acceptWebhook(Buffer.concat([body,Buffer.from(' ')]),{'x-webhook-signature':sig,'x-webhook-id':'charge.paid:psc_fixture'}),/Assinatura/);
  assert.throws(()=>p.acceptWebhook(body,{'x-webhook-signature':sig}),/Evento/);assert.equal(s.one('SELECT COUNT(*) n FROM purincash_events').n,0);
});

test('signed event is independently reconciled and delivered once across webhook retries and restart',async t=>{
  const s=fixture(t),o=order(s),api=provider();let wakes=0;
  const p=createPurinCash({store:s,env:config,fetchImpl:api.fetch,wake:()=>{wakes++;}});await p.forOrders([o.id]);webhook(p);webhook(p);
  // Persisting the event precedes the API call and does not approve on its own.
  assert.equal(s.one('SELECT status FROM orders WHERE id=?',o.id).status,'pending');
  const reopened=createPurinCash({store:s,env:config,fetchImpl:api.fetch,wake:()=>{wakes++;}});await reopened.processPending();
  assert.equal(s.one('SELECT status FROM orders WHERE id=?',o.id).status,'paid');assert.equal(s.one('SELECT approved_by FROM orders WHERE id=?',o.id).approved_by,'purincash');assert.equal(wakes,1);
  webhook(reopened,{event:'payment.paid'});await reopened.processPending();assert.equal(wakes,1);assert.equal(s.one("SELECT COUNT(*) n FROM logs WHERE type='pagamento' AND actor='purincash'").n,1);
  assert.equal(s.one('SELECT COUNT(*) n FROM purincash_events').n,2);assert.ok(!JSON.stringify(s.all('SELECT * FROM purincash_events')).includes('PRIVATE-PAYER-DATA'));assert.equal(api.calls.filter(c=>!c.options.method).length,1);
});

test('mismatching signed amount never releases stock',async t=>{
  const s=fixture(t),o=order(s),api=provider(),p=createPurinCash({store:s,env:config,fetchImpl:api.fetch});await p.forOrders([o.id]);webhook(p,{amount:3000});await p.processPending();assert.equal(s.one('SELECT status FROM orders WHERE id=?',o.id).status,'pending');assert.equal(p.existingForOrder(o.id).status,'review');
});

test('mismatching API amount, currency or unpaid status never releases an order',async t=>{
  for(const changed of [{amountCents:3000},{currency:'USD'},{status:'expired'}]){
    const s=fixture(t),o=order(s),api=provider(),fetchImpl=async(url,options)=>{const response=await api.fetch(url,options);return options.method==='POST'?response:Response.json({...await response.json(),...changed});},p=createPurinCash({store:s,env:config,fetchImpl});await p.forOrders([o.id]);webhook(p);await p.processPending();assert.equal(s.one('SELECT status FROM orders WHERE id=?',o.id).status,'pending');assert.equal(p.existingForOrder(o.id).status,'review');
  }
});

test('API outage is retryable from the durable event and does not approve',async t=>{
  const s=fixture(t),o=order(s),api=provider({failGet:true}),p=createPurinCash({store:s,env:config,fetchImpl:api.fetch});await p.forOrders([o.id]);webhook(p);await p.processPending();assert.equal(s.one('SELECT status FROM orders WHERE id=?',o.id).status,'pending');const e=s.one('SELECT * FROM purincash_events');assert.equal(e.status,'pending');assert.equal(e.attempts,1);assert.ok(e.retry_at>Date.now());
});

test('cancelled cart item prevents partial auto-approval for the whole charge',async t=>{
  const s=fixture(t),a=order(s),b=order(s),api=provider({amount:5980}),p=createPurinCash({store:s,env:config,fetchImpl:api.fetch});const payment=await p.forOrders([a.id,b.id]);assert.equal(payment.amountCents,5980);assert.equal(payment.orderCount,2);s.cancelOrder(b.id);webhook(p,{amount:5980});await p.processPending();assert.equal(s.one('SELECT status FROM orders WHERE id=?',a.id).status,'pending');assert.equal(s.one('SELECT status FROM orders WHERE id=?',b.id).status,'cancelled');assert.equal(p.existingForOrder(a.id).status,'review');
});

test('sandbox simulates the charge without releasing real orders, roles or stock',async t=>{
  const s=fixture(t),o=order(s),api=provider({environment:'sandbox'});let wakes=0;const p=createPurinCash({store:s,env:{...config,PURINCASH_API_KEY:'ps_test_fixture'},fetchImpl:api.fetch,wake:()=>{wakes++;}});assert.equal((await p.forOrders([o.id])).sandbox,true);webhook(p,{sandbox:true,event:'payment.paid'});await p.processPending();assert.equal(p.existingForOrder(o.id).status,'paid');assert.equal(s.one('SELECT status FROM orders WHERE id=?',o.id).status,'pending');assert.equal(wakes,0);
});

test('HTTP webhook reads original bytes before global JSON/session middleware',async t=>{
  const s=fixture(t),o=order(s),api=provider(),p=createPurinCash({store:s,env:config,fetchImpl:api.fetch});await p.forOrders([o.id]);const app=express();installPurinCashWebhook(app,p);app.use(express.json());app.use((req,res)=>res.sendStatus(401));app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const raw=' { "event": "charge.paid", "paymentId": "psc_fixture", "status": "paid", "amountCents": 2990 } ',signature=createHmac('sha256',secret).update(raw).digest('hex');
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/webhooks/purincash`,{method:'POST',headers:{'Content-Type':'application/json','X-Webhook-Signature':signature,'X-Webhook-Id':'charge.paid:psc_fixture'},body:raw});assert.equal(response.status,202);assert.deepEqual(await response.json(),{accepted:true});await p.processPending();
});
