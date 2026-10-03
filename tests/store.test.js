import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../server/store.js';
import { defaults, settingsSchema, productSchema, messageSchema, embedSchema } from '../server/schema.js';
import { embedPayload } from '../server/discord.js';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'studio-k-test-')),s=openStore(dir);t.after(()=>{s.db.close();rmSync(dir,{recursive:true,force:true});});return s;}
function product(s,type='digital'){const id=randomUUID(),p=productSchema.parse({name:'Produto teste',priceCents:2990,type});s.run('INSERT INTO products VALUES(?,?,?)',id,JSON.stringify(p),s.now());return id;}
function stock(s,id,secret='CHAVE-UNICA'){s.run('INSERT INTO stock(id,product_id,secret) VALUES(?,?,?)',randomUUID(),id,s.encrypt(secret));}
test('defaults are complete and validate',()=>{assert.equal(defaults.brand.name,'Studio K');assert.equal(defaults.welcome.embed.color,'#995cff');assert.equal(defaults.messageStyles.ticketPanel.embed.title,'Como podemos ajudar?');assert.equal(defaults.messageStyles.ticketStaffPanel.embed.title,'Painel da equipe');assert.equal(defaults.messageStyles.orderDelivery.embed.title,'Compra aprovada · {product}');assert.equal(defaults.messageStyles.feedback.embed.title,'💜 Novo feedback · {source}');assert.equal(defaults.voicePresence.enabled,false);assert.equal(defaults.translator.enabled,false);assert.deepEqual(settingsSchema.parse(defaults),defaults);});
test('reserve last unit atomically, cancellation releases stock',t=>{const s=fixture(t),pid=product(s);stock(s,pid);const a=s.createOrder(pid,'123456789012345678');assert.equal(s.products()[0].stock,0);assert.throws(()=>s.createOrder(pid,'223456789012345678'),/sem estoque/);s.cancelOrder(a.id);assert.equal(s.products()[0].stock,1);assert.ok(s.createOrder(pid,'223456789012345678'));});
test('cancelled coupon order releases global and per-user quota',t=>{
  const s=fixture(t),pid=product(s,'service'),uid='123456789012345678',code='STUDIO10';
  s.run('INSERT INTO coupons(code,type,value,active,max_uses,uses,per_user,created) VALUES(?,?,?,?,?,?,?,?)',code,'percent',10,1,1,0,1,s.now());
  const first=s.createOrder(pid,uid,code);
  assert.equal(s.one('SELECT uses FROM coupons WHERE code=?',code).uses,1);
  assert.equal(s.one('SELECT COUNT(*) AS n FROM coupon_uses WHERE code=? AND user_id=?',code,uid).n,1);
  assert.throws(()=>s.createOrder(pid,uid,code),/limite/);
  s.cancelOrder(first.id);
  assert.equal(s.one('SELECT uses FROM coupons WHERE code=?',code).uses,0);
  assert.equal(s.one('SELECT COUNT(*) AS n FROM coupon_uses WHERE code=? AND user_id=?',code,uid).n,0);
  const second=s.createOrder(pid,uid,code);
  assert.equal(second.coupon_code,code);
  assert.equal(s.one('SELECT uses FROM coupons WHERE code=?',code).uses,1);
});
test('approval is idempotent and records the real approval time',t=>{const s=fixture(t),pid=product(s);stock(s,pid);const a=s.createOrder(pid,'123456789012345678');const approved=s.approveOrder(a.id,'admin');assert.ok(approved.approved_at);assert.ok(Date.parse(approved.approved_at)>=Date.parse(a.created));s.approveOrder(a.id,'admin');assert.equal(s.one("SELECT COUNT(*) AS n FROM logs WHERE type='pagamento'").n,1);assert.equal(s.one('SELECT COUNT(*) AS n FROM stock WHERE order_id=?',a.id).n,1);assert.throws(()=>s.cancelOrder(a.id),/pendentes/);});
test('expired and cancelled orders cannot be approved',t=>{const s=fixture(t),pid=product(s,'service'),o=s.createOrder(pid,'123456789012345678');s.run('UPDATE orders SET expires=? WHERE id=?','2020-01-01T00:00:00.000Z',o.id);assert.throws(()=>s.approveOrder(o.id,'admin'),/expirou/);s.cancelOrder(o.id);assert.throws(()=>s.approveOrder(o.id,'admin'),/encerrado/);});
test('order keeps original price and role snapshot after product edits',t=>{const s=fixture(t),pid=product(s,'service'),o=s.createOrder(pid,'123456789012345678');s.run('UPDATE products SET data=? WHERE id=?',JSON.stringify(productSchema.parse({name:'Novo preço',priceCents:100,type:'service'})),pid);assert.equal(o.price,2990);assert.equal(JSON.parse(o.product).name,'Produto teste');});
test('stock encryption detects tampering and survives restart',t=>{const s=fixture(t),value=s.encrypt('SEGREDO');assert.equal(s.decrypt(value),'SEGREDO');assert.ok(!value.includes('SEGREDO'));const bytes=Buffer.from(value,'base64');bytes[30]^=1;assert.throws(()=>s.decrypt(bytes.toString('base64')));const second=openStore(s.dir);assert.equal(second.decrypt(value),'SEGREDO');second.db.close();});
test('giveaway winners unique and fixed on retries',t=>{const s=fixture(t),id=randomUUID();s.run('INSERT INTO giveaways(id,data,status,created) VALUES(?,?,?,?)',id,JSON.stringify({title:'Sorteio',winners:2}),'active',s.now());const winners=s.drawGiveaway(id,['a','b','c','a']);assert.equal(winners.length,2);assert.equal(new Set(winners).size,2);assert.deepEqual(s.drawGiveaway(id,['d','e']),winners);});
test('backup preserves consistent database and settings',async t=>{const s=fixture(t),pid=product(s,'service');s.createOrder(pid,'123456789012345678');const name=await s.makeBackup({name:'Servidor teste'});assert.ok(existsSync(join(s.dir,'backups',`${name}.sqlite`)));assert.ok(existsSync(join(s.dir,'backups',`${name}.json`)));assert.ok(s.get('lastBackup'));});
test('embed bounds and URLs reject invalid payloads',()=>{assert.throws(()=>embedSchema.parse({description:'x'.repeat(4097)}));assert.throws(()=>embedSchema.parse({description:'x'.repeat(4000),footer:'x'.repeat(2048)}));assert.throws(()=>embedSchema.parse({image:'http://localhost/secret'}));assert.throws(()=>messageSchema.parse({target:'dm',targetId:'no',content:'Hi'}));assert.throws(()=>messageSchema.parse({target:'channel',targetId:'123456789012345678'}));});
test('welcome variables rendered in embed fields',()=>{const e=embedPayload(embedSchema.parse({title:'Olá {username}',description:'{user} em {server}',fields:[{name:'Membros',value:'{count}'}]}),{username:'Ana',user:'<@123>',server:'Studio K',count:'30'});assert.equal(e.title,'Olá Ana');assert.equal(e.fields[0].value,'30');assert.equal(e.color,0x995cff);});

test('custom message templates expand module variables',()=>{const e=embedPayload(defaults.messageStyles.ticketOpen.embed,{user:'<@123>',category:'Orçamento',server:'Studio K',ticket:'orcamento-1'});assert.equal(e.title,'Orçamento · Studio K');assert.match(e.description,/Descreva/);const p=embedPayload(defaults.messageStyles.product.embed,{product:'Pack',description:'Teste',price:'R$ 10,00',availability:'2 unidades',category:'Design'});assert.equal(p.title,'Pack');assert.equal(p.fields[0].value,'R$ 10,00');});

test('database allows two simultaneous open tickets per user and feedback source is unique',t=>{
  const s=fixture(t),uid='123456789012345678',now=s.now();
  s.run('INSERT INTO tickets(id,user_id,channel_id,category,status,created,updated) VALUES(?,?,?,?,?,?,?)',randomUUID(),uid,'223456789012345678','Suporte','open',now,now);
  s.run('INSERT INTO tickets(id,user_id,channel_id,category,status,created,updated) VALUES(?,?,?,?,?,?,?)',randomUUID(),uid,'323456789012345678','Orçamento','open',now,now);
  assert.equal(s.one("SELECT COUNT(*) AS n FROM tickets WHERE user_id=? AND status='open'",uid).n,2);
  const source=randomUUID(),id=randomUUID();
  s.run('INSERT INTO feedback_requests(id,type,source_id,user_id,status,meta,created) VALUES(?,?,?,?,?,?,?)',id,'ticket',source,uid,'pending','{}',now);
  assert.throws(()=>s.run('INSERT INTO feedback_requests(id,type,source_id,user_id,status,meta,created) VALUES(?,?,?,?,?,?,?)',randomUUID(),'ticket',source,uid,'pending','{}',now));
});

test('member language preference persists',t=>{
  const s=fixture(t),uid='123456789012345678';
  s.run('INSERT INTO user_preferences(user_id,language,updated_at) VALUES(?,?,?)',uid,'en',s.now());
  assert.equal(s.one('SELECT language FROM user_preferences WHERE user_id=?',uid).language,'en');
  s.run('UPDATE user_preferences SET language=?,updated_at=? WHERE user_id=?','es',s.now(),uid);
  assert.equal(s.one('SELECT language FROM user_preferences WHERE user_id=?',uid).language,'es');
});
