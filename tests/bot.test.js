import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../server/store.js';
import { createBot, canOpenTicket, feedbackStars, youtubeVideoId, youtubeChannelRef, SUPPORTED_LANGUAGES, normalizeLanguage, splitTranslationText } from '../server/discord.js';
import { productSchema } from '../server/schema.js';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'studio-k-bot-')),s=openStore(dir);const cfg=s.settings();cfg.backups.enabled=false;s.set('settings',cfg);const env={DISCORD_GUILD_ID:'111111111111111111'},bot=createBot(s,env);const sent=[];let failDM=false;const fakeMember={send:async payload=>{if(failDM)throw new Error('DMs bloqueadas');sent.push(payload);return{id:'999999999999999999'};}};bot.client.isReady=()=>true;bot.client.guilds.cache.set(env.DISCORD_GUILD_ID,{members:{fetch:async()=>fakeMember}});t.after(async()=>{await bot.stop();s.db.close();rmSync(dir,{recursive:true,force:true});});return{s,bot,sent,fail(value){failDM=value;}};}
test('optional DM requires opt-in and respects opt-out',async t=>{const {s,bot,sent}=fixture(t),uid='222222222222222222';await assert.rejects(()=>bot.sendMessage({target:'dm',targetId:uid,content:'Olá'}),/notificacoes/);s.run('INSERT INTO optins VALUES(?,?)',uid,s.now());await bot.sendMessage({target:'dm',targetId:uid,content:'Olá'});assert.equal(sent.length,1);assert.deepEqual(sent[0].allowedMentions,{parse:[],users:[],roles:[],repliedUser:false});s.run('DELETE FROM optins WHERE user_id=?',uid);await assert.rejects(()=>bot.sendMessage({target:'dm',targetId:uid,content:'Outra'}),/notificacoes/);});
test('paid delivery recovers after closed DMs without allocating another stock unit',async t=>{const f=fixture(t),{s,bot,sent}=f,pid=randomUUID();s.run('INSERT INTO products VALUES(?,?,?)',pid,JSON.stringify(productSchema.parse({name:'Licença',priceCents:1200,type:'digital'})),s.now());s.run('INSERT INTO stock(id,product_id,secret) VALUES(?,?,?)',randomUUID(),pid,s.encrypt('CHAVE-DO-PEDIDO'));const o=s.createOrder(pid,'222222222222222222');s.approveOrder(o.id,'admin');f.fail(true);await bot.tick();assert.equal(s.one('SELECT status FROM orders WHERE id=?',o.id).status,'paid');assert.match(s.one('SELECT error FROM orders WHERE id=?',o.id).error,/DMs bloqueadas/);f.fail(false);await bot.tick();assert.equal(s.one('SELECT status FROM orders WHERE id=?',o.id).status,'delivered');assert.equal(sent.length,1);assert.match(sent[0].embeds[0].description,/CHAVE-DO-PEDIDO/);assert.equal(sent[0].enforceNonce,true);await bot.tick();assert.equal(sent.length,1);assert.equal(s.products()[0].stock,0);});

test('ticket capacity is limited to two open tickets',()=>{
  assert.equal(canOpenTicket(0),true);
  assert.equal(canOpenTicket(1),true);
  assert.equal(canOpenTicket(2),false);
  assert.equal(canOpenTicket(3),false);
});

test('YouTube requirement parsers accept common URLs and handles',()=>{
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ'),'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'),'dQw4w9WgXcQ');
  assert.deepEqual(youtubeChannelRef('https://www.youtube.com/@StudioK'),{id:'',handle:'@StudioK'});
  assert.deepEqual(youtubeChannelRef('@StudioK'),{id:'',handle:'@StudioK'});
});

test('feedback stars render from one to five',()=>{
  assert.equal(feedbackStars(1),'⭐☆☆☆☆');
  assert.equal(feedbackStars(3),'⭐⭐⭐☆☆');
  assert.equal(feedbackStars(5),'⭐⭐⭐⭐⭐');
});

test('Discord mentions and links are excluded from translation text',()=>{
  const source='Olá <@123456789012345678>! Seu atendimento foi criado em <#223456789012345678>. Veja https://example.com/ticket/ABC123456789.';
  const parts=splitTranslationText(source);
  assert.equal(parts.filter(p=>p.protected).map(p=>p.text).join('|'),'<@123456789012345678>|<#223456789012345678>|https://example.com/ticket/ABC123456789');
  assert.equal(parts.map(p=>p.text).join(''),source);
  assert.equal(parts.some(p=>p.text.includes('SKTOKEN')),false);
});
test('Portuguese language aliases normalize to pt',()=>{
  assert.equal(normalizeLanguage('pt'),'pt');
  assert.equal(normalizeLanguage('pt-BR'),'pt');
  assert.equal(normalizeLanguage('pt_BR'),'pt');
  assert.equal(normalizeLanguage('Português'),'pt');
});
test('supported languages normalize safely',()=>{
  assert.ok(SUPPORTED_LANGUAGES.some(l=>l.code==='pt'));
  assert.ok(SUPPORTED_LANGUAGES.some(l=>l.code==='en'));
  assert.equal(normalizeLanguage('es'),'es');
  assert.equal(normalizeLanguage('xx'),'pt');
});
