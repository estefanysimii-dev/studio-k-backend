import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { openStore, AppError } from './store.js';
import { createBot } from './discord.js';
import { settingsSchema, productSchema, messageSchema, templateSchema, giveawaySchema, eventSchema, id } from './schema.js';
const demo=process.env.STUDIO_DEMO==='true',port=Number(process.env.PORT||3210),host=demo?'127.0.0.1':process.env.HOST||'127.0.0.1';
const base=new URL(process.env.PUBLIC_URL||`http://localhost:${port}`);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const store=openStore(process.env.DATA_DIR||join(root,'data')),bot=createBot(store);
const app=express(); app.disable('x-powered-by');
if(process.env.TRUST_PROXY){const value=Number(process.env.TRUST_PROXY);app.set('trust proxy',Number.isFinite(value)?value:process.env.TRUST_PROXY==='true');}
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:','https:'],connectSrc:["'self'"],upgradeInsecureRequests:process.env.COOKIE_SECURE==='true'?[]:null}},strictTransportSecurity:process.env.COOKIE_SECURE==='true'?undefined:false}));
app.use(express.json({limit:'10mb'}));
app.use('/api',(req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
app.use('/api',rateLimit({windowMs:60000,limit:200,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Muitas solicitações. Aguarde um minuto.'}}));
const loginLimit=rateLimit({windowMs:15*60000,limit:12,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Muitas tentativas. Aguarde 15 minutos.'}});
const hash=value=>createHash('sha256').update(value).digest('hex');
const setupKey=process.env.SETUP_KEY||'',setupKeyRequired=!demo&&host!=='127.0.0.1';
const cookieOptions={httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='true',path:'/',maxAge:12*3600000};
function session(req){const raw=(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('studio_session='))?.slice(15);if(!raw)return null;return store.one('SELECT * FROM sessions WHERE id=? AND expires>?',hash(raw),Date.now());}
function newSession(res){const raw=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');store.run('DELETE FROM sessions WHERE expires<?',Date.now());store.run('INSERT INTO sessions VALUES(?,?,?)',hash(raw),csrf,Date.now()+12*3600000);res.cookie('studio_session',raw,cookieOptions);return csrf;}
function sameOrigin(req,res,next){
  const allowed=new Set([base.origin]);if(host==='127.0.0.1'){allowed.add(`http://127.0.0.1:${port}`);allowed.add(`http://localhost:${port}`);}
  if(!allowed.has(req.headers.origin))return res.status(403).json({error:'Origem não autorizada.'});next();
}
app.get('/healthz',(req,res)=>res.json({ok:true}));
app.get('/api/auth', (req,res)=>{const s=session(req);res.json({authenticated:!!s,csrf:s?.csrf||null,setup:!store.get('password'),setupKeyRequired,demo});});
app.post('/api/setup',loginLimit,sameOrigin,(req,res)=>{
  if(demo)throw new AppError('Use a entrada de demonstração.');
  if(store.get('password'))throw new AppError('A senha já foi definida.',409);
  if(setupKeyRequired){
    const given=String(req.headers['x-setup-key']||'');
    if(setupKey.length<32||!timingSafeEqual(Buffer.from(hash(setupKey)),Buffer.from(hash(given))))throw new AppError('Chave de instalação inválida.',403);
  }else if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)){
    throw new AppError('Faça a primeira configuração no computador onde o bot está instalado.',403);
  }
  const password=z.string().min(12,'Use pelo menos 12 caracteres.').max(200).parse(req.body.password),salt=randomBytes(16).toString('hex');store.set('password',{salt,hash:scryptSync(password,salt,64).toString('hex')});res.json({csrf:newSession(res)});
});
app.post('/api/login',loginLimit,sameOrigin,(req,res)=>{
  if(demo){res.json({csrf:newSession(res)});return;}
  const saved=store.get('password');if(!saved)throw new AppError('Configure a senha primeiro.');
  const password=z.string().max(200).parse(req.body.password||'');const actual=scryptSync(password,saved.salt,64);
  if(!timingSafeEqual(actual,Buffer.from(saved.hash,'hex')))throw new AppError('Senha incorreta.',401);res.json({csrf:newSession(res)});
});
// Automation endpoint accepts a server-side bearer key, not browser sessions.
const integrationPending=new Set();
app.post('/api/integrations/message',async(req,res)=>{
  const secret=process.env.INTEGRATION_KEY||'',given=req.headers.authorization?.replace(/^Bearer /,'')||'';
  if(secret.length<32||!timingSafeEqual(Buffer.from(hash(secret)),Buffer.from(hash(given))))throw new AppError('Integração não autorizada.',401);
  const key=z.string().min(8).max(100).parse(req.headers['idempotency-key']);const old=store.one('SELECT result FROM requests WHERE key=?',key);if(old){res.json(JSON.parse(old.result));return;}
  if(integrationPending.has(key))throw new AppError('A solicitação já está em andamento.',409);
  integrationPending.add(key);try{const result=await bot.sendMessage(messageSchema.parse(req.body));store.run('INSERT INTO requests VALUES(?,?,?)',key,JSON.stringify(result),store.now());res.json(result);}finally{integrationPending.delete(key);}
});
app.use('/api',(req,res,next)=>{req.session=session(req);if(!req.session)return res.status(401).json({error:'Entre no painel para continuar.'});res.setHeader('Cache-Control','no-store');if(!['GET','HEAD'].includes(req.method)){return sameOrigin(req,res,()=>{if(req.headers['x-csrf-token']!==req.session.csrf)return res.status(403).json({error:'Sua sessão mudou. Atualize a página.'});next();});}next();});
app.post('/api/logout',(req,res)=>{store.run('DELETE FROM sessions WHERE id=?',req.session.id);res.clearCookie('studio_session',{path:'/'});res.json({ok:true});});
app.get('/api/state',(req,res)=>{
  const settings=store.settings(),products=store.products();const orders=store.all('SELECT * FROM orders ORDER BY created DESC LIMIT 200').map(o=>({...o,product:JSON.parse(o.product)}));
  const summary=store.one("SELECT COUNT(*) AS orders,COALESCE(SUM(CASE WHEN status IN ('paid','delivered') THEN price ELSE 0 END),0) AS revenue,SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending FROM orders");
  res.json({demo,status:bot.status(),settings,products,orders,summary,tickets:store.all('SELECT id,user_id,channel_id,category,status,created,updated,claimed_by FROM tickets ORDER BY created DESC LIMIT 200'),giveaways:store.all('SELECT * FROM giveaways ORDER BY created DESC LIMIT 100').map(g=>({...g,data:JSON.parse(g.data),entries:store.one('SELECT COUNT(*) AS n FROM entries WHERE giveaway_id=?',g.id).n})),events:store.all('SELECT * FROM events ORDER BY created DESC LIMIT 100').map(e=>({...e,data:JSON.parse(e.data)})),logs:store.all('SELECT * FROM logs ORDER BY id DESC LIMIT 100'),templates:store.all('SELECT * FROM templates ORDER BY name').map(t=>({...t,data:JSON.parse(t.data)})),lastBackup:store.get('lastBackup'),backups:readdirSync(join(store.dir,'backups')).filter(f=>f.endsWith('.json')).sort().reverse()});
});
app.get('/api/discord/metadata',async(req,res)=>res.json(await bot.metadata()));
app.put('/api/settings',(req,res)=>{const settings=settingsSchema.parse(req.body);store.set('settings',settings);store.log('configuração','Configurações atualizadas.','administrador');res.json({ok:true});});
app.post('/api/brand/apply',async(req,res)=>{await bot.applyBrand();res.json({ok:true});});
app.post('/api/messages',async(req,res)=>res.json(await bot.sendMessage(messageSchema.parse(req.body))));
app.post('/api/templates',(req,res)=>{const body=z.object({name:z.string().min(1).max(80),data:z.unknown()}).parse(req.body);const data=templateSchema.parse(body.data);const tid=randomUUID();store.run('INSERT INTO templates VALUES(?,?,?)',tid,body.name,JSON.stringify(data));res.json({id:tid});});
app.delete('/api/templates/:id',(req,res)=>{store.run('DELETE FROM templates WHERE id=?',req.params.id);res.json({ok:true});});
app.post('/api/products',(req,res)=>{const product=productSchema.parse(req.body),pid=randomUUID();store.run('INSERT INTO products VALUES(?,?,?)',pid,JSON.stringify(product),store.now());store.log('produto',`Produto criado: ${product.name}`,'administrador');res.json({id:pid});});
app.put('/api/products/:id',(req,res)=>{const product=productSchema.parse(req.body);if(!store.one('SELECT id FROM products WHERE id=?',req.params.id))throw new AppError('Produto não encontrado.',404);store.run('UPDATE products SET data=? WHERE id=?',JSON.stringify(product),req.params.id);store.log('produto',`Produto atualizado: ${product.name}`,'administrador');res.json({ok:true});});
app.post('/api/products/:id/stock',(req,res)=>{const items=z.array(z.string().trim().min(1).max(1200)).min(1).max(1000).parse(req.body.items);const product=store.one('SELECT data FROM products WHERE id=?',req.params.id);if(!product||JSON.parse(product.data).type!=='digital')throw new AppError('Escolha um produto digital.');store.transaction(()=>{for(const item of items)store.run('INSERT INTO stock(id,product_id,secret) VALUES(?,?,?)',randomUUID(),req.params.id,store.encrypt(item));});store.log('estoque',`${items.length} unidade(s) adicionadas.`,'administrador');res.json({ok:true});});
app.post('/api/products/:id/publish',async(req,res)=>res.json(await bot.publishProduct(req.params.id,id.parse(req.body.channelId))));
app.post('/api/orders',async(req,res)=>{const body=z.object({productId:z.string().uuid(),userId:id}).parse(req.body);if(!demo)await bot.member(body.userId);res.json(store.createOrder(body.productId,body.userId));});
app.post('/api/orders/:id/approve',async(req,res)=>{if(req.body.confirmed!==true)throw new AppError('Confirme que o valor chegou à sua conta.');const order=store.approveOrder(req.params.id,'administrador');res.json({ok:true,deliveryPending:order.status!=='delivered'});void bot.tick();});
app.post('/api/orders/:id/cancel',(req,res)=>{store.cancelOrder(req.params.id,'administrador');res.json({ok:true});});
app.post('/api/orders/:id/retry',async(req,res)=>{const order=store.one('SELECT * FROM orders WHERE id=?',req.params.id);if(order?.status!=='paid')throw new AppError('Este pedido não aguarda entrega.');if(!bot.status().connected)throw new AppError('Conecte o bot para tentar novamente.',503);await bot.tick();res.json({ok:true});});
app.post('/api/tickets/publish',async(req,res)=>res.json(await bot.publishPanel('tickets',id.parse(req.body.channelId))));
app.post('/api/verification/publish',async(req,res)=>res.json(await bot.publishPanel('verification',id.parse(req.body.channelId))));
app.post('/api/tickets/:id/close',async(req,res)=>{await bot.closeTicket(req.params.id,'administrador');res.json({ok:true});});
app.get('/api/tickets/:id/transcript',(req,res)=>{const t=store.one('SELECT transcript FROM tickets WHERE id=?',req.params.id);if(!t?.transcript)throw new AppError('O histórico estará disponível após encerrar o ticket.',404);res.attachment(`ticket-${req.params.id}.txt`).type('text/plain').send(t.transcript);});
app.post('/api/giveaways',async(req,res)=>res.json(await bot.createGiveaway(giveawaySchema.parse(req.body))));
app.post('/api/events',async(req,res)=>res.json(await bot.createEvent(eventSchema.parse(req.body))));
app.post('/api/backups',async(req,res)=>res.json({name:await bot.makeBackup()}));
const backupPath=name=>{if(!/^studio-k-[0-9TZ-]+\.(json|sqlite)$/.test(name))throw new AppError('Arquivo inválido.');if(!readdirSync(join(store.dir,'backups')).includes(name))throw new AppError('Backup não encontrado.',404);return join(store.dir,'backups',name);};
app.get('/api/backups/:name',(req,res)=>res.download(backupPath(req.params.name)));
app.post('/api/backups/:name/restore',(req,res)=>{if(!req.params.name.endsWith('.json')||req.body.confirmed!==true)throw new AppError('Confirme a restauração das configurações.');const backup=JSON.parse(readFileSync(backupPath(req.params.name),'utf8'));store.set('settings',settingsSchema.parse(backup.settings));store.log('backup','Configurações do painel restauradas.','administrador');res.json({ok:true});});
app.use('/api',(req,res)=>res.status(404).json({error:'Recurso não encontrado.'}));
app.use(express.static(join(root,'public'),{index:'index.html'}));
app.use((error,req,res,next)=>{if(res.headersSent)return next(error);if(error instanceof z.ZodError)return res.status(400).json({error:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('\n')});if(error instanceof AppError)return res.status(error.status).json({error:error.message});store.log('erro',`${req.method} ${req.path}: ${String(error.message).slice(0,500)}`);res.status(500).json({error:'A ação não foi concluída. Confira os registros e as permissões do bot.'});});
if(demo&&!store.get('demoSeeded')){
  const products=[{name:'Identidade visual',description:'Uma identidade pensada para a sua comunidade: logo, banner e direção visual.',priceCents:14990,type:'service',category:'Design'},{name:'Pack de overlays',description:'Elementos para deixar suas transmissões com a sua cara.',priceCents:3990,type:'digital',category:'Streaming'},{name:'Setup de servidor',description:'Organização, cargos e canais para começar do jeito certo.',priceCents:8990,type:'service',category:'Discord'}];
  for(const p of products){const pid=randomUUID();store.run('INSERT INTO products VALUES(?,?,?)',pid,JSON.stringify(productSchema.parse(p)),store.now());if(p.type==='digital')for(let i=1;i<=8;i++)store.run('INSERT INTO stock(id,product_id,secret) VALUES(?,?,?)',randomUUID(),pid,store.encrypt(`DEMONSTRAÇÃO · item ${i} · sem valor comercial`));}
  store.set('demoSeeded',true);store.log('demonstração','Catálogo de exemplo carregado. Nenhuma venda ou conexão real.');
}
const server=app.listen(port,host,()=>console.log(`Studio K ${demo?'[DEMONSTRAÇÃO]':''} · ${base.origin}`));
void bot.start();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await bot.stop();server.close(()=>{store.db.close();process.exit(0);});});
