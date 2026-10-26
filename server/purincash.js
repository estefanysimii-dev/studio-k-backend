import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import express from 'express';
import { AppError } from './store.js';

const API='https://api.purincash.com';
const paidEvents=new Set(['charge.paid','payment.paid']);
function publicPayment(row){
  const status=row.status==='pending'&&Date.parse(row.expires_at)<=Date.now()?'expired':row.status;
  return{provider:'purincash',paymentId:row.provider_id||'',status,amountCents:row.amount_cents,orderCount:JSON.parse(row.order_ids).length,
    brCode:status==='pending'?row.br_code:'',qrCodeImage:status==='pending'?row.qr_image:null,expiresAt:row.expires_at||'',
    sandbox:row.environment==='sandbox',pixKey:'',recipient:'',
    instructions:status==='paid'?(row.environment==='sandbox'?'Simulação confirmada. Nenhum pedido real foi liberado.':'Pagamento confirmado.'):
      status!=='pending'?'Pedido criado. A cobrança precisa de conferência da equipe. Não faça outro pagamento nem crie outro pedido.':
      row.environment==='sandbox'?'PIX de teste. Não envie dinheiro.':'Pague o código PIX. A confirmação será automática.'};
}

export function validPurinCashSignature(raw,signature,secret){
  if(!Buffer.isBuffer(raw)||!secret||!/^[a-f0-9]{64}$/i.test(String(signature||'')))return false;
  const expected=createHmac('sha256',secret).update(raw).digest();
  return timingSafeEqual(expected,Buffer.from(signature,'hex'));
}

// API keys and webhook secrets stay in the process environment, never in settings or responses.
export function createPurinCash({store,env=process.env,fetchImpl=fetch,wake=()=>{}}){
  const apiKey=String(env.PURINCASH_API_KEY||'').trim(),secret=String(env.PURINCASH_WEBHOOK_SECRET||'').trim();
  let callbackUrl='';
  try{const u=new URL('/api/webhooks/purincash',env.PUBLIC_URL);if(u.protocol==='https:'&&!u.username&&!u.password&&u.hostname.includes('.')&&!/^\d[\d.]+$/.test(u.hostname)&&!u.hostname.endsWith('.localhost'))callbackUrl=u.href;}catch{}
  const enabled=env.PURINCASH_ENABLED==='true'&&env.STUDIO_DEMO!=='true'&&/^ps_(test|live)_\S+$/.test(apiKey)&&!!secret&&!!callbackUrl;
  const environment=apiKey.startsWith('ps_test_')?'sandbox':'live';
  const creating=new Map();let processing=false;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS purincash_charges(
      id TEXT PRIMARY KEY,provider_id TEXT UNIQUE,order_ids TEXT NOT NULL,amount_cents INTEGER NOT NULL,
      environment TEXT NOT NULL,status TEXT NOT NULL,br_code TEXT NOT NULL DEFAULT '',
      qr_image TEXT,expires_at TEXT,created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purincash_order_links(order_id TEXT PRIMARY KEY,charge_id TEXT NOT NULL REFERENCES purincash_charges(id));
    CREATE TABLE IF NOT EXISTS purincash_events(
      id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,event TEXT NOT NULL,amount_cents INTEGER NOT NULL,
      sandbox INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL
    );
  `);
  if(env.PURINCASH_ENABLED==='true'&&!enabled)store.log('pagamento','PurinCash inativa: confira a configuração completa do servidor. O Pix manual continua disponível.');
  const manual=()=>{const s=store.settings().sales;return{provider:'manual',pixKey:s.pixKey||'',recipient:s.recipient||'',instructions:s.instructions||''};};
  async function request(path,options={}){
    let response;
    try{response=await fetchImpl(API+path,{...options,headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(8000),redirect:'error'});}
    catch{throw new AppError('Não foi possível consultar a PurinCash. Confira o pedido antes de tentar outra cobrança.',503);}
    if(!response.ok)throw new AppError('A PurinCash não concluiu a solicitação. Confira a configuração e o pedido.',response.status===429?503:502);
    try{return await response.json();}catch{throw new AppError('Resposta inválida da PurinCash.',502);}
  }
  function ordersFor(ids){
    if(!Array.isArray(ids)||!ids.length||ids.length>20||new Set(ids).size!==ids.length)throw new AppError('Pedidos inválidos.');
    const orders=ids.map(id=>store.one('SELECT * FROM orders WHERE id=?',id));
    if(orders.some(o=>!o))throw new AppError('Pedido não encontrado.',404);
    if(new Set(orders.map(o=>o.user_id)).size!==1)throw new AppError('Os pedidos devem pertencer ao mesmo cliente.');
    return orders;
  }
  async function createCharge(ids){
    const orders=ordersFor(ids),amount=orders.reduce((sum,o)=>sum+Number(o.price),0);
    if(orders.some(o=>o.status!=='pending'||Date.parse(o.expires)<=Date.now()))throw new AppError('Este pedido foi encerrado ou expirou.',409);
    if(!Number.isSafeInteger(amount)||amount<80||amount>100000000000)throw new AppError('O PIX automático aceita valores a partir de R$ 0,80. Contate a equipe.',409);
    const links=ids.map(id=>store.one('SELECT c.* FROM purincash_order_links l JOIN purincash_charges c ON c.id=l.charge_id WHERE l.order_id=?',id));
    if(links.some(Boolean)){
      const row=links[0];
      if(!row||links.some(x=>!x||x.id!==row.id)||row.order_ids!==JSON.stringify(ids)||row.amount_cents!==amount||row.environment!==environment)throw new AppError('O pedido já possui outra cobrança. Contate a equipe.',409);
      if(row.status==='pending'&&Date.parse(row.expires_at)>Date.now())return publicPayment(row);
      throw new AppError('A cobrança precisa de conferência. Não gere outro PIX para este pedido.',409);
    }
    const id=randomUUID(),expiresIn=Math.min(604800,Math.floor((Math.min(...orders.map(o=>Date.parse(o.expires)))-Date.now())/1000));
    if(expiresIn<60)throw new AppError('O pedido está perto de expirar. Contate a equipe.',409);
    store.transaction(()=>{
      store.run('INSERT INTO purincash_charges(id,order_ids,amount_cents,environment,status,created) VALUES(?,?,?,?,?,?)',id,JSON.stringify(ids),amount,environment,'creating',store.now());
      for(const orderId of ids)store.run('INSERT INTO purincash_order_links VALUES(?,?)',orderId,id);
    });
    try{
      const result=await request('/v1/charges',{method:'POST',body:JSON.stringify({valueCents:amount,
        description:`Studio K · ${ids.length===1?'Pedido '+ids[0].slice(0,8):'Carrinho · '+ids.length+' itens'}`,
        expiresIn,callbackUrl,metadata:JSON.stringify({chargeId:id})})});
      if(!/^psc_[A-Za-z0-9_-]+$/.test(result.paymentId||'')||result.status!=='pending'||result.amountCents!==amount||result.currency!=='BRL'||result.environment!==environment||!result.pix?.brCode||typeof result.pix.brCode!=='string'||result.pix.brCode.length>4096||!Number.isFinite(Date.parse(result.expiresAt)))throw new AppError('A cobrança retornou dados incompatíveis. Contate a equipe antes de tentar novamente.',502);
      const image=typeof result.pix.qrCodeImage==='string'&&result.pix.qrCodeImage.length<200000?result.pix.qrCodeImage:null;
      store.run("UPDATE purincash_charges SET provider_id=?,status=CASE WHEN status IN ('creating','unknown') THEN 'pending' ELSE status END,br_code=?,qr_image=?,expires_at=? WHERE id=? AND (provider_id IS NULL OR provider_id=?)",result.paymentId,result.pix.brCode,image,result.expiresAt,id,result.paymentId);
      return publicPayment(store.one('SELECT * FROM purincash_charges WHERE id=?',id));
    }catch(error){
      // A timeout may have happened AFTER the provider created the charge. Never retry POST automatically.
      store.run("UPDATE purincash_charges SET status='unknown' WHERE id=? AND status='creating'",id);
      store.log('pagamento',`Cobrança PurinCash ${id.slice(0,8)} precisa de conferência; nenhuma entrega foi liberada.`);
      throw error;
    }
  }
  async function forOrders(ids){
    if(!enabled)return manual();
    const key=[...ids].sort().join(':');
    if(creating.has(key))return creating.get(key);
    const promise=createCharge([...ids].sort());creating.set(key,promise);
    try{return await promise;}finally{creating.delete(key);}
  }
  function acceptWebhook(raw,headers){
    if(!enabled)throw new AppError('PurinCash não configurada.',503);
    if(!validPurinCashSignature(raw,headers['x-webhook-signature'],secret))throw new AppError('Assinatura inválida.',401);
    let event;try{event=JSON.parse(raw.toString('utf8'));}catch{throw new AppError('JSON inválido.');}
    if(!event||typeof event!=='object'||Array.isArray(event))throw new AppError('Evento inválido.');
    if(!paidEvents.has(event.event))return{ignored:true};
    const eventId=String(headers['x-webhook-id']||'');
    if(typeof event.paymentId!=='string'||event.paymentId.length>200||!/^psc_[A-Za-z0-9_-]+$/.test(event.paymentId)||eventId!==`${event.event}:${event.paymentId}`||event.status!=='paid'||!Number.isSafeInteger(event.amountCents)||event.amountCents<80)throw new AppError('Evento de pagamento inválido.');
    if((event.sandbox===true)!==(environment==='sandbox'))throw new AppError('Ambiente de pagamento incorreto.',409);
    const charge=store.one('SELECT id FROM purincash_charges WHERE provider_id=?',event.paymentId);
    if(!charge){
      // The callback can beat the creation response or arrive after a POST timeout.
      // Link only our server-generated metadata on an authenticated event; GET still verifies payment.
      let localId='';try{localId=JSON.parse(event.metadata||'{}').chargeId||'';}catch{}
      if(typeof localId==='string'&&/^[a-f0-9-]{36}$/i.test(localId))store.run("UPDATE purincash_charges SET provider_id=? WHERE id=? AND provider_id IS NULL AND amount_cents=? AND environment=? AND status IN ('creating','unknown')",event.paymentId,localId,event.amountCents,environment);
    }
    // Store only reconciliation fields. Payer CPF/name and raw event bodies are deliberately excluded.
    store.run('INSERT OR IGNORE INTO purincash_events(id,provider_id,event,amount_cents,sandbox,created) VALUES(?,?,?,?,?,?)',eventId,event.paymentId,event.event,event.amountCents,event.sandbox===true?1:0,store.now());
    return{accepted:true};
  }
  function review(eventId,chargeId){
    store.transaction(()=>{store.run("UPDATE purincash_events SET status='review' WHERE id=?",eventId);store.run("UPDATE purincash_charges SET status='review' WHERE id=? AND status<>'paid'",chargeId);});
    store.log('pagamento',`Cobrança PurinCash ${chargeId.slice(0,8)} retida para conferência. Nenhuma nova entrega liberada.`);
  }
  async function processPending(){
    if(!enabled||processing)return;processing=true;
    try{
      for(const event of store.all("SELECT * FROM purincash_events WHERE status='pending' AND retry_at<=? ORDER BY created LIMIT 10",Date.now())){
        const charge=store.one('SELECT * FROM purincash_charges WHERE provider_id=?',event.provider_id);
        if(!charge){
          store.run('UPDATE purincash_events SET status=?,retry_at=? WHERE id=?',Date.parse(event.created)<Date.now()-86400000?'ignored':'pending',Date.now()+60000,event.id);
          continue;
        }
        if(charge.status==='paid'){store.run("UPDATE purincash_events SET status='done' WHERE id=?",event.id);continue;}
        try{
          const verified=await request(`/v1/charges/${encodeURIComponent(event.provider_id)}`);
          if(verified.paymentId!==charge.provider_id||verified.amountCents!==charge.amount_cents||event.amount_cents!==charge.amount_cents||verified.currency!=='BRL'||charge.environment!==environment){review(event.id,charge.id);continue;}
          if(verified.status==='pending')throw new AppError('A confirmação ainda não está disponível.',503);
          if(verified.status!=='paid'){review(event.id,charge.id);continue;}
          if(environment==='sandbox'){
            // A simulated payment must never release a real stock unit or Discord role.
            store.transaction(()=>{store.run("UPDATE purincash_charges SET status='paid' WHERE id=?",charge.id);store.run("UPDATE purincash_events SET status='done' WHERE id=?",event.id);});
            store.log('pagamento',`Simulação PurinCash ${charge.id.slice(0,8)} confirmada. Pedido e estoque reais não foram liberados.`);
            continue;
          }
          const orders=ordersFor(JSON.parse(charge.order_ids));
          if(orders.reduce((sum,o)=>sum+Number(o.price),0)!==charge.amount_cents||orders.some(o=>!['pending','paid','delivered'].includes(o.status)||(o.status==='pending'&&Date.parse(o.expires)<=Date.now()))){review(event.id,charge.id);continue;}
          store.transaction(()=>{
            // Re-read under SQLite's write lock. Cancellation/manual approval cannot race this transition.
            const current=ordersFor(JSON.parse(charge.order_ids));
            if(current.some(o=>!['pending','paid','delivered'].includes(o.status)||(o.status==='pending'&&Date.parse(o.expires)<=Date.now())))throw new AppError('Pedido alterado durante a confirmação.',409);
            for(const order of current)if(order.status==='pending'){
              store.run("UPDATE orders SET status='paid',approved_by='purincash',approved_at=? WHERE id=?",store.now(),order.id);
              store.log('pagamento',`Pix confirmado pela PurinCash: ${order.id.slice(0,8)}`,'purincash',{orderId:order.id,paymentId:charge.provider_id});
            }
            store.run("UPDATE purincash_charges SET status='paid' WHERE id=?",charge.id);
            store.run("UPDATE purincash_events SET status='done' WHERE id=?",event.id);
          });
          try{await wake();}catch{/* Existing delivery tick retries independently. */}
        }catch{
          const attempts=event.attempts+1;
          store.run('UPDATE purincash_events SET attempts=?,retry_at=? WHERE id=?',attempts,Date.now()+Math.min(3600000,15000*2**Math.min(attempts,8)),event.id);
        }
      }
    }finally{processing=false;}
  }
  const existingForOrder=id=>{const row=store.one('SELECT c.* FROM purincash_order_links l JOIN purincash_charges c ON c.id=l.charge_id WHERE l.order_id=?',id);return row?publicPayment(row):null;};
  async function forCheckout(ids){
    try{return await forOrders(ids);}catch{
      // Keep the created order IDs in the checkout response, even if the provider is unavailable.
      const existing=existingForOrder(ids[0]);if(existing)return existing;
      return{provider:'purincash',status:'unavailable',paymentId:'',brCode:'',qrCodeImage:null,expiresAt:'',sandbox:environment==='sandbox',pixKey:'',recipient:'',instructions:'Pedido criado. Não foi possível gerar o PIX. Consulte a equipe com o número deste pedido antes de tentar novamente.'};
    }
  }
  return{enabled,forOrders,forCheckout,acceptWebhook,processPending,existingForOrder};
}

// Register BEFORE the application's JSON parser and session/CSRF middleware.
export function installPurinCashWebhook(app,payments){
  app.post('/api/webhooks/purincash',express.raw({type:'application/json',limit:'64kb'}),(req,res)=>{
    const result=payments.acceptWebhook(req.body,req.headers);res.status(202).json(result);
    void payments.processPending();
  });
}
