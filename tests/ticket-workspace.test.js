import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ChannelType,OverwriteType,PermissionOverwrites,PermissionFlagsBits as P} from 'discord.js';
import {openStore} from '../server/store.js';
import {createTicketWorkspace,ticketParent,assertPrivateStaffChannel} from '../server/ticket-workspace.js';
import {settingsSchema} from '../server/schema.js';
import {createBot} from '../server/discord.js';

const GUILD='111111111111111111',USER='222222222222222222',BOT='333333333333333333',STAFF='444444444444444444',OTHER='555555555555555555';
const bitset=values=>({has:permission=>values.includes(permission)});
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'studio-ticket-workspace-')),store=openStore(dir),channels=new Map(),created=[];
  const everyone={id:GUILD,permissions:bitset([])},staff={id:STAFF,permissions:bitset([])},other={id:OTHER,permissions:bitset([])};
  const roles=new Map([[GUILD,everyone],[STAFF,staff],[OTHER,other]]);
  const guild={id:GUILD,name:'Servidor de teste',roles:{everyone,cache:roles,fetch:async id=>id?roles.get(id):roles},members:{cache:new Map(),fetch:async id=>({id,roles:{cache:new Map()},permissions:bitset([])})}};
  let sequence=0;
  function makeChannel(id,{type=ChannelType.GuildText,name=id,parentId='',publicView=false}={}){
    const messages=new Map(),sent=[];
    const channel={id,name,type,parentId,guild,publicView,sent,isTextBased:()=>type===ChannelType.GuildText,permissionOverwrites:{cache:new Map()},
      permissionsFor:role=>bitset(channel.publicView||role.id===STAFF||role.id===BOT?[P.ViewChannel]:[]),
      setParent:async(parent,options)=>{channel.parentId=parent;channel.lastParentOptions=options;},
      delete:async()=>{channel.deleted=true;channels.delete(id);},
      messages:{fetch:async messageId=>{if(typeof messageId==='object')return messages;const found=messages.get(messageId);if(!found)throw Object.assign(new Error('Unknown message'),{code:10008});return found;}},
      send:async payload=>{
        if(channel.failSend)throw new Error('Falha temporária de envio');
        const message={id:`90000000000000${++sequence}`,content:payload.content||'',payload,edit:async next=>{message.payload=next;message.content=next.content||'';}};
        sent.push(payload);messages.set(message.id,message);return message;
      }};
    channels.set(id,channel);return channel;
  }
  guild.channels={cache:channels,fetch:async id=>id?channels.get(id):channels,create:async payload=>{
    const c=makeChannel(`60000000000000${++sequence}`,{type:payload.type,name:payload.name,parentId:payload.parent});c.topic=payload.topic;c.creation=payload;created.push(c);return c;
  }};
  const customer=makeChannel('customer',{name:'suporte-1',parentId:'old-parent'}),parent=makeChannel('support',{type:ChannelType.GuildCategory}),infoParent=makeChannel('internal',{type:ChannelType.GuildCategory}),log=makeChannel('log');
  const cfg=store.settings();cfg.tickets.categoryId=parent.id;cfg.tickets.staffInfoCategoryId=infoParent.id;cfg.tickets.logChannelId=log.id;
  // The production schema validates Discord IDs. Tests inject the equivalent parsed settings with short, readable IDs.
  const settings=()=>cfg;store.settings=settings;
  const now=store.now();store.run('INSERT INTO tickets(id,user_id,channel_id,category,status,state,priority,created,updated) VALUES(?,?,?,?,?,?,?,?,?)','ticket-1',USER,customer.id,'Suporte','open','waiting_staff','urgent',now,now);
  const workspace=createTicketWorkspace({store,getGuild:()=>guild,getChannel:async id=>{const found=channels.get(id);if(!found)throw Object.assign(new Error('Unknown channel'),{code:10003});return found;},botId:()=>BOT,staffRoles:()=>[STAFF],renderControls:()=>({components:[{type:1,components:[]}]})});
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
  return{store,workspace,cfg,guild,channels,created,customer,log,makeChannel};
}
test('new internal channels are private, retain notes, and updates do not create duplicate channels',async t=>{
  const f=fixture(t);f.store.run('INSERT INTO ticket_notes VALUES(?,?,?,?,1,?)','note-1','ticket-1',STAFF,'Informação reservada',f.store.now());
  await f.workspace.sync('ticket-1');await f.workspace.sync('ticket-1');
  assert.equal(f.created.length,1);const info=f.created[0];assert.equal(info.parentId,'internal');
  assert.deepEqual(info.creation.permissionOverwrites[0],{id:GUILD,type:OverwriteType.Role,deny:[P.ViewChannel]});assert.equal(info.creation.permissionOverwrites.some(o=>o.id===USER),false);
  assert.equal(info.sent.filter(p=>String(p.content).includes('Informação reservada')).length,1);
  assert.equal(f.customer.parentId,'support');assert.equal(f.customer.lastParentOptions.lockPermissions,false);
  assert.equal(JSON.stringify(f.customer.sent).includes('Informação reservada'),false);
  assert.equal(info.sent[0].embeds[0].fields.find(field=>field.name==='Prioridade').value,'Urgente');
});

test('destination overwrites serialize through the real Discord SDK without relying on cached users or roles',async t=>{
  const f=fixture(t);f.cfg.roleGroups.staff=[STAFF,'777777777777777777'];
  const bot=createBot(f.store,{DISCORD_GUILD_ID:GUILD});bot.client.isReady=()=>true;bot.client.user={id:BOT};bot.client.guilds.cache.set(GUILD,f.guild);t.after(()=>bot.stop());
  const created=await bot.createTicketDestination({name:'Suporte',kind:'category'});
  const overwrites=f.channels.get(created.id).creation.permissionOverwrites;
  assert.deepEqual(overwrites.map(o=>o.id),[GUILD,BOT,STAFF]);
  const coldGuild={roles:{resolve:()=>null},client:{users:{resolve:()=>null}}};
  const payload=overwrites.map(o=>PermissionOverwrites.resolve(o,coldGuild));
  assert.deepEqual(payload.map(o=>o.type),[OverwriteType.Role,OverwriteType.Member,OverwriteType.Role]);
  assert.ok(BigInt(payload[0].deny)&P.ViewChannel);assert.ok(BigInt(payload[2].allow)&P.ViewChannel);
});
test('a future ticket type can have its own category and existing private overwrites stay unlocked',async t=>{
  const f=fixture(t);f.makeChannel('future',{type:ChannelType.GuildCategory});f.cfg.tickets.categoryRoutes=[{name:'Modelagem avançada',categoryId:'future'}];
  f.store.run('UPDATE tickets SET category=?','Modelagem avançada');await f.workspace.sync('ticket-1');
  assert.equal(f.customer.parentId,'future');assert.equal(f.customer.lastParentOptions.lockPermissions,false);
  assert.equal(ticketParent({categoryId:'fallback',categoryRoutes:[]},'Outro tipo'),'fallback');
});

test('changing the internal category moves existing information channels without syncing customer permissions',async t=>{
  const f=fixture(t);await f.workspace.sync('ticket-1');const info=f.created[0];
  f.makeChannel('new-internal',{type:ChannelType.GuildCategory});f.cfg.tickets.staffInfoCategoryId='new-internal';
  await f.workspace.sync('ticket-1');assert.equal(info.parentId,'new-internal');assert.equal(info.lastParentOptions.lockPermissions,false);assert.equal(f.created.length,1);
});

test('the actual bot accepts category destinations and keeps private notes out of the customer transcript',async t=>{
  const f=fixture(t);f.cfg.roleGroups.staff=[STAFF];f.cfg.backups.enabled=false;
  const bot=createBot(f.store,{DISCORD_GUILD_ID:GUILD,PUBLIC_URL:'https://studio.example.test'});
  bot.client.isReady=()=>true;bot.client.user={id:BOT};bot.client.guilds.cache.set(GUILD,f.guild);
  t.after(()=>bot.stop());
  await bot.validateTicketSettings(f.cfg.tickets);
  await bot.addTicketNote('ticket-1',STAFF,'RESERVADO À EQUIPE');await bot.syncTicketWorkspaces();
  const ticket=f.store.one('SELECT * FROM tickets WHERE id=?','ticket-1');assert.ok(ticket.staff_channel_id);
  const publicMessages=new Map([['message-1',{id:'message-1',content:'Conversa pública',createdAt:new Date(),author:{tag:'Cliente',id:USER},attachments:new Map(),embeds:[]}]]);publicMessages.last=()=>[...publicMessages.values()].at(-1);
  f.customer.messages.fetch=async()=>publicMessages;
  const result=await bot.closeTicket('ticket-1',STAFF,'Resolvido no teste');assert.equal(result.logPending,false);
  const closed=f.store.one('SELECT * FROM tickets WHERE id=?','ticket-1');assert.equal(closed.status,'closed');assert.match(closed.transcript,/Conversa pública/);assert.doesNotMatch(closed.transcript,/RESERVADO/);
  assert.match(f.log.sent.flatMap(payload=>payload.files||[]).map(file=>file.attachment.toString()).join('\n'),/RESERVADO À EQUIPE/);
});
test('customer-visible destinations cannot receive internal snapshots or notes',async t=>{
  const f=fixture(t);f.cfg.tickets.staffInfoCategoryId='';await f.workspace.sync('ticket-1');
  assert.equal(f.created.length,0);f.cfg.tickets.staffInfoCategoryId='internal';await f.workspace.sync('ticket-1');
  const info=f.created[0],before=info.sent.length;info.publicView=true;
  f.store.run('INSERT INTO ticket_notes VALUES(?,?,?,?,1,?)','note-2','ticket-1',STAFF,'Segredo novo',f.store.now());
  await assert.rejects(()=>f.workspace.sync('ticket-1'),/privado/);assert.equal(info.sent.length,before);
  assert.equal(JSON.stringify(f.customer.sent).includes('Segredo novo'),false);
});
test('closing sends selected private information to logs before removing the internal channel',async t=>{
  const f=fixture(t);f.store.run('INSERT INTO ticket_notes VALUES(?,?,?,?,1,?)','note-1','ticket-1',STAFF,'Nota completa privada',f.store.now());
  f.store.run('INSERT INTO ticket_notes VALUES(?,?,?,?,0,?)','reply-1','ticket-1',USER,'Resposta pública',f.store.now());
  await f.workspace.sync('ticket-1');const info=f.created[0];f.store.run("UPDATE tickets SET status='closed',closed_reason='Resolvido'");
  assert.equal(await f.workspace.close('ticket-1',{transcriptUrl:'https://example.test/transcript'}),true);
  assert.equal(info.deleted,true);assert.equal(f.log.sent.length,1);
  const text=f.log.sent[0].files.map(file=>file.attachment.toString()).join('\n');assert.match(text,/Nota completa privada/);assert.doesNotMatch(text,/Resposta pública/);
  assert.equal(await f.workspace.close('ticket-1',{}),true);assert.equal(f.log.sent.length,1);
});
test('failed or public logs preserve internal channels and durable retries finish later',async t=>{
  const f=fixture(t);await f.workspace.sync('ticket-1');const info=f.created[0];f.store.run("UPDATE tickets SET status='closed'");f.log.publicView=true;
  assert.equal(await f.workspace.close('ticket-1',{}),false);assert.equal(info.deleted,undefined);assert.equal(f.log.sent.length,0);
  assert.ok(f.store.get('ticket-close-job:ticket-1'));f.log.publicView=false;f.log.failSend=true;
  let job=f.store.get('ticket-close-job:ticket-1');job.nextAt=0;f.store.set('ticket-close-job:ticket-1',job);await f.workspace.maintain();assert.equal(info.deleted,undefined);
  f.log.failSend=false;job=f.store.get('ticket-close-job:ticket-1');job.nextAt=0;f.store.set('ticket-close-job:ticket-1',job);await f.workspace.maintain();
  assert.equal(info.deleted,true);assert.equal(f.log.sent.length,1);assert.equal(f.store.get('ticket-close-job:ticket-1'),null);
});
test('log fields exclude unselected notes, history and metadata',async t=>{
  const f=fixture(t);f.cfg.tickets.logFields=['customer','type'];f.store.run('INSERT INTO ticket_notes VALUES(?,?,?,?,1,?)','n','ticket-1',STAFF,'NÃO PUBLICAR',f.store.now());
  f.store.set('ticket-audit:ticket-1',{events:[{action:'note',actor:STAFF,note:'NÃO PUBLICAR',at:f.store.now()}]});
  f.store.run("UPDATE tickets SET status='closed'");await f.workspace.close('ticket-1',{});
  assert.deepEqual(f.log.sent[0].embeds[0].fields.map(field=>field.name),['Cliente','Tipo de atendimento']);assert.deepEqual(f.log.sent[0].files,[]);assert.doesNotMatch(JSON.stringify(f.log.sent),/NÃO PUBLICAR/);
});
test('private log validation rejects unrelated role access',async t=>{
  const f=fixture(t);const old=f.log.permissionsFor;f.log.permissionsFor=role=>role.id===OTHER?bitset([P.ViewChannel]):old(role);
  await assert.rejects(()=>assertPrivateStaffChannel(f.log,f.guild,[STAFF],BOT),/fora da equipe/);
});
test('settings accept new dynamic types and reject malformed route destinations',()=>{
  const valid=settingsSchema.parse({tickets:{categories:['Suporte','Compras','Novo tipo'],categoryRoutes:[{name:'Novo tipo',categoryId:'777777777777777777'}]}});
  assert.equal(valid.tickets.categoryRoutes[0].name,'Novo tipo');assert.equal(valid.tickets.logFields.includes('notes'),true);
  assert.throws(()=>settingsSchema.parse({tickets:{categoryRoutes:[{name:'Novo',categoryId:'not-a-discord-id'}]}}));
});
