import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../server/store.js';
import {buildTicketTranscript,saveTicketTranscript,readTicketTranscript,renderTicketTranscript} from '../server/ticket-transcript.js';

const USER='222222222222222222',STAFF='444444444444444444',BOT='333333333333333333',GUILD='111111111111111111';
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'studio-transcript-')),store=openStore(dir),now=store.now();
  store.run('INSERT INTO tickets(id,user_id,category,status,created,updated) VALUES(?,?,?,?,?,?)','ticket-1',USER,'Suporte','open',now,now);
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
  const ticket=store.one('SELECT * FROM tickets');
  const message=(id,authorId,content,extra={})=>({id,author:{id:authorId,username:'usuario',bot:authorId===BOT},createdAt:new Date('2026-10-28T12:00:00Z'),content,embeds:[],attachments:new Map(),...extra});
  const member=id=>({id,displayName:id===STAFF?'Ana':'Bia',guild:{id:GUILD},user:{username:id===STAFF?'ana.staff':'bia.cliente'},roles:{cache:new Map([['a',{id:'a',name:'Atendente',position:20}],['b',{id:'b',name:'Membro',position:1}]])},displayAvatarURL:()=>`https://cdn.discordapp.com/avatars/${id}/photo.png`});
  return{store,ticket,message,member};
}
test('transcript snapshots real identities and the highest role, including authenticated website replies',async t=>{
  const f=fixture(t),messages=[f.message('web-message','webhook','Pelo site',{webhookId:'hook'}),f.message('staff',STAFF,'Olá'),f.message('staff-2',STAFF,'Como posso ajudar?')],calls=[];
  f.store.run('INSERT INTO ticket_web_messages VALUES(?,?,?,?,?,?)','web-message',f.ticket.id,USER,'Nome anterior','',f.store.now());
  const transcript=await buildTicketTranscript({...f,messages,botId:BOT,getMember:async id=>{calls.push(id);return f.member(id);}});
  assert.equal(transcript.messages[0].authorId,USER);assert.equal(transcript.messages[0].username,'bia.cliente');assert.equal(transcript.messages[0].name,'Bia');assert.equal(transcript.messages[0].viaSite,true);assert.equal(transcript.messages[0].customer,true);
  assert.equal(transcript.messages[1].role.name,'Atendente');assert.deepEqual(calls,[USER,STAFF]);assert.match(transcript.text,/Ana \(@ana.staff\).*444444444444444444.*Atendente/);
  saveTicketTranscript(f.store,f.ticket.id,transcript);assert.deepEqual(readTicketTranscript(f.store,f.ticket),transcript.messages);
});
test('failed member lookup retains author and message content; nicknames cannot grant role badges',async t=>{
  const f=fixture(t),transcript=await buildTicketTranscript({...f,messages:[f.message('one',USER,'Mensagem',{author:{id:USER,username:'[CEO] Pessoa'}})],botId:BOT,getMember:async()=>{throw new Error('Left guild');}});
  assert.equal(transcript.messages[0].authorId,USER);assert.equal(transcript.messages[0].role,null);assert.equal(transcript.messages[0].content,'Mensagem');
});
test('legacy site attribution requires our bot and a matching public reply; internal notes do not become transcript messages',async t=>{
  const f=fixture(t),prefix=`**Mensagem enviada pelo site · <@${USER}>**\n`;
  f.store.run('INSERT INTO ticket_notes VALUES(?,?,?,?,0,?)','reply',f.ticket.id,USER,'Olá',f.store.now());
  f.store.run('INSERT INTO ticket_notes VALUES(?,?,?,?,1,?)','note',f.ticket.id,STAFF,'SEGREDO',f.store.now());
  const transcript=await buildTicketTranscript({...f,messages:[f.message('legit',BOT,prefix+'Olá'),f.message('spoof',STAFF,prefix+'Olá')],botId:BOT,getMember:async id=>f.member(id)});
  assert.equal(transcript.messages[0].authorId,USER);assert.equal(transcript.messages[0].content,'Olá');assert.equal(transcript.messages[1].authorId,STAFF);assert.equal(transcript.messages[1].viaSite,false);assert.doesNotMatch(JSON.stringify(transcript),/SEGREDO/);
});
test('chat rendering escapes identities, roles, embeds and content, and rejects unsafe attachment/avatar URLs',()=>{
  const ticket={id:'ticket-1',category:'<script>category</script>',updated:'2026-10-28T12:00:00Z'};
  const html=renderTicketTranscript(ticket,[{name:'<img onerror=alert(1)>',username:'<b>name</b>',authorId:USER,role:{name:'<script>role</script>'},customer:true,created:ticket.updated,content:'<script>body</script>',avatar:'https://evil.example/tracker.png',embeds:[{title:'<svg>',description:'<iframe>',fields:[]}],attachments:[{name:'<img>',url:'javascript:alert(1)'},{name:'arquivo',url:'https://cdn.discordapp.com/attachments/test.pdf'}]}],'/download');
  assert.match(html,/class="message customer"/);assert.match(html,/ID Discord: 222222222222222222/);assert.match(html,/&lt;script&gt;role/);assert.doesNotMatch(html,/<script|onerror="|href="javascript:|evil\.example/);assert.match(html,/href="https:\/\/cdn.discordapp.com\/attachments\/test.pdf"/);
});
test('old plain text exports gain bubbles while preserving recorded IDs and marking absent role snapshots',()=>{
  const store={get:()=>null},ticket={id:'old',user_id:USER,transcript:`[2026-10-28T12:00:00.000Z] Cliente (${USER}): Olá\n\n[2026-10-28T12:01:00.000Z] Ana (${STAFF}): Olá!`};
  const messages=readTicketTranscript(store,ticket);assert.equal(messages.length,2);assert.equal(messages[0].customer,true);assert.equal(messages[1].name,'Ana');assert.equal(messages[1].authorId,STAFF);assert.equal(messages[1].role,undefined);
  const html=renderTicketTranscript(ticket,messages,'/download');assert.match(html,/Cargo não registrado/);assert.doesNotMatch(html,/<pre>/);
});

test('old site exports recover the real Discord ID only from an exact saved message timestamp and name',async t=>{
  const f=fixture(t),created='2026-10-28T12:00:00.000Z',messageId=String((BigInt(Date.parse(created))-1420070400000n)<<22n);
  f.store.run('INSERT INTO ticket_web_messages VALUES(?,?,?,?,?,?)',messageId,f.ticket.id,USER,'Nome pelo site','',f.store.now());
  f.ticket.transcript=`[${created}] Nome pelo site (666666666666666666): Olá`;
  const messages=readTicketTranscript(f.store,f.ticket);assert.equal(messages[0].authorId,USER);assert.equal(messages[0].viaSite,true);assert.equal(messages[0].role,undefined);
  f.ticket.transcript=`[2026-10-28T12:01:00.000Z] Nome pelo site (666666666666666666): Outra`;
  assert.equal(readTicketTranscript(f.store,f.ticket)[0].authorId,'666666666666666666');
});
