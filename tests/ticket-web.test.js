import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../server/store.js';
import {createTicketWebBridge} from '../server/ticket-web.js';

const USER='222222222222222222',BOT='333333333333333333',STAFF='444444444444444444';
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'studio-ticket-web-')),store=openStore(dir),sent=[],hooks=new Map();
  store.run('INSERT INTO tickets(id,user_id,category,status,state,priority,created,updated) VALUES(?,?,?,?,?,?,?,?)','ticket-1',USER,'Suporte','open','in_progress','normal',store.now(),store.now());
  let created=0,sequence=0,failHook=false;
  const hook={id:'hook-1',type:1,owner:{id:BOT},channelId:'channel-1',name:'Studio K · atendimento pelo site',send:async payload=>{sent.push(payload);return{id:`message-${++sequence}`,createdAt:new Date()};}};
  const batch=new Map();
  const channel={id:'channel-1',fetchWebhooks:async()=>{if(failHook)throw Object.assign(new Error('Missing permissions'),{code:50013});return hooks;},createWebhook:async()=>{created++;hooks.set(hook.id,hook);return hook;},messages:{fetch:async()=>batch}};
  store.run('UPDATE tickets SET channel_id=? WHERE id=?',channel.id,'ticket-1');
  const bridge=createTicketWebBridge({store,getChannel:async id=>{assert.equal(id,channel.id);return channel;},botId:()=>BOT,getProfile:async id=>({id,name:'Cliente atual',avatar:'https://cdn.discordapp.com/avatar-current.png'})});
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
  const message=(id,author,content,extra={})=>({id,author:{id:author,username:author===BOT?'Bot':'Pessoa',bot:author===BOT,displayAvatarURL:()=>''},content,attachments:new Map(),embeds:[],createdAt:new Date(),...extra});
  return{store,bridge,sent,batch,message,created:()=>created,failHook:()=>{failHook=true;}};
}
test('site replies use the authenticated Discord identity, safe mentions and durable attribution',async t=>{
  const f=fixture(t),result=await f.bridge.reply('ticket-1',USER,'Olá @everyone');
  assert.equal(f.sent[0].username,'Cliente atual');assert.equal(f.sent[0].avatarURL,'https://cdn.discordapp.com/avatar-current.png');
  assert.equal(f.sent[0].content,'Olá @everyone');assert.deepEqual(f.sent[0].allowedMentions,{parse:[],users:[],roles:[],repliedUser:false});
  assert.equal(f.store.one('SELECT user_id FROM ticket_web_messages WHERE message_id=?',result.id).user_id,USER);
  assert.equal(f.store.one('SELECT state FROM tickets').state,'waiting_staff');
  f.batch.set(result.id,f.message(result.id,'webhook-id','Olá @everyone',{webhookId:'hook-1',author:{id:'webhook-id',bot:true,username:'Cliente atual'}}));
  const messages=await f.bridge.messages('ticket-1',USER);
  assert.equal(messages[0].authorId,USER);assert.equal(messages[0].author,'Cliente atual');assert.equal(messages[0].customer,true);assert.equal(messages[0].bot,false);assert.equal(messages[0].viaSite,true);
});
test('concurrent sends reuse the same owned channel webhook',async t=>{
  const f=fixture(t);await Promise.all([f.bridge.reply('ticket-1',USER,'Primeira'),f.bridge.reply('ticket-1',USER,'Segunda')]);
  assert.equal(f.created(),1);assert.equal(f.sent.length,2);assert.equal(f.store.one('SELECT COUNT(*) n FROM ticket_web_messages').n,2);
});
test('foreign users and closed tickets cannot post, and webhook failure makes no bot fallback',async t=>{
  const f=fixture(t);await assert.rejects(()=>f.bridge.reply('ticket-1',STAFF,'Impostor'),/não encontrado/);
  f.failHook();await assert.rejects(()=>f.bridge.reply('ticket-1',USER,'Mensagem'),/Gerenciar Webhooks/);
  assert.equal(f.sent.length,0);assert.equal(f.store.one('SELECT COUNT(*) n FROM ticket_notes').n,0);assert.equal(f.store.one('SELECT state FROM tickets').state,'in_progress');
  f.store.run("UPDATE tickets SET status='closed'");await assert.rejects(()=>f.bridge.reply('ticket-1',USER,'Outra'),/não está aberto/);
});
test('legacy bot replies are attributed only with trusted bot authorship and a matching public note',async t=>{
  const f=fixture(t),prefix=`**Mensagem enviada pelo site · <@${USER}>**\n`;
  f.store.run('INSERT INTO ticket_notes VALUES(?,?,?,?,0,?)','note-1','ticket-1',USER,'Antiga',f.store.now());
  f.batch.set('old',f.message('old',BOT,prefix+'Antiga'));
  f.batch.set('spoof',f.message('spoof',STAFF,prefix+'Antiga'));
  f.batch.set('unproven',f.message('unproven',BOT,prefix+'Não comprovada'));
  f.batch.set('staff',f.message('staff',STAFF,'Atendimento humano',{member:{displayName:'Atendente',displayAvatarURL:()=> 'https://cdn.discordapp.com/staff.png'}}));
  const messages=await f.bridge.messages('ticket-1',USER),old=messages.find(m=>m.id==='old'),staff=messages.find(m=>m.id==='staff');
  assert.equal(old.authorId,USER);assert.equal(old.content,'Antiga');assert.equal(old.customer,true);
  assert.equal(messages.find(m=>m.id==='spoof').viaSite,false);assert.equal(messages.find(m=>m.id==='unproven').authorId,BOT);
  assert.equal(staff.author,'Atendente');assert.equal(staff.avatar,'https://cdn.discordapp.com/staff.png');assert.equal(staff.customer,false);
});
