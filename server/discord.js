import { Client, GatewayIntentBits, Partials, Events, ChannelType, PermissionFlagsBits, ActivityType, REST, Routes, MessageFlags, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, AuditLogEvent } from 'discord.js';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { AppError } from './store.js';
export function expandText(value,variables={}) {
  return String(value||'').replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,(match,key)=>Object.prototype.hasOwnProperty.call(variables,key)?String(variables[key]??''):match);
}
export function embedPayload(e={},variables={}) {
  const color=/^#[0-9a-f]{6}$/i.test(e.color||'')?e.color:'#995cff';
  const result={color:parseInt(color.slice(1),16)};
  for(const field of ['title','description','url'])if(e[field])result[field]=expandText(e[field],variables);
  if(e.author)result.author={name:expandText(e.author,variables),...(e.authorIcon?{icon_url:e.authorIcon}:{})};
  if(e.footer)result.footer={text:expandText(e.footer,variables)};
  if(e.image)result.image={url:e.image};
  if(e.thumbnail)result.thumbnail={url:e.thumbnail};
  if(e.timestamp)result.timestamp=new Date().toISOString();
  if(e.fields?.length)result.fields=e.fields.map(f=>({name:expandText(f.name,variables),value:expandText(f.value,variables),inline:!!f.inline}));
  return result;
}
const hasEmbed=e=>!!(e.title||e.description||e.url||e.author||e.footer||e.image||e.thumbnail||e.timestamp||e.fields?.length);
const buttonEmoji=value=>{
  const raw=String(value||'').trim();if(!raw)return undefined;
  const custom=raw.match(/^<(a?):([A-Za-z0-9_]+):(\d+)>$/);
  return custom?{id:custom[3],name:custom[2],animated:custom[1]==='a'}:{name:raw};
};
const button=(label,custom_id,style=1)=>({type:2,label,custom_id,style});
const linkButton=(label,url,emoji='')=>({type:2,label,style:5,url,...(buttonEmoji(emoji)?{emoji:buttonEmoji(emoji)}:{})});
const row=(...components)=>({type:1,components});
const linkRows=(buttons=[],guildId='')=>{
  if(!buttons?.length)return[];
  const components=buttons.slice(0,5).map(b=>{
    const url=b.type==='channel'
      ? `https://discord.com/channels/${guildId}/${b.channelId}`
      : b.url;
    return linkButton(b.label,url,b.emoji);
  });
  return components.length?[row(...components)]:[];
};
const stylePayload=(style,variables={},guildId=process.env.DISCORD_GUILD_ID||'')=>{
  const embed=embedPayload(style?.embed||{},variables);
  return {content:expandText(style?.content||'',variables)||undefined,embeds:hasEmbed(embed)?[embed]:[],components:linkRows(style?.buttons||[],guildId)};
};
const mentionPolicy=(payload={},extraUsers=[],extraRoles=[])=>{
  const text=[payload.content||'',JSON.stringify(payload.embeds||[])].join('\n');
  const users=[...text.matchAll(/<@!?(\d+)>/g)].map(m=>m[1]);
  const roles=[...text.matchAll(/<@&(\d+)>/g)].map(m=>m[1]);
  return {parse:[],users:[...new Set([...users,...extraUsers])].slice(0,100),roles:[...new Set([...roles,...extraRoles])].slice(0,100),repliedUser:false};
};
const safe={parse:[]};
const money=n=>(n/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const channelSlug=value=>String(value||'ticket').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)||'ticket';
export const SUPPORTED_LANGUAGES=[
  {code:'pt',label:'Português (Brasil)',emoji:'🇧🇷'},
  {code:'en',label:'English',emoji:'🇺🇸'},
  {code:'es',label:'Español',emoji:'🇪🇸'},
  {code:'fr',label:'Français',emoji:'🇫🇷'},
  {code:'de',label:'Deutsch',emoji:'🇩🇪'},
  {code:'it',label:'Italiano',emoji:'🇮🇹'},
  {code:'ja',label:'日本語',emoji:'🇯🇵'},
  {code:'ko',label:'한국어',emoji:'🇰🇷'},
  {code:'zh-CN',label:'简体中文',emoji:'🇨🇳'},
  {code:'ru',label:'Русский',emoji:'🇷🇺'}
];
export const normalizeLanguage=value=>{
  const raw=String(value||'').trim(),lower=raw.toLowerCase().replace('_','-');
  if(['pt','pt-br','pt-pt','português','portugues','portuguese'].includes(lower))return 'pt';
  if(lower==='zh-cn'||lower==='zh-hans')return 'zh-CN';
  const exact=SUPPORTED_LANGUAGES.find(l=>l.code.toLowerCase()===lower);
  return exact?.code||'pt';
};
const protectedTranslationPattern=/```[\s\S]*?```|`[^`\n]+`|<(?:@!?|@&|#)\d+>|<t:\d+(?::[tTdDfFR])?>|<a?:[A-Za-z0-9_]+:\d+>|https?:\/\/[^\s)]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|[A-Za-z0-9_-]{12,}/gi;
export const splitTranslationText=value=>{
  const source=String(value||''),parts=[];let last=0;
  protectedTranslationPattern.lastIndex=0;
  for(const match of source.matchAll(protectedTranslationPattern)){
    if(match.index>last)parts.push({text:source.slice(last,match.index),protected:false});
    parts.push({text:match[0],protected:true});
    last=match.index+match[0].length;
  }
  if(last<source.length)parts.push({text:source.slice(last),protected:false});
  return parts.length?parts:[{text:source,protected:false}];
};
export const TICKET_OPEN_LIMIT=2;
export const canOpenTicket=openCount=>Number(openCount)<TICKET_OPEN_LIMIT;
export const feedbackStars=rating=>'⭐'.repeat(Math.max(1,Math.min(5,Number(rating)||1)))+'☆'.repeat(5-Math.max(1,Math.min(5,Number(rating)||1)));
export function youtubeVideoId(value=''){
  const raw=String(value).trim();
  if(/^[A-Za-z0-9_-]{11}$/.test(raw))return raw;
  try{
    const u=new URL(raw);
    if(u.hostname==='youtu.be')return u.pathname.split('/').filter(Boolean)[0]||'';
    if(u.hostname.endsWith('youtube.com')){
      if(u.searchParams.get('v'))return u.searchParams.get('v');
      const parts=u.pathname.split('/').filter(Boolean);
      if(['shorts','embed','live'].includes(parts[0]))return parts[1]||'';
    }
  }catch{}
  return '';
}
export function youtubeChannelRef(value=''){
  const raw=String(value).trim();
  if(/^UC[A-Za-z0-9_-]{20,}$/.test(raw))return{id:raw,handle:''};
  const direct=raw.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]+)/i);if(direct)return{id:direct[1],handle:''};
  const handle=raw.match(/(?:youtube\.com\/)?@([A-Za-z0-9._-]+)/i);if(handle)return{id:'',handle:'@'+handle[1]};
  if(raw.startsWith('@'))return{id:'',handle:raw};
  return{id:'',handle:''};
}

export function createBot(store,env=process.env){
  const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,GatewayIntentBits.GuildModeration,GatewayIntentBits.GuildVoiceStates],partials:[Partials.Message,Partials.Channel]});
  let error='',busy=false,backupBusy=false,inviteCache=new Map();
  const languageSelect=(customId,current='')=>({type:3,custom_id:customId,placeholder:'Escolha seu idioma',min_values:1,max_values:1,options:SUPPORTED_LANGUAGES.map(l=>({label:l.label,value:l.code,emoji:{name:l.emoji},...(l.code===current?{default:true}:{})}))});
  const languageLabel=code=>SUPPORTED_LANGUAGES.find(l=>l.code===normalizeLanguage(code))?.label||'Português (Brasil)';
  const languagePreference=userId=>store.one('SELECT language FROM user_preferences WHERE user_id=?',userId)||null;
  const preferredLanguage=userId=>normalizeLanguage(languagePreference(userId)?.language||'pt');
  const saveLanguage=(userId,language)=>{const value=normalizeLanguage(language);store.run('INSERT INTO user_preferences(user_id,language,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET language=excluded.language,updated_at=excluded.updated_at',userId,value,store.now());return value;};
  const libreTranslateUrl=()=>String(env.LIBRETRANSLATE_URL||'http://libretranslate.railway.internal:5000').replace(/\/$/,'');
  const libreLanguage=code=>normalizeLanguage(code)==='zh-CN'?'zh-Hans':normalizeLanguage(code);
  const translationReady=()=>!!(store.settings().translator?.enabled&&libreTranslateUrl());
  const decodeTranslation=value=>String(value||'').replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  async function translateTexts(values,target){
    const language=normalizeLanguage(target),source=values.map(v=>String(v||''));
    if(language==='pt'||!source.some(Boolean))return source;
    if(!translationReady())throw new AppError('O tradutor ainda não foi configurado no servidor.',503);
    const cacheKey='translate:v2:'+createHash('sha256').update(language+'\n'+JSON.stringify(source)).digest('hex');
    const cached=store.get(cacheKey);
    if(cached?.values&&Date.now()-Number(cached.created||0)<7*86400000)return cached.values;

    const split=source.map(splitTranslationText),translatable=[];
    for(const parts of split)for(const part of parts)if(!part.protected&&part.text.trim())translatable.push(part);
    if(!translatable.length)return source;

    const response=await fetch(`${libreTranslateUrl()}/translate`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({q:translatable.map(part=>part.text),source:'auto',target:libreLanguage(language),format:'text'})
    });
    const data=await response.json().catch(()=>({}));
    const translatedRaw=Array.isArray(data?.translatedText)?data.translatedText:(typeof data?.translatedText==='string'?[data.translatedText]:[]);
    if(!response.ok||translatedRaw.length!==translatable.length)throw new AppError(data?.error||'Não foi possível traduzir esta mensagem agora.',502);
    translatable.forEach((part,index)=>part.text=decodeTranslation(translatedRaw[index]));
    const translated=split.map(parts=>parts.map(part=>part.text).join(''));
    store.set(cacheKey,{values:translated,created:Date.now()});
    return translated;
  }
  async function translatePayload(payload,target){
    const clone=structuredClone(payload||{}),slots=[];
    const add=(obj,key)=>{if(obj?.[key])slots.push({obj,key,value:String(obj[key])});};
    add(clone,'content');
    for(const e of clone.embeds||[]){
      add(e,'title');add(e,'description');
      if(e.author)add(e.author,'name');
      if(e.footer)add(e.footer,'text');
      for(const field of e.fields||[]){add(field,'name');add(field,'value');}
    }
    if(!slots.length)return clone;
    const values=await translateTexts(slots.map(x=>x.value),target);
    slots.forEach((slot,index)=>slot.obj[slot.key]=values[index]);
    return clone;
  }
  async function localizeFor(userId,data){
    if(!translationReady())return data;
    const language=preferredLanguage(userId);if(language==='pt')return data;
    try{
      if(typeof data==='string')return (await translateTexts([data],language))[0];
      return await translatePayload(data,language);
    }catch(e){store.log('aviso',`Tradução privada para ${userId}: ${String(e.message).slice(0,300)}`);return data;}
  }
  const localizedReply=async(i,data)=>i.reply(await localizeFor(i.user.id,data));
  const localizedEdit=async(i,data)=>i.editReply(await localizeFor(i.user.id,data));
  const withTranslator=payload=>{
    if(!translationReady()||!payload?.embeds?.length)return payload;
    const components=(payload.components||[]).map(r=>({...r,components:[...(r.components||[])]}));
    if(components.some(r=>r.components?.some(c=>c.custom_id==='translate-message')))return {...payload,components};
    const control=button('Traduzir','translate-message',2);let placed=false;
    for(let n=components.length-1;n>=0;n--){
      const r=components[n];if(r.type===1&&r.components?.length<5&&r.components.every(c=>c.type===2)){r.components.push(control);placed=true;break;}
    }
    if(!placed&&components.length<5)components.push(row(control));
    return {...payload,components};
  };
  const styledPayload=(style,variables={},guildId=env.DISCORD_GUILD_ID||'')=>withTranslator(stylePayload(style,variables,guildId));
  async function translatedMessageEdit(i,message,language){
    const target=normalizeLanguage(language),raw={content:message.content||undefined,embeds:(message.embeds||[]).map(e=>e.toJSON?e.toJSON():e)};
    const translated=await translatePayload(raw,target);
    translated.components=[];translated.allowedMentions=safe;
    const header=`🌐 **${languageLabel(target)}**`;
    translated.content=translated.content?`${header}\n${translated.content}`:header;
    await i.editReply(translated);
  }

  const requireGuild=()=>{if(!client.isReady())throw new AppError('Conecte o bot ao Discord antes desta ação.',503);const guild=client.guilds.cache.get(env.DISCORD_GUILD_ID);if(!guild)throw new AppError('O bot não está no servidor configurado.',503);return guild;};
  const channel=async channelId=>{const c=await requireGuild().channels.fetch(channelId);if(!c?.isTextBased()||!('send' in c))throw new AppError('Escolha um canal de texto do servidor.');return c;};
  async function applyVoicePresence(){
    if(!client.isReady())return null;
    const guild=requireGuild(),guildId=guild.id||env.DISCORD_GUILD_ID,cfg=store.settings().voicePresence||{},existing=getVoiceConnection(guildId);
    if(!cfg.enabled||!cfg.channelId){if(existing)existing.destroy();return null;}
    const voice=await guild.channels.fetch(cfg.channelId);
    if(!voice||voice.type!==ChannelType.GuildVoice)throw new AppError('Escolha um canal de voz normal para a presença do bot.');
    if(existing&&existing.joinConfig.channelId===voice.id&&existing.state.status!==VoiceConnectionStatus.Destroyed)return existing;
    if(existing)existing.destroy();
    const connection=joinVoiceChannel({channelId:voice.id,guildId,adapterCreator:guild.voiceAdapterCreator,selfDeaf:true,selfMute:true});
    try{await entersState(connection,VoiceConnectionStatus.Ready,15000);}
    catch(e){connection.destroy();throw new AppError('Não foi possível conectar o bot ao canal de voz. Confira a permissão Conectar.',503);}
    return connection;
  }
  const member=async userId=>requireGuild().members.fetch(userId);
  const memberVariables=async(userId,guild=requireGuild())=>{
    const m=await member(userId);
    return {user:`<@${userId}>`,username:m.displayName||m.user.globalName||m.user.username||userId,server:guild.name};
  };
  function createFeedbackRequest(type,sourceId,userId,meta={}){
    const cfg=store.settings().feedback;
    if(!cfg?.enabled||!cfg.channelId||(type==='ticket'&&!cfg.tickets)||(type==='order'&&!cfg.orders))return null;
    const existing=store.one('SELECT * FROM feedback_requests WHERE type=? AND source_id=?',type,sourceId);
    if(existing)return existing;
    const id=randomUUID();
    store.run('INSERT INTO feedback_requests(id,type,source_id,user_id,status,meta,created) VALUES(?,?,?,?,?,?,?)',id,type,sourceId,userId,'pending',JSON.stringify(meta),store.now());
    return store.one('SELECT * FROM feedback_requests WHERE id=?',id);
  }
  async function publishFeedback(request,rating,comment,user){
    const settings=store.settings(),cfg=settings.feedback;
    if(!cfg?.enabled||!cfg.channelId)throw new AppError('O canal de feedback ainda não foi configurado.',503);
    const meta=JSON.parse(request.meta||'{}'),source=request.type==='ticket'?'Atendimento':'Compra';
    const reference=request.type==='ticket'
      ? (meta.ticket||request.source_id.slice(0,8))
      : (meta.product?`${meta.product} · #${request.source_id.slice(0,8)}`:`#${request.source_id.slice(0,8)}`);
    const vars={
      user:`<@${request.user_id}>`,
      username:user.globalName||user.username||request.user_id,
      source,
      reference,
      rating:String(rating),
      stars:feedbackStars(rating),
      comment
    };
    const payload=styledPayload(settings.messageStyles.feedback,vars,env.DISCORD_GUILD_ID);
    const message=await(await channel(cfg.channelId)).send({...payload,allowedMentions:{parse:[],users:[],roles:[],repliedUser:false}});
    await audit('feedback',`${source} avaliado com ${rating}/5 por ${request.user_id}.`,request.user_id);
    return message;
  }
  const snowflakeCreatedAt=userId=>Number((BigInt(userId)>>22n)+1420070400000n);
  const googleConfigured=()=>!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET);
  async function youtubeAccessToken(userId){
    if(!googleConfigured())throw new AppError('A integração com o YouTube ainda não foi configurada.',503);
    const account=store.one('SELECT * FROM youtube_accounts WHERE user_id=?',userId);
    if(!account)throw new AppError('Conecte sua conta do YouTube para verificar este requisito.',428);
    const refreshToken=store.decrypt(account.refresh_secret);
    const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,refresh_token:refreshToken,grant_type:'refresh_token'})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.access_token)throw new AppError('Não foi possível atualizar a autorização do YouTube. Conecte sua conta novamente.',428);
    return data.access_token;
  }
  async function youtubeApi(userId,path,params={}){
    const token=await youtubeAccessToken(userId),url=new URL(`https://www.googleapis.com/youtube/v3/${path}`);
    for(const [key,value] of Object.entries(params))if(value!==undefined&&value!==null&&value!=='')url.searchParams.set(key,String(value));
    const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new AppError(data?.error?.message||'O YouTube não permitiu verificar este requisito.',502);
    return data;
  }
  async function resolveYoutubeChannel(userId,value){
    const ref=youtubeChannelRef(value);if(ref.id)return ref.id;
    if(!ref.handle)throw new AppError('Canal do YouTube inválido no requisito.');
    const data=await youtubeApi(userId,'channels',{part:'id',forHandle:ref.handle});
    return data.items?.[0]?.id||'';
  }
  const requirementLabel=req=>({
    verified:'Verificação Studio K',
    role:'Cargo obrigatório',
    accountAge:`Conta Discord com ${req.days} dia(s)`,
    serverAge:`No servidor há ${req.days} dia(s)`,
    invites:`Convidar ${req.count} pessoa(s)`,
    youtubeSubscription:`Inscrição no YouTube: ${req.channel}`,
    youtubeLike:`Like no vídeo: ${req.video}`,
    reaction:'Reagir à mensagem indicada',
    voiceMinutes:`${req.minutes} minuto(s) em call`,
    manual:req.label
  }[req.type]||req.type);
  async function checkReaction(req,userId){
    const c=await channel(req.channelId),message=await c.messages.fetch(req.messageId);
    const customId=String(req.emoji).match(/<a?:[^:]+:(\d+)>/)?.[1]||(/^\d{17,20}$/.test(req.emoji)?req.emoji:'');
    const reaction=[...message.reactions.cache.values()].find(r=>customId?r.emoji.id===customId:(r.emoji.name===req.emoji||r.emoji.toString()===req.emoji));
    if(!reaction)return false;
    let after;
    for(let page=0;page<100;page++){
      const users=await reaction.users.fetch({limit:100,...(after?{after}:{})});
      if(users.has(userId))return true;
      if(users.size<100)break;
      after=users.last()?.id;
    }
    return false;
  }
  async function evaluateRequirement(giveaway,userId,req){
    const m=await member(userId),label=requirementLabel(req);
    try{
      if(req.type==='verified'){
        const ok=!!store.one('SELECT user_id FROM verifications WHERE user_id=?',userId);return{id:req.id,type:req.type,label,ok,detail:ok?'Verificação concluída.':'Conclua a verificação Studio K.'};
      }
      if(req.type==='role'){
        const ok=m.roles.cache.has(req.roleId);return{id:req.id,type:req.type,label,ok,detail:ok?'Cargo encontrado.':'Você ainda não possui o cargo exigido.'};
      }
      if(req.type==='accountAge'){
        const days=Math.floor((Date.now()-m.user.createdTimestamp)/86400000),ok=days>=req.days;return{id:req.id,type:req.type,label,ok,detail:`${days}/${req.days} dia(s).`};
      }
      if(req.type==='serverAge'){
        const days=Math.floor((Date.now()-(m.joinedTimestamp||Date.now()))/86400000),ok=days>=req.days;return{id:req.id,type:req.type,label,ok,detail:`${days}/${req.days} dia(s) no servidor.`};
      }
      if(req.type==='invites'){
        const rows=store.all('SELECT * FROM invite_joins WHERE giveaway_id=? AND inviter_user_id=? AND left_at IS NULL',giveaway.id,userId);let valid=0;
        for(const row of rows){
          if(req.minStayHours&&Date.now()-Date.parse(row.joined_at)<req.minStayHours*3600000)continue;
          if(req.minAccountDays&&Date.now()-snowflakeCreatedAt(row.joined_user_id)<req.minAccountDays*86400000)continue;
          if(req.requireVerified&&!store.one('SELECT user_id FROM verifications WHERE user_id=?',row.joined_user_id))continue;
          valid++;
        }
        return{id:req.id,type:req.type,label,ok:valid>=req.count,detail:`${valid}/${req.count} convite(s) válido(s).`,invites:valid};
      }
      if(req.type==='youtubeSubscription'){
        if(!store.one('SELECT user_id FROM youtube_accounts WHERE user_id=?',userId))return{id:req.id,type:req.type,label,ok:false,needsYoutube:true,detail:'Conecte sua conta do YouTube.'};
        const channelId=await resolveYoutubeChannel(userId,req.channel);if(!channelId)return{id:req.id,type:req.type,label,ok:false,detail:'Canal do YouTube não encontrado.'};
        const yt=await youtubeApi(userId,'subscriptions',{part:'id',mine:'true',forChannelId:channelId,maxResults:1});
        const ok=!!yt.items?.length;return{id:req.id,type:req.type,label,ok,detail:ok?'Inscrição confirmada.':'A inscrição não foi encontrada.'};
      }
      if(req.type==='youtubeLike'){
        if(!store.one('SELECT user_id FROM youtube_accounts WHERE user_id=?',userId))return{id:req.id,type:req.type,label,ok:false,needsYoutube:true,detail:'Conecte sua conta do YouTube.'};
        const videoId=youtubeVideoId(req.video);if(!videoId)return{id:req.id,type:req.type,label,ok:false,detail:'Vídeo do YouTube inválido.'};
        const yt=await youtubeApi(userId,'videos/getRating',{id:videoId});
        const rating=yt.items?.[0]?.rating||'none',ok=rating==='like';return{id:req.id,type:req.type,label,ok,detail:ok?'Like confirmado.':'O vídeo ainda não está marcado com like.'};
      }
      if(req.type==='reaction'){
        const ok=await checkReaction(req,userId);return{id:req.id,type:req.type,label,ok,detail:ok?'Reação encontrada.':'A reação exigida ainda não foi encontrada.'};
      }
      if(req.type==='voiceMinutes'){
        const row=store.one('SELECT * FROM giveaway_voice WHERE giveaway_id=? AND user_id=?',giveaway.id,userId);let seconds=Number(row?.seconds||0);
        if(row?.joined_at)seconds+=Math.max(0,Math.floor((Date.now()-Date.parse(row.joined_at))/1000));
        const minutes=Math.floor(seconds/60),ok=seconds>=req.minutes*60;return{id:req.id,type:req.type,label,ok,detail:`${minutes}/${req.minutes} minuto(s) em call.`};
      }
      if(req.type==='manual'){
        const ok=!!store.one('SELECT 1 FROM giveaway_manual WHERE giveaway_id=? AND user_id=? AND requirement_id=?',giveaway.id,userId,req.id);return{id:req.id,type:req.type,label,ok,manual:true,detail:ok?'Aprovado pela equipe.':'Aguardando aprovação da equipe.'};
      }
      return{id:req.id,type:req.type,label,ok:false,detail:'Requisito desconhecido.'};
    }catch(e){
      return{id:req.id,type:req.type,label,ok:false,error:true,needsYoutube:e?.status===428,detail:String(e.message||e).slice(0,300)};
    }
  }
  async function evaluateGiveaway(giveawayId,userId,{enter=true,record=true}={}){
    const giveaway=store.one('SELECT * FROM giveaways WHERE id=?',giveawayId);if(!giveaway)throw new AppError('Sorteio não encontrado.',404);
    const data=JSON.parse(giveaway.data),requirements=[...(data.requirements||[])];
    if(data.requiredRoleId&&!requirements.some(r=>r.type==='role'&&r.roleId===data.requiredRoleId))requirements.unshift({id:'legacy-role',type:'role',roleId:data.requiredRoleId});
    const results=[];for(const req of requirements)results.push(await evaluateRequirement(giveaway,userId,req));
    const ok=results.every(r=>r.ok);
    if(record)store.run('INSERT INTO giveaway_attempts(giveaway_id,user_id,status,detail,updated) VALUES(?,?,?,?,?) ON CONFLICT(giveaway_id,user_id) DO UPDATE SET status=excluded.status,detail=excluded.detail,updated=excluded.updated',giveawayId,userId,ok?'eligible':'incomplete',JSON.stringify(results),store.now());
    if(enter){if(ok)store.run('INSERT OR IGNORE INTO entries VALUES(?,?)',giveawayId,userId);else store.run('DELETE FROM entries WHERE giveaway_id=? AND user_id=?',giveawayId,userId);}
    void updateGiveawaysLive(true);
    return{ok,results,data,giveaway};
  }
  async function createGoogleConnectUrl(giveawayId,userId){
    if(!googleConfigured())return'';
    const raw=randomBytes(32).toString('base64url'),digest=createHash('sha256').update(raw).digest('hex');
    store.set(`google-link:${digest}`,{giveawayId,userId,expires:Date.now()+10*60000});
    return `${String(env.PUBLIC_URL||'').replace(/\/$/,'')}/api/oauth/google/start?t=${encodeURIComponent(raw)}`;
  }
  async function giveawayInviteUrl(giveawayId,userId){
    const existing=store.one('SELECT code FROM giveaway_invites WHERE giveaway_id=? AND user_id=?',giveawayId,userId);if(existing)return`https://discord.gg/${existing.code}`;
    const giveaway=store.one('SELECT * FROM giveaways WHERE id=?',giveawayId);if(!giveaway)throw new AppError('Sorteio não encontrado.',404);
    const data=JSON.parse(giveaway.data),c=await channel(data.channelId);
    if(typeof c.createInvite!=='function')throw new AppError('O canal do sorteio não permite criar convites.');
    const invite=await c.createInvite({maxAge:0,maxUses:0,unique:true,reason:`Studio K: convite do sorteio para ${userId}`});
    store.run('INSERT INTO giveaway_invites(giveaway_id,user_id,code,created) VALUES(?,?,?,?)',giveawayId,userId,invite.code,store.now());
    inviteCache.set(invite.code,invite.uses||0);return invite.url;
  }
  async function refreshInviteCache(guild=requireGuild()){
    try{const invites=await guild.invites.fetch();inviteCache=new Map([...invites.values()].map(inv=>[inv.code,inv.uses||0]));}
    catch(e){store.log('aviso',`Não foi possível ler convites do servidor: ${String(e.message).slice(0,300)}`);}
  }
  async function attributeInvite(memberJoined){
    try{
      const current=await memberJoined.guild.invites.fetch(),changed=[];
      for(const inv of current.values()){
        const before=inviteCache.get(inv.code)||0;
        if((inv.uses||0)>before)changed.push(inv);
      }
      inviteCache=new Map([...current.values()].map(inv=>[inv.code,inv.uses||0]));
      if(changed.length===1){
        const inv=changed[0],now=store.now(),owner=store.one('SELECT giveaway_id,user_id FROM giveaway_invites WHERE code=?',inv.code);
        const inviterId=owner?.user_id||inv.inviterId||inv.inviter?.id||'';
        if(inviterId&&inviterId!==memberJoined.id){
          store.run('INSERT INTO referral_joins(joined_user_id,inviter_user_id,code,joined_at,left_at) VALUES(?,?,?,?,NULL) ON CONFLICT(joined_user_id) DO UPDATE SET inviter_user_id=excluded.inviter_user_id,code=excluded.code,joined_at=excluded.joined_at,left_at=NULL',memberJoined.id,inviterId,inv.code,now);
        }
        if(owner)store.run('INSERT INTO invite_joins(giveaway_id,joined_user_id,inviter_user_id,code,joined_at,left_at) VALUES(?,?,?,?,?,NULL) ON CONFLICT(giveaway_id,joined_user_id) DO UPDATE SET inviter_user_id=excluded.inviter_user_id,code=excluded.code,joined_at=excluded.joined_at,left_at=NULL',owner.giveaway_id,memberJoined.id,owner.user_id,inv.code,now);
        void updateInviteRankingLive(true);
      }
    }catch(e){store.log('aviso',`Não foi possível atribuir convite de ${memberJoined.id}: ${String(e.message).slice(0,300)}`);}
  }
  function stopVoiceForUser(userId,at=Date.now()){
    for(const row of store.all('SELECT * FROM giveaway_voice WHERE user_id=? AND joined_at IS NOT NULL',userId)){
      const seconds=Math.max(0,Math.floor((at-Date.parse(row.joined_at))/1000));
      store.run('UPDATE giveaway_voice SET seconds=seconds+?,joined_at=NULL WHERE giveaway_id=? AND user_id=?',seconds,row.giveaway_id,userId);
    }
  }
  function startVoiceForUser(userId,at=store.now()){
    for(const g of store.all("SELECT id,data FROM giveaways WHERE status='active'")){
      const data=JSON.parse(g.data);if(!(data.requirements||[]).some(r=>r.type==='voiceMinutes'))continue;
      store.run('INSERT INTO giveaway_voice(giveaway_id,user_id,seconds,joined_at) VALUES(?,?,0,?) ON CONFLICT(giveaway_id,user_id) DO UPDATE SET joined_at=COALESCE(giveaway_voice.joined_at,excluded.joined_at)',g.id,userId,at);
    }
  }
  const status=()=>({connected:client.isReady()&&client.guilds.cache.has(env.DISCORD_GUILD_ID),configured:!!env.DISCORD_TOKEN,name:client.user?.username||'Studio K',guild:client.guilds.cache.get(env.DISCORD_GUILD_ID)?.name||null,members:client.guilds.cache.get(env.DISCORD_GUILD_ID)?.memberCount||0,latency:client.ws.ping,error});
  const auditActor=value=>{
    const raw=String(value??'Discord');
    return /^\d{17,20}$/.test(raw)?`<@${raw}>`:raw;
  };
  const logCategory=type=>{
    const t=String(type||'').toLowerCase();
    if(t.includes('ticket'))return 'tickets';
    if(t.startsWith('membro entrou')||t.startsWith('membro saiu')||t.startsWith('membro expulso'))return 'members';
    if(t.startsWith('mensagem '))return 'messages';
    if(t.includes('banido')||t.includes('desbanido')||t.includes('call'))return 'moderation';
    if(t.startsWith('canal '))return 'channels';
    if(t.startsWith('cargo '))return 'roles';
    if(t.includes('verificação'))return 'verification';
    if(t.includes('entrega')||t.includes('venda')||t.includes('pedido'))return 'sales';
    if(t.includes('feedback'))return 'feedback';
    return 'system';
  };
  const configuredLogChannels=logs=>[logs.channelId,logs.ticketsChannelId,logs.membersChannelId,logs.messagesChannelId,logs.moderationChannelId,logs.channelsChannelId,logs.rolesChannelId,logs.verificationChannelId,logs.salesChannelId,logs.systemChannelId,logs.feedbackChannelId].filter(Boolean);
  const previewText=value=>String(value??'').replace(/\s+/g,' ').trim().slice(0,500);
  const inferAuditTarget=(detail,actor)=>{
    const ids=[...String(detail||'').matchAll(/<@!?(\d{17,20})>/g)].map(m=>m[1]);
    const actorId=/^\d{17,20}$/.test(String(actor||''))?String(actor):'';
    return ids.find(id=>id!==actorId)||ids[0]||'';
  };
  async function audit(type,detail,actor='Discord',meta={}){
    const normalized={...meta};
    normalized.targetId=String(normalized.targetId||inferAuditTarget(detail,actor)||'');
    normalized.channelId=String(normalized.channelId||'');
    normalized.previewBefore=previewText(normalized.previewBefore);
    normalized.previewAfter=previewText(normalized.previewAfter);
    store.log(type,detail,actor,normalized);
    const logs=store.settings().logs,category=logCategory(type);
    if(logs[category]===false)return;
    const cid=logs[`${category}ChannelId`]||logs.channelId;
    if(cid&&client.isReady())try{
      const style=store.settings().messageStyles.logs;
      const payload=styledPayload(style,{type,detail:String(detail).slice(0,4000),actor:auditActor(actor)},env.DISCORD_GUILD_ID);
      if(payload.embeds?.[0]){
        const fields=[...(payload.embeds[0].fields||[])];
        fields.push({name:'Ator',value:auditActor(actor),inline:true});
        fields.push({name:'Afetado',value:normalized.targetId?`<@${normalized.targetId}>`:(normalized.targetLabel||'Não se aplica'),inline:true});
        if(normalized.channelId)fields.push({name:'Canal',value:`<#${normalized.channelId}>`,inline:true});
        if(normalized.previewBefore)fields.push({name:normalized.previewAfter?'Antes':'Mensagem',value:`\`\`\`
${normalized.previewBefore}
\`\`\``.slice(0,1024),inline:false});
        if(normalized.previewAfter)fields.push({name:'Depois',value:`\`\`\`
${normalized.previewAfter}
\`\`\``.slice(0,1024),inline:false});
        if(normalized.timeline)fields.push({name:'Histórico do atendimento',value:String(normalized.timeline).slice(0,1024),inline:false});
        if(normalized.transcriptUrl)fields.push({name:'Transcript',value:`[Abrir transcript](${normalized.transcriptUrl})`,inline:false});
        payload.embeds[0].fields=fields.slice(0,25);
      }
      if(normalized.transcriptUrl)payload.components=[...(payload.components||[]).slice(0,4),row(linkButton('Abrir transcript',normalized.transcriptUrl))];
      await(await channel(cid)).send({...payload,allowedMentions:mentionPolicy(payload)});
    }catch{store.log('erro',`Não foi possível publicar o log de ${category} no Discord.`);}
  }
  const uniqueRoleIds=values=>[...new Set((values||[]).filter(Boolean))];
  const verificationRoleIds=v=>uniqueRoleIds([...(v?.roleIds||[]),...(v?.roleId?[v.roleId]:[])]);
  const staffRoleIds=settings=>{
    const global=uniqueRoleIds([...(settings?.roleGroups?.staff||[]),...(settings?.roleGroups?.highStaff||[])]);
    return global.length?global:uniqueRoleIds([...(settings?.tickets?.staffRoleIds||[]),...(settings?.tickets?.staffRoleId?[settings.tickets.staffRoleId]:[])]);
  };
  async function assignRoles(userId,roleIds){
    const ids=uniqueRoleIds(roleIds);if(!ids.length)return;
    const guild=requireGuild(),me=await guild.members.fetchMe(),roles=[];
    for(const roleId of ids){
      const role=await guild.roles.fetch(roleId);
      if(!role||role.managed||role.id===guild.id||role.permissions.has(PermissionFlagsBits.Administrator)||role.position>=me.roles.highest.position)throw new AppError('Todos os cargos configurados precisam existir, não podem ser administrativos e devem ficar abaixo do cargo do bot.');
      roles.push(role);
    }
    await(await member(userId)).roles.add(roles,'Studio K: cargos configurados');
  }
  async function assignRole(userId,roleId){return assignRoles(userId,roleId?[roleId]:[]);}

  async function verifyOAuthUser(user,language=''){
    const settings=store.settings(),v=settings.verification;
    if(language)saveLanguage(user.id,language);
    if(!v.oauthEnabled)throw new AppError('A verificação OAuth não está ativada.');
    const roles=verificationRoleIds(v);if(!roles.length)throw new AppError('Configure ao menos um cargo liberado pela verificação.');
    const guild=requireGuild(),m=await member(user.id);
    if(Date.now()-m.user.createdTimestamp<v.minimumAccountDays*86400000)throw new AppError(`Sua conta precisa ter pelo menos ${v.minimumAccountDays} dias.`,403);
    await assignRoles(user.id,roles);
    const now=store.now(),username=String(user.global_name||user.username||m.user.username||user.id).slice(0,120);
    store.run('INSERT INTO verifications(user_id,username,verified_at,last_authorized_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,last_authorized_at=excluded.last_authorized_at',user.id,username,now,now);
    let dmSent=false;
    if(v.sendDm){
      try{
        const style=settings.messageStyles.verificationDm;
        const roleText=roles.map(id=>`<@&${id}>`).join(', '),payload=styledPayload(style,{user:`<@${user.id}>`,username,server:guild.name,role:roleText,roles:roleText},env.DISCORD_GUILD_ID),localized=await localizeFor(user.id,payload);await m.send({...localized,allowedMentions:mentionPolicy(localized)});
        dmSent=true;
      }catch(e){store.log('aviso',`Verificação concluída para ${user.id}, mas a DM não pôde ser entregue: ${String(e.message).slice(0,300)}`);}
    }
    await audit('verificação',`<@${user.id}> concluiu a verificação e recebeu os cargos configurados.`,user.id,{targetId:user.id});
    void updateLivePanels(true);
    return {userId:user.id,username,dmSent};
  }
  async function completeNativeVerification(i,language){
    const settings=store.settings(),v=settings.verification,roles=verificationRoleIds(v);
    if(!roles.length)throw new AppError('A verificação ainda não possui cargos configurados.');
    if(Date.now()-i.user.createdTimestamp<v.minimumAccountDays*86400000)throw new AppError(`Sua conta precisa ter pelo menos ${v.minimumAccountDays} dias.`);
    const chosen=saveLanguage(i.user.id,language);
    await assignRoles(i.user.id,roles);
    const guild=requireGuild(),m=await member(i.user.id),now=store.now(),username=String(i.member?.displayName||i.user.globalName||i.user.username||i.user.id).slice(0,120);
    store.run('INSERT INTO verifications(user_id,username,verified_at,last_authorized_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,last_authorized_at=excluded.last_authorized_at',i.user.id,username,now,now);
    if(v.sendDm){
      try{
        const roleText=roles.map(id=>`<@&${id}>`).join(', '),payload=styledPayload(settings.messageStyles.verificationDm,{user:`<@${i.user.id}>`,username,server:guild.name,role:roleText,roles:roleText},env.DISCORD_GUILD_ID),localized=await localizeFor(i.user.id,payload);
        await m.send({...localized,allowedMentions:mentionPolicy(localized)});
      }catch(e){store.log('aviso',`Verificação nativa concluída para ${i.user.id}, mas a DM não pôde ser entregue: ${String(e.message).slice(0,300)}`);}
    }
    void updateLivePanels(true);
    const targetId=v.redirectChannelId||settings.welcome.channelId||'',components=targetId?[row(linkButton('Continuar no servidor',`https://discord.com/channels/${env.DISCORD_GUILD_ID}/${targetId}`))]:[];
    await localizedEdit(i,{content:`Verificação concluída. Idioma salvo: **${languageLabel(chosen)}**. Bem-vindo(a)!`,components});
  }
  async function sendMessage(data){
    const payload=withTranslator({content:data.content||undefined,embeds:data.embed?[embedPayload(data.embed)]:[],components:linkRows(data.buttons||[],env.DISCORD_GUILD_ID)});
    payload.allowedMentions=mentionPolicy(payload);
    let result;
    if(data.target==='dm'){
      if(!store.one('SELECT user_id FROM optins WHERE user_id=?',data.targetId))throw new AppError('O membro precisa ativar /notificacoes antes de receber mensagens deste editor.');
      const localized=await localizeFor(data.targetId,payload);localized.allowedMentions=mentionPolicy(localized);
      result=await(await member(data.targetId)).send(localized);
    }else{
      const c=await channel(data.targetId);
      if(data.webhookName){
        const hooks=await c.fetchWebhooks();let hook=hooks.find(h=>h.owner?.id===client.user.id&&h.name==='Studio K · mensagens');
        if(!hook)hook=await c.createWebhook({name:'Studio K · mensagens'});
        result=await hook.send({...payload,username:data.webhookName,avatarURL:data.webhookAvatar||undefined});
      }else result=await c.send(payload);
    }
    await audit('mensagem',`Mensagem enviada para ${data.targetId}.`,'painel');return{id:result.id};
  }
  const hasStaffPermission=async(i,key='ticketManage')=>{
    if(i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)||i.memberPermissions?.has(PermissionFlagsBits.Administrator))return true;
    const settings=store.settings(),explicit=[...(settings.permissions?.[key]||[])].filter(Boolean);
    const configured=explicit.length?explicit:(['ticketManage','ticketClose','ticketTransfer'].includes(key)?staffRoleIds(settings):[]);
    const ids=[...new Set(configured.filter(Boolean))];if(!ids.length)return false;
    const guild=requireGuild(),m=i.member?.roles?.cache?i.member:await guild.members.fetch(i.user.id);
    return ids.some(id=>m.roles.cache.has(id));
  };
  const isStaff=i=>hasStaffPermission(i,'ticketManage');
  async function memberProfile(userId){
    const guild=requireGuild(),m=await guild.members.fetch(userId);
    return{id:m.id,name:m.displayName||m.user.globalName||m.user.username||m.id,username:m.user.username||'',joinedAt:m.joinedAt?.toISOString?.()||null,createdAt:m.user.createdAt?.toISOString?.()||null,roles:[...m.roles.cache.values()].filter(r=>r.id!==guild.id).map(r=>({id:r.id,name:r.name})),avatar:m.displayAvatarURL({size:128})};
  }
  async function nextTicketName(category,guild){
    const slug=channelSlug(category),prefix=`${slug}-`;await guild.channels.fetch();
    let maxExisting=0;
    for(const c of guild.channels.cache.values()){
      if(!c?.name?.startsWith(prefix))continue;
      const suffix=c.name.slice(prefix.length);if(/^\d+$/.test(suffix))maxExisting=Math.max(maxExisting,Number(suffix));
    }
    const key=`ticket-seq:${slug}`;
    const number=store.transaction(()=>{
      const row=store.one('SELECT value FROM kv WHERE key=?',key);
      let current=0;try{current=row?Number(JSON.parse(row.value))||0:0;}catch{}
      const next=Math.max(current,maxExisting)+1;
      store.run('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(next));
      return next;
    });
    return `${slug}-${number}`.slice(0,100);
  }
  const ticketAuditKey=id=>`ticket-audit:${id}`;
  const ticketAuditRead=id=>store.get(ticketAuditKey(id),{events:[]});
  const ticketAuditWrite=(id,data)=>store.set(ticketAuditKey(id),data);
  const ticketAuditAppend=(id,event)=>{
    const data=ticketAuditRead(id),events=Array.isArray(data.events)?data.events:[];
    events.push({...event,at:event.at||store.now()});
    ticketAuditWrite(id,{...data,events:events.slice(-50)});
  };
  const ticketAuditFinish=id=>{const data=ticketAuditRead(id);store.run('DELETE FROM kv WHERE key=?',ticketAuditKey(id));return data;};
  const ticketEventLine=e=>{
    const actor=/^\d{17,20}$/.test(String(e.actor||''))?`<@${e.actor}>`:'Sistema';
    const target=/^\d{17,20}$/.test(String(e.target||''))?`<@${e.target}>`:'';
    if(e.action==='open')return `${actor} abriu o ticket`;
    if(e.action==='claim')return `${actor} assumiu o atendimento de ${target}`;
    if(e.action==='call')return `${actor} chamou ${target}${e.dmSent?' e enviou DM':''}`;
    if(e.action==='rename')return `${actor} renomeou **${e.from}** → **${e.to}**`;
    if(e.action==='close')return `${actor} encerrou o ticket de ${target}${e.reason?` · motivo: ${e.reason}`:''}`;
    if(e.action==='transfer')return `${actor} transferiu o atendimento para <@${e.to}>`;
    if(e.action==='state')return `${actor} alterou o status para **${e.state}**`;
    if(e.action==='priority')return `${actor} alterou a prioridade para **${e.priority}**`;
    if(e.action==='note')return `${actor} adicionou nota interna: ${String(e.note||'').slice(0,180)}`;
    if(e.action==='tags')return `${actor} atualizou as tags: ${(e.tags||[]).join(', ')||'nenhuma'}`;
    if(e.action==='reopen')return `${actor} reabriu o atendimento a partir do ticket anterior`;
    return e.label||e.action||'Ação registrada';
  };
  const ticketControlRows=(id,state='waiting_staff',claimed=false)=>{
    const top=[];
    if(!claimed)top.push(button('Assumir',`claim:${id}`,1));
    if(state!=='waiting_customer')top.push(button('Aguardar cliente',`status-direct:${id}:waiting_customer`,2));
    if(state!=='in_progress')top.push(button('Em atendimento',`status-direct:${id}:in_progress`,2));
    top.push(button('Prioridade',`priority:${id}`,2),button('Transferir',`transfer:${id}`,2));
    const bottom=[button('Nota interna',`note:${id}`,2),button('Renomear',`rename:${id}`,2),button('Chamar cliente',`call:${id}`,2),button('Tags',`tags:${id}`,2),button('Finalizar',`close:${id}`,4)];
    return [row(...top.slice(0,5)),row(...bottom.slice(0,5))];
  };
  async function refreshTicketControls(id){
    const t=store.one('SELECT * FROM tickets WHERE id=?',id),messageId=store.get(`ticket-controls:${id}`);if(!t||t.status!=='open'||!messageId)return;
    try{const ch=await channel(t.channel_id),msg=await ch.messages.fetch(messageId);await msg.edit({components:ticketControlRows(id,t.state,!!t.claimed_by)});}catch{}
  }
  async function openTicket(userId,category,options={}){
    const guild=requireGuild(),settings=store.settings(),ticketSettings=settings.tickets,configuredStaffIds=staffRoleIds(settings);
    if(!configuredStaffIds.length)throw new AppError('Configure ao menos um cargo de Staff ou Alta Staff em Configurações antes de abrir tickets.');
    await guild.roles.fetch();
    const staffRoles=[];
    for(const roleId of configuredStaffIds){
      const role=await guild.roles.fetch(roleId);
      if(role&&!role.managed&&role.id!==guild.id)staffRoles.push(role);
    }
    if(!staffRoles.length)throw new AppError('Nenhum dos cargos de Staff configurados existe mais no servidor.');
    const ticketName=await nextTicketName(category,guild),id=randomUUID(),now=store.now(),maxOpen=ticketSettings.maxOpen||TICKET_OPEN_LIMIT;
    const queuePosition=store.transaction(()=>{
      const open=Number(store.one("SELECT COUNT(*) AS n FROM tickets WHERE user_id=? AND status='open'",userId)?.n||0);
      if(open>=maxOpen)throw new AppError(`Você já possui ${maxOpen} ticket(s) aberto(s). Encerre um antes de abrir outro.`,409);
      const position=Number(store.one("SELECT COUNT(*) AS n FROM tickets WHERE status='open' AND state IN ('waiting_staff','escalated')")?.n||0)+1;
      store.run('INSERT INTO tickets(id,user_id,category,status,state,priority,created,updated,reopened_from,tags) VALUES(?,?,?,?,?,?,?,?,?,?)',id,userId,category,'open','waiting_staff',options.priority||ticketSettings.defaultPriority||'normal',now,now,options.reopenedFrom||null,JSON.stringify(options.tags||[]));
      return position;
    });
    let c;
    try{
      const staffPermissions=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles,PermissionFlagsBits.ManageMessages];
      c=await guild.channels.create({name:ticketName,type:ChannelType.GuildText,parent:ticketSettings.categoryId||undefined,permissionOverwrites:[
        {id:guild.id,deny:[PermissionFlagsBits.ViewChannel]},
        {id:userId,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles]},
        {id:client.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageChannels,PermissionFlagsBits.ManageMessages]},
        ...staffRoles.map(r=>({id:r.id,allow:staffPermissions}))
      ]});
      store.run('UPDATE tickets SET channel_id=? WHERE id=?',c.id,id);
      const customerVars={...(await memberVariables(userId,guild)),category,ticket:ticketName,channel:`<#${c.id}>`};
      const customerPayload=styledPayload(settings.messageStyles.ticketOpen,customerVars,env.DISCORD_GUILD_ID);
      await c.send({...customerPayload,allowedMentions:mentionPolicy(customerPayload,[userId])});
      const staffPayload=styledPayload(settings.messageStyles.ticketStaffPanel,customerVars,env.DISCORD_GUILD_ID);
      const controlMessage=await c.send({...staffPayload,components:[...(staffPayload.components||[]),...ticketControlRows(id,'waiting_staff',false)],allowedMentions:mentionPolicy(staffPayload)});
      store.set(`ticket-controls:${id}`,controlMessage.id);
      ticketAuditWrite(id,{events:[{action:options.reopenedFrom?'reopen':'open',actor:userId,target:userId,at:now}],ticketName,category,openedBy:userId,openedAt:now,channelId:c.id,reopenedFrom:options.reopenedFrom||''});void updateOperationsLive(true);return {...store.one('SELECT * FROM tickets WHERE id=?',id),queuePosition};
    }catch(e){
      if(!c)store.run('DELETE FROM tickets WHERE id=?',id);
      else store.log('erro',`Ticket ${id.slice(0,8)} criado, mas mensagem inicial falhou.`);
      throw e;
    }
  }
  async function closeTicket(id,actor,reason=''){
    const ticket=store.one('SELECT * FROM tickets WHERE id=?',id);if(!ticket)throw new AppError('Ticket não encontrado.',404);if(ticket.status==='closed')return;
    const c=await channel(ticket.channel_id),messages=[];let before;
    for(let page=0;page<50;page++){const batch=await c.messages.fetch({limit:100,before});if(!batch.size)break;messages.push(...batch.values());before=batch.last().id;if(batch.size<100)break;}
    const ticketName=c.name;
    const transcript=messages.reverse().map(m=>`[${m.createdAt.toISOString()}] ${m.author?.tag||'desconhecido'} (${m.author?.id||''}): ${m.content||''}${m.attachments.size?'\n'+[...m.attachments.values()].map(a=>a.url).join('\n'):''}${m.embeds.length?'\n'+m.embeds.map(e=>[e.title,e.description].filter(Boolean).join('\n')).join('\n'):''}`).join('\n\n');
    const shareToken=randomBytes(32).toString('base64url'),now=store.now();
    store.run("UPDATE tickets SET transcript=?,status='closed',state='closed',closed_reason=?,updated=? WHERE id=?",transcript,String(reason||'').slice(0,500)||null,now,id);
    store.set(`transcript-share:${id}`,{hash:createHash('sha256').update(shareToken).digest('hex'),created:now});
    const publicBase=(env.PUBLIC_URL||'').replace(/\/$/,'');
    const transcriptUrl=`${publicBase}/api/public/tickets/${id}/transcript/${shareToken}`;
    let dmSent=false;
    try{
      const user=await member(ticket.user_id),settings=store.settings(),style=settings.messageStyles.ticketClose;
      const closeVars={user:`<@${ticket.user_id}>`,username:user.displayName||user.user.globalName||user.user.username||ticket.user_id,server:c.guild.name,ticket:ticketName,transcript:transcriptUrl,category:ticket.category};
      const closePayload=styledPayload(style,closeVars,env.DISCORD_GUILD_ID),feedback=createFeedbackRequest('ticket',id,ticket.user_id,{ticket:ticketName,category:ticket.category,staffId:ticket.claimed_by||actor||''});
      const reopenButton=store.settings().tickets.allowReopen?button('Reabrir atendimento',`reopen:${id}`,2):null;
      const finalButtons=[linkButton('Abrir transcript',transcriptUrl),...(feedback?[button('Dar feedback',`feedback:${feedback.id}`,2)]:[]),...(reopenButton?[reopenButton]:[])];
      const finalRow=row(...finalButtons);
      const closeMessage={...closePayload,components:[...(closePayload.components||[]).slice(0,4),finalRow],allowedMentions:mentionPolicy(closePayload,[ticket.user_id])},localizedClose=await localizeFor(ticket.user_id,closeMessage);
      await user.send({...localizedClose,allowedMentions:mentionPolicy(localizedClose,[ticket.user_id])});
      dmSent=true;
    }catch(e){
      store.log('aviso',`Ticket ${ticketName} encerrado, mas a DM com o transcript não pôde ser entregue: ${String(e.message).slice(0,300)}`,actor);
    }
    ticketAuditAppend(id,{action:'close',actor,target:ticket.user_id,dmSent,reason:String(reason||'').slice(0,500)});if(/^\d{17,20}$/.test(String(actor||'')))store.recordStaffAction(actor,'close',id,ticket.user_id,{reason:String(reason||'').slice(0,500)});
    const ticketAudit=ticketAuditFinish(id),events=Array.isArray(ticketAudit.events)?ticketAudit.events:[],openedAt=ticketAudit.openedAt||ticket.created,closedAt=now;
    const durationMs=Math.max(0,Date.parse(closedAt)-Date.parse(openedAt)),durationMinutes=Math.floor(durationMs/60000);
    const persistedNotes=store.all('SELECT actor,note,created FROM ticket_notes WHERE ticket_id=? ORDER BY created',id).map(n=>({action:'note',actor:n.actor,target:ticket.user_id,note:n.note,at:n.created}));
    const seenNotes=new Set(events.filter(e=>e.action==='note').map(e=>String(e.note||'')+'|'+String(e.actor||'')));
    const timeline=[...events,...persistedNotes.filter(n=>!seenNotes.has(String(n.note||'')+'|'+String(n.actor||'')))].sort((a,b)=>Date.parse(a.at||openedAt)-Date.parse(b.at||openedAt)).map(ticketEventLine);
    const summary=[
      `**Cliente:** <@${ticket.user_id}>`,
      `**Categoria:** ${ticket.category}`,
      `**Ticket:** ${ticketName}`,
      `**Aberto:** <t:${Math.floor(Date.parse(openedAt)/1000)}:F>`,
      `**Finalizado:** <t:${Math.floor(Date.parse(closedAt)/1000)}:F>`,
      `**Duração:** ${durationMinutes} min`,
      `**Responsável final:** ${/^\d{17,20}$/.test(String(actor))?`<@${actor}>`:'Sistema'}`,
      ...(reason?[`**Motivo do encerramento:** ${String(reason).slice(0,500)}`]:[]),
      `**Transcript:** ${transcriptUrl}`
    ].join('\n');
    const timelineText=timeline.length?timeline.map((line,index)=>`${index+1}. ${line}`).join('\n'):'Nenhuma ação intermediária registrada.';
    await audit('ticket finalizado',summary,actor,{targetId:ticket.user_id,channelId:ticket.channel_id,ticketId:id,ticketName,category:ticket.category,action:'close',transcriptUrl,dmSent,openedAt,closedAt,durationMinutes,timeline:timelineText});
    store.run('DELETE FROM kv WHERE key=?',`ticket-controls:${id}`);
    try{await c.delete(`Studio K: ticket encerrado por ${actor}`);}
    catch(e){store.log('erro',`Ticket ${ticketName} foi encerrado, mas o canal não pôde ser removido: ${String(e.message).slice(0,300)}`,actor);throw new AppError('O atendimento foi encerrado e o transcript salvo, mas não foi possível apagar o canal. Confira a permissão Gerenciar Canais do bot.',500);}
    void updateOperationsLive(true);
    return {dmSent,transcriptUrl};
  }
  async function publishPanel(kind,channelId){
    const s=store.settings(),c=await channel(channelId),guild=requireGuild(),staticVars={server:guild.name,count:String(guild.memberCount)};let payload;
    if(kind==='tickets'){
      payload=styledPayload(s.messageStyles.ticketPanel,staticVars,env.DISCORD_GUILD_ID);payload.components=[...(payload.components||[]),row(button(s.tickets.button,'ticket-open',1))];
    }else if(kind==='commandCenter'){
      payload=styledPayload(s.messageStyles.commandCenter,staticVars,env.DISCORD_GUILD_ID);
      payload.components=[...(payload.components||[]),
        row(button('🛒 Loja','central-store',1),button('🎫 Atendimento','central-ticket',2),button('📦 Meus pedidos','central-orders',2),button('👤 Minha conta','central-profile',2)),
        row(button('🌎 Idioma','central-language',2),button('🎁 Sorteios','central-giveaways',2),button('❓ Ajuda','central-help',2))
      ];
    }else{
      const controls=[button(s.verification.button,'verify',1)];
      payload=styledPayload(s.messageStyles.verificationPanel,staticVars,env.DISCORD_GUILD_ID);payload.components=[...(payload.components||[]),row(...controls)];
    }
    const message=await c.send({...payload,allowedMentions:mentionPolicy(payload)});await audit('painel',`Painel de ${kind} publicado.`,'painel');return{id:message.id};
  }
  async function publishConfiguredMessage(source,key,channelId){
    const settings=store.settings(),c=await channel(channelId);
    if(source==='template'){
      if(!['welcome','goodbye'].includes(key))throw new AppError('Modelo de mensagem inválido.',400);
      const t=settings[key],variables={
        user:'@Cliente',
        username:'Cliente',
        server:requireGuild().name,
        count:String(requireGuild().memberCount)
      };
      const content=expandText(t.content||'',variables),e=embedPayload(t.embed||{},variables);
      const payload=withTranslator({
        content:content||undefined,
        embeds:hasEmbed(e)?[e]:[],
        components:linkRows(t.buttons||[],env.DISCORD_GUILD_ID)
      });
      payload.allowedMentions=mentionPolicy(payload);
      const message=await c.send(payload);
      await audit('mensagem',`${key==='welcome'?'Boas-vindas':'Saída'} publicada separadamente pelo painel.`,'painel');
      return {id:message.id};
    }
    if(source!=='messageStyle')throw new AppError('Origem de mensagem inválida.',400);
    const allowed=['ticketPanel','ticketOpen','ticketStaffPanel','ticketClaim','ticketCall','ticketCallDm','ticketClose','verificationPanel','verificationDm','commandCenter','product','giveaway','giveawayResult','logs','orderDelivery'];
    if(!allowed.includes(key))throw new AppError('Modelo de embed inválido.',400);
    if(key==='ticketPanel')return publishPanel('tickets',channelId);
    if(key==='verificationPanel')return publishPanel('verification',channelId);if(key==='commandCenter')return publishPanel('commandCenter',channelId);
    const variables={
      user:'@Cliente',username:'Cliente',server:requireGuild().name,count:String(requireGuild().memberCount),
      category:'Orçamento',ticket:'orcamento-1',staff:'@Atendente',channel:'#canal-exemplo',
      product:'Produto exemplo',description:'Descrição do produto',price:'R$ 49,90',availability:'10 unidades',
      title:'Sorteio especial',ends:'em 2 horas',winners:'1',roleLine:'',result:'@Cliente',
      type:'ticket',detail:'Atendimento atualizado.',actor:'@Atendente',order:'ABC123',
      delivery:'CHAVE-EXEMPLO',instructions:'Siga as instruções enviadas.',role:'@Verificado',
      transcript:'https://studio-k-wmrj.netlify.app/transcript'
    };
    const payload=styledPayload(settings.messageStyles[key],variables,env.DISCORD_GUILD_ID);
    const message=await c.send({...payload,allowedMentions:mentionPolicy(payload)});
    await audit('mensagem',`Embed ${key} publicado separadamente pelo painel.`,'painel');
    return {id:message.id};
  }
  async function publishProduct(productId,channelId){
    const p=store.products().find(p=>p.id===productId);if(!p)throw new AppError('Produto não encontrado.',404);
    const availability=p.type==='service'?'Sob demanda':`${p.stock} unidade(s)`;
    const payload=styledPayload(store.settings().messageStyles.product,{product:p.name,description:p.description||'Peça pelo botão abaixo.',price:money(p.priceCents),availability,category:p.category});
    if(p.image&&payload.embeds[0]&&!payload.embeds[0].image)payload.embeds[0].image={url:p.image};
    const m=await(await channel(channelId)).send({...payload,components:[...(payload.components||[]),row(button('Comprar com Pix',`buy:${p.id}`))],allowedMentions:mentionPolicy(payload)});return{id:m.id};
  }
  async function orderText(order){
    const s=store.settings().sales,p=JSON.parse(order.product),discount=Number(order.discount||0);
    return[
      `**Pedido ${order.id}**`,
      `Produto: **${p.name}**`,
      `Valor: **${money(order.price)}**${discount?` (desconto de ${money(discount)})`:''}`,
      order.coupon_code?`Cupom: **${order.coupon_code}**`:'',
      '',
      `Chave Pix: **${s.pixKey}**`,
      `Recebedor: ${s.recipient}`,
      s.instructions,
      '',
      `Validade: <t:${Math.floor(Date.parse(order.expires)/1000)}:R>`,
      'Status: **Aguardando pagamento**'
    ].filter(Boolean).join('\n');
  }
  async function deliverOrder(order){
    const p=JSON.parse(order.product);
    try{
      if(!order.role_done){await assignRole(order.user_id,p.roleId);store.run('UPDATE orders SET role_done=1 WHERE id=?',order.id);}
      if(!order.delivery_done){
        let delivery;
        if(p.type==='digital'){const unit=store.one('SELECT secret FROM stock WHERE order_id=?',order.id);if(!unit)throw new Error('Estoque reservado não encontrado.');delivery=store.decrypt(unit.secret);}
        else{const ticket=await openTicket(order.user_id,`Serviço: ${p.name}`);delivery=`Seu atendimento: <#${ticket.channel_id}>`;}
        const user=await member(order.user_id),settings=store.settings(),style=settings.messageStyles.orderDelivery;
        const payload=styledPayload(style,{product:p.name,order:order.id,delivery,instructions:p.delivery||''});
        const feedback=p.type==='digital'?createFeedbackRequest('order',order.id,order.user_id,{product:p.name}):null;
        const components=[...(payload.components||[])].slice(0,4);
        if(feedback)components.push(row(button('Dar feedback',`feedback:${feedback.id}`,2)));
        const deliveryMessage={...payload,components,allowedMentions:mentionPolicy(payload),nonce:createHash('sha256').update(order.id).digest('hex').slice(0,24),enforceNonce:true},localizedDelivery=await localizeFor(order.user_id,deliveryMessage);
        await user.send({...localizedDelivery,allowedMentions:mentionPolicy(localizedDelivery),nonce:deliveryMessage.nonce,enforceNonce:true});
        store.run('UPDATE orders SET delivery_done=1 WHERE id=?',order.id);
      }
      store.run("UPDATE orders SET status='delivered',delivery_done=1,delivered_at=?,error=NULL WHERE id=?",store.now(),order.id);await audit('entrega',`Pedido ${order.id.slice(0,8)} entregue.`);
    }catch(e){store.run('UPDATE orders SET error=? WHERE id=?',String(e.message).slice(0,500),order.id);}
  }
  const currentWeek=()=>{
    const now=new Date(),start=new Date(now),offset=(start.getUTCDay()+6)%7;
    start.setUTCDate(start.getUTCDate()-offset);start.setUTCHours(0,0,0,0);
    const end=new Date(start.getTime()+7*86400000);
    return{start,end,key:start.toISOString().slice(0,10)};
  };
  async function updateSalesLive(force=false){
    const settings=store.settings(),cfg=settings.salesLive;if(!cfg?.enabled||!cfg.channelId||!client.isReady())return null;
    const {start,end,key}=currentWeek();
    const stats=store.one("SELECT COUNT(*) AS sales,COALESCE(SUM(price),0) AS revenue FROM orders WHERE status IN ('paid','delivered') AND COALESCE(approved_at,created)>=? AND COALESCE(approved_at,created)<?",start.toISOString(),end.toISOString());
    const state=store.get('sales-live-message',{}),signature=`${key}:${stats.sales}:${stats.revenue}:${cfg.channelId}`;
    if(!force&&state.signature===signature&&Date.now()-Number(state.checkedAt||0)<60000)return state;
    const vars={
      sales:String(stats.sales||0),
      revenue:money(Number(stats.revenue||0)),
      periodStart:`<t:${Math.floor(start.getTime()/1000)}:d>`,
      periodEnd:`<t:${Math.floor((end.getTime()-1000)/1000)}:d>`,
      updated:updatedRelative()
    };
    const payload=styledPayload(settings.messageStyles.salesLive,vars,env.DISCORD_GUILD_ID),c=await channel(cfg.channelId);
    let message=null;
    if(state.messageId&&state.channelId===cfg.channelId){
      try{message=await c.messages.fetch(state.messageId);await message.edit({...payload,allowedMentions:mentionPolicy(payload)});}catch{}
    }
    if(!message)message=await c.send({...payload,allowedMentions:mentionPolicy(payload)});
    const next={messageId:message.id,channelId:cfg.channelId,week:key,signature,checkedAt:Date.now()};store.set('sales-live-message',next);return next;
  }
  async function upsertLiveMessage(storageKey,cfg,style,vars,signature,force=false){
    if(!cfg?.enabled||!cfg.channelId||!client.isReady())return null;
    const state=store.get(storageKey,{});
    if(!force&&state.signature===signature&&Date.now()-Number(state.checkedAt||0)<60000)return state;
    const payload=styledPayload(style,vars,env.DISCORD_GUILD_ID),c=await channel(cfg.channelId);
    let message=null;
    if(state.messageId&&state.channelId===cfg.channelId){
      try{message=await c.messages.fetch(state.messageId);await message.edit({...payload,allowedMentions:mentionPolicy(payload)});}catch{}
    }
    if(!message)message=await c.send({...payload,allowedMentions:mentionPolicy(payload)});
    const next={messageId:message.id,channelId:cfg.channelId,signature,checkedAt:Date.now()};store.set(storageKey,next);return next;
  }
  const updatedRelative=()=>{
    const timeZone=process.env.APP_TIMEZONE||'America/Cuiaba';
    const time=new Intl.DateTimeFormat('pt-BR',{timeZone,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()).replace(':','h');
    return `hoje às ${time}`;
  };
  async function updateCommunityLive(force=false){
    const settings=store.settings(),cfg=settings.communityLive;if(!cfg?.enabled||!cfg.channelId||!client.isReady())return null;
    const guild=requireGuild(),{start,end,key}=currentWeek(),now=new Date();
    const dayStart=new Date(now);dayStart.setUTCHours(0,0,0,0);
    const dayEnd=new Date(dayStart.getTime()+86400000);
    const monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1));
    const monthEnd=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1));
    const sevenDayKey=new Date(Date.now()-6*86400000).toISOString().slice(0,10);
    const todayKey=dayStart.toISOString().slice(0,10);

    const newToday=Number(store.one("SELECT COUNT(*) AS n FROM member_events WHERE event='join' AND created>=? AND created<?",dayStart.toISOString(),dayEnd.toISOString())?.n||0);
    const newWeek=Number(store.one("SELECT COUNT(*) AS n FROM member_events WHERE event='join' AND created>=? AND created<?",start.toISOString(),end.toISOString())?.n||0);
    const leftWeek=Number(store.one("SELECT COUNT(*) AS n FROM member_events WHERE event='leave' AND created>=? AND created<?",start.toISOString(),end.toISOString())?.n||0);
    const newMonth=Number(store.one("SELECT COUNT(*) AS n FROM member_events WHERE event='join' AND created>=? AND created<?",monthStart.toISOString(),monthEnd.toISOString())?.n||0);
    const leftMonth=Number(store.one("SELECT COUNT(*) AS n FROM member_events WHERE event='leave' AND created>=? AND created<?",monthStart.toISOString(),monthEnd.toISOString())?.n||0);
    const verifiedWeek=Number(store.one("SELECT COUNT(*) AS n FROM verifications WHERE verified_at>=? AND verified_at<?",start.toISOString(),end.toISOString())?.n||0);
    const verifiedTotal=Number(store.one("SELECT COUNT(*) AS n FROM verifications")?.n||0);
    const messagesToday=Number(store.one("SELECT COALESCE(SUM(count),0) AS n FROM message_activity WHERE day=?",todayKey)?.n||0);
    const activeMembersWeek=Number(store.one("SELECT COUNT(DISTINCT user_id) AS n FROM message_activity WHERE day>=?",sevenDayKey)?.n||0);
    const voiceNow=[...guild.voiceStates.cache.values()].filter(v=>v.channelId&&v.member&&!v.member.user.bot).length;
    const boosts=Number(guild.premiumSubscriptionCount||0);
    const openTickets=Number(store.one("SELECT COUNT(*) AS n FROM tickets WHERE status='open'")?.n||0);

    const vars={
      members:String(guild.memberCount||0),
      newToday:String(newToday),
      newWeek:String(newWeek),
      leftWeek:String(leftWeek),
      growthWeek:String(newWeek-leftWeek),
      growthMonth:String(newMonth-leftMonth),
      verifiedWeek:String(verifiedWeek),
      verifiedTotal:String(verifiedTotal),
      voiceNow:String(voiceNow),
      boosts:String(boosts),
      openTickets:String(openTickets),
      messagesToday:String(messagesToday),
      activeMembersWeek:String(activeMembersWeek),
      updated:updatedRelative()
    };
    const signature=`${key}:${todayKey}:${guild.memberCount}:${newToday}:${newWeek}:${leftWeek}:${newMonth}:${leftMonth}:${verifiedWeek}:${verifiedTotal}:${voiceNow}:${boosts}:${openTickets}:${messagesToday}:${activeMembersWeek}:${cfg.channelId}`;
    return upsertLiveMessage('community-live-message',cfg,settings.messageStyles.communityLive,vars,signature,force);
  }
  async function updateGiveawaysLive(force=false){
    const settings=store.settings(),cfg=settings.giveawaysLive;if(!cfg?.enabled||!cfg.channelId||!client.isReady())return null;
    const active=store.all("SELECT * FROM giveaways WHERE status='active' ORDER BY created DESC"),rows=[];
    let eligible=0;
    for(const g of active){
      const data=JSON.parse(g.data),count=Number(store.one('SELECT COUNT(*) AS n FROM entries WHERE giveaway_id=?',g.id)?.n||0);eligible+=count;
      rows.push(`• **${data.title}** — ${count} elegível(is) · termina <t:${Math.floor(Date.parse(data.endsAt)/1000)}:R>`);
    }
    const giveawayList=rows.slice(0,8).join('\n')+(rows.length>8?`\n… e mais ${rows.length-8} sorteio(s).`:'')||'Nenhum sorteio ativo no momento.';
    const vars={activeGiveaways:String(active.length),eligible:String(eligible),giveawayList,updated:updatedRelative()};
    const signature=`${active.map(g=>g.id+':'+g.data).join('|')}:${eligible}:${cfg.channelId}`;
    return upsertLiveMessage('giveaways-live-message',cfg,settings.messageStyles.giveawaysLive,vars,signature,force);
  }
  async function updateOperationsLive(force=false){
    const settings=store.settings(),cfg=settings.operationsLive;if(!cfg?.enabled||!cfg.channelId||!client.isReady())return null;
    const openTickets=Number(store.one("SELECT COUNT(*) AS n FROM tickets WHERE status='open'")?.n||0);
    const pendingOrders=Number(store.one("SELECT COUNT(*) AS n FROM orders WHERE status='pending'")?.n||0);
    const vars={
      botStatus:client.isReady()?'Online':'Offline',
      storeStatus:cfg.storeOpen?'Aberta':'Fechada',
      ticketsStatus:cfg.ticketsOpen?'Disponíveis':'Fechados',
      openTickets:String(openTickets),
      pendingOrders:String(pendingOrders),
      updated:updatedRelative()
    };
    const signature=`${vars.botStatus}:${cfg.storeOpen}:${cfg.ticketsOpen}:${openTickets}:${pendingOrders}:${cfg.channelId}`;
    return upsertLiveMessage('operations-live-message',cfg,settings.messageStyles.operationsLive,vars,signature,force);
  }
  const currentMonth=()=>{
    const now=new Date(),start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)),end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1));
    return{start,end,key:start.toISOString().slice(0,7),label:new Intl.DateTimeFormat('pt-BR',{month:'long',year:'numeric',timeZone:'UTC'}).format(start)};
  };
  async function updateInviteRankingLive(force=false){
    const settings=store.settings(),cfg=settings.inviteRankingLive;if(!cfg?.enabled||!cfg.channelId||!client.isReady())return null;
    const {start,end,key,label}=currentMonth();
    const ranking=store.all(`SELECT inviter_user_id,COUNT(DISTINCT joined_user_id) AS n
      FROM referral_joins
      WHERE joined_at>=? AND joined_at<? AND left_at IS NULL
        AND EXISTS(SELECT 1 FROM verifications v WHERE v.user_id=referral_joins.joined_user_id)
      GROUP BY inviter_user_id ORDER BY n DESC,inviter_user_id ASC LIMIT ?`,start.toISOString(),end.toISOString(),cfg.top);
    const medals=['🥇','🥈','🥉'];
    const text=ranking.length?ranking.map((r,i)=>`${medals[i]||`**${i+1}.**`} <@${r.inviter_user_id}> — **${r.n}** convite(s) válido(s)`).join('\n'):'Ainda não há convites válidos neste mês.';
    const vars={ranking:text,month:label,updated:updatedRelative()};
    const signature=`${key}:${ranking.map(r=>r.inviter_user_id+':'+r.n).join('|')}:${cfg.top}:${cfg.channelId}`;
    return upsertLiveMessage('invite-ranking-live-message',cfg,settings.messageStyles.inviteRankingLive,vars,signature,force);
  }
  async function updateLivePanels(force=false){
    const tasks=[updateSalesLive(force),updateCommunityLive(force),updateGiveawaysLive(force),updateOperationsLive(force),updateInviteRankingLive(force)];
    const results=await Promise.allSettled(tasks);
    results.forEach((r,i)=>{if(r.status==='rejected')store.log('erro',`Painel ao vivo ${i+1}: ${r.reason?.message||r.reason}`);});
    return results;
  }
  async function createGiveaway(data){
    data={...data,requirements:(data.requirements||[]).map((r,i)=>({...r,id:r.id||`req-${i+1}-${randomUUID().slice(0,8)}`}))};
    const c=await channel(data.channelId),id=randomUUID();
    store.run('INSERT INTO giveaways(id,data,status,created) VALUES(?,?,?,?)',id,JSON.stringify(data),'draft',store.now());
    const legacy=data.requiredRoleId?`\nCargo necessário: <@&${data.requiredRoleId}>`:'';
    const reqLines=(data.requirements||[]).map(r=>`• ${requirementLabel(r)}`).join('\n');
    const roleLine=`${legacy}${reqLines?`\n\n**Requisitos para participar:**\n${reqLines}`:''}`;
    const payload=styledPayload(store.settings().messageStyles.giveaway,{title:data.title,description:data.description,ends:`<t:${Math.floor(Date.parse(data.endsAt)/1000)}:R>`,winners:data.winners,roleLine});
    const message=await c.send({...payload,components:[...(payload.components||[]),row(button('Verificar participação',`giveaway:${id}`))],allowedMentions:mentionPolicy(payload,[],data.requiredRoleId?[data.requiredRoleId]:[])});
    store.run("UPDATE giveaways SET status='active',message_id=? WHERE id=?",message.id,id);
    if((data.requirements||[]).some(r=>r.type==='voiceMinutes')){
      for(const state of requireGuild().voiceStates.cache.values())if(state.member&&!state.member.user.bot&&state.channelId)startVoiceForUser(state.id,store.now());
    }
    void updateGiveawaysLive(true);
    return{id};
  }
  async function finishGiveaway(g){
    const data=JSON.parse(g.data);let winners=g.winners?JSON.parse(g.winners):null;
    if(g.status==='active'){
      const eligible=[];
      for(const e of store.all('SELECT user_id FROM entries WHERE giveaway_id=?',g.id)){
        try{
          const checked=await evaluateGiveaway(g.id,e.user_id,{enter:false,record:true});
          if(checked.ok)eligible.push(e.user_id);else store.run('DELETE FROM entries WHERE giveaway_id=? AND user_id=?',g.id,e.user_id);
        }catch(error){if(error.code!==10007)store.log('erro',`Revalidação do sorteio ${g.id.slice(0,8)} para ${e.user_id}: ${error.message}`);}
      }
      winners=store.drawGiveaway(g.id,eligible);
    }
    const result=winners.length?`Vencedor(es): ${winners.map(id=>`<@${id}>`).join(', ')}`:'Não houve participantes elegíveis.';
    const payload=styledPayload(store.settings().messageStyles.giveawayResult,{title:data.title,result});
    const c=await channel(data.channelId);await c.messages.edit(g.message_id,{...payload,components:payload.components||[],allowedMentions:mentionPolicy(payload,winners||[])});
    store.run("UPDATE giveaways SET status='ended' WHERE id=?",g.id);
    void updateGiveawaysLive(true);
  }
  async function createEvent(data){const event=await requireGuild().scheduledEvents.create({name:data.name,description:data.description||undefined,scheduledStartTime:new Date(data.startsAt),scheduledEndTime:new Date(data.endsAt),privacyLevel:GuildScheduledEventPrivacyLevel.GuildOnly,entityType:GuildScheduledEventEntityType.External,entityMetadata:{location:data.location}});const id=randomUUID();store.run('INSERT INTO events VALUES(?,?,?,?)',id,JSON.stringify(data),event.id,store.now());return{id,discordId:event.id};}
  async function applyBrand(){const s=store.settings().brand;requireGuild();const body={username:s.name};if(s.avatar)body.avatar=s.avatar;if(s.banner)body.banner=s.banner;await client.user.edit(body);await client.application.edit({description:s.description});client.user.setPresence({status:s.status,activities:s.activity?[{name:s.activity,type:ActivityType[s.activityType]}]:[]});await audit('identidade','Identidade do bot atualizada.','painel');}
  async function snapshot(){const guild=requireGuild();await Promise.all([guild.channels.fetch(),guild.roles.fetch(),guild.members.fetch()]);return{id:guild.id,name:guild.name,description:guild.description,roles:[...guild.roles.cache.values()].map(r=>({id:r.id,name:r.name,color:r.color,permissions:r.permissions.bitfield.toString(),position:r.position,managed:r.managed})),channels:[...guild.channels.cache.values()].filter(Boolean).map(c=>({id:c.id,name:c.name,type:c.type,parentId:c.parentId,position:c.rawPosition,topic:c.topic,overwrites:c.permissionOverwrites?[...c.permissionOverwrites.cache.values()].map(p=>({id:p.id,type:p.type,allow:p.allow.bitfield.toString(),deny:p.deny.bitfield.toString()})):[]})),members:[...guild.members.cache.values()].filter(m=>!m.user?.bot).map(m=>({id:m.id,username:m.user?.username||m.id,displayName:m.displayName||m.user?.globalName||m.user?.username||m.id,joinedAt:m.joinedAt?.toISOString?.()||null,roles:[...m.roles.cache.values()].filter(r=>r.id!==guild.id).map(r=>r.id)}))};}
  async function makeBackup(){if(backupBusy)throw new AppError('Já há um backup em andamento.',409);backupBusy=true;try{return await store.makeBackup(client.isReady()?await snapshot():null);}finally{backupBusy=false;}}
  const orderStatusLabel=status=>({pending:'Aguardando pagamento',paid:'Pagamento aprovado / processando entrega',delivered:'Entregue',cancelled:'Cancelado'}[status]||status);
  async function userProfileText(userId){
    const guild=requireGuild(),m=await guild.members.fetch(userId);
    const t=store.one("SELECT COUNT(*) AS total,SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open FROM tickets WHERE user_id=?",userId);
    const o=store.one("SELECT COUNT(*) AS total,SUM(CASE WHEN status IN ('paid','delivered') THEN 1 ELSE 0 END) AS completed FROM orders WHERE user_id=?",userId);
    const v=store.one('SELECT verified_at FROM verifications WHERE user_id=?',userId);
    const latest=store.one('SELECT category,status,state,updated FROM tickets WHERE user_id=? ORDER BY created DESC LIMIT 1',userId);
    return[
      `**${m.displayName||m.user.username}** · <@${userId}>`,
      `Entrou no servidor: ${m.joinedTimestamp?`<t:${Math.floor(m.joinedTimestamp/1000)}:D>`:'não disponível'}`,
      `Conta criada: <t:${Math.floor(m.user.createdTimestamp/1000)}:D>`,
      `Verificação: ${v?.verified_at?`<t:${Math.floor(Date.parse(v.verified_at)/1000)}:D>`:'não registrada'}`,
      `Tickets: **${Number(t?.open||0)} aberto(s)** · ${Number(t?.total||0)} total`,
      `Pedidos: **${Number(o?.completed||0)} concluído(s)** · ${Number(o?.total||0)} total`,
      latest?`Último atendimento: **${latest.category}** · ${latest.status==='open'?latest.state:'finalizado'}`:'Último atendimento: nenhum'
    ].join('\n');
  }
  const faqMatches=query=>{
    const items=store.settings().faq?.items||[],q=String(query||'').trim().toLowerCase();
    if(!q)return items.slice(0,25);
    return items.filter(x=>[x.question,x.answer,x.keywords].join(' ').toLowerCase().includes(q)).slice(0,10);
  };
  async function publishOperationalAlert(kind,severity,title,detail,dedupeKey){
    if(dedupeKey&&store.get('alert-dedupe:'+dedupeKey))return;
    const id=randomUUID(),created=store.now();store.run('INSERT INTO alerts(id,kind,severity,title,detail,status,created) VALUES(?,?,?,?,?,"open",?)',id,kind,severity,title,String(detail).slice(0,1500),created);
    if(dedupeKey)store.set('alert-dedupe:'+dedupeKey,{at:created});
    const cfg=store.settings().alerts;if(cfg?.enabled&&cfg.channelId&&client.isReady())try{
      const cc=await channel(cfg.channelId);await cc.send({embeds:[{title:`⚠️ ${title}`,description:String(detail).slice(0,3900),color:severity==='critical'?0xff4d67:severity==='warning'?0xffbd4a:0x995cff,timestamp:new Date().toISOString()}],allowedMentions:safe});
    }catch(e){store.log('aviso',`Alerta operacional não pôde ser publicado: ${e.message}`);}
  }
  async function tick(){if(busy)return;busy=true;try{
    for(const o of store.all("SELECT id FROM orders WHERE status='pending' AND expires<=?",store.now()))store.cancelOrder(o.id);
    const s=store.settings();if(s.backups.enabled&&Date.now()-Date.parse(store.get('lastBackup','1970-01-01'))>=s.backups.intervalHours*3600000)try{await makeBackup();}catch(e){store.log('erro',`Backup: ${e.message}`);}
    if(!client.isReady())return;
    try{await applyVoicePresence();}catch(e){store.log('aviso',`Presença em call: ${e.message}`);}
    await updateLivePanels();
    for(const o of store.all("SELECT * FROM orders WHERE status='paid' LIMIT 10"))await deliverOrder(o);
    for(const g of store.all("SELECT * FROM giveaways WHERE status IN ('active','drawn')")){if(g.status==='drawn'||Date.parse(JSON.parse(g.data).endsAt)<=Date.now())try{await finishGiveaway(g);}catch(e){store.log('erro',`Sorteio ${g.id.slice(0,8)}: ${e.message}`);}}
    if(s.tickets.escalationMinutes>0){
      const cutoff=new Date(Date.now()-s.tickets.escalationMinutes*60000).toISOString();
      for(const t of store.all("SELECT * FROM tickets WHERE status='open' AND claimed_by IS NULL AND state='waiting_staff' AND created<=?",cutoff)){
        store.run("UPDATE tickets SET state='escalated',priority=CASE WHEN priority='urgent' THEN priority ELSE 'high' END,updated=? WHERE id=?",store.now(),t.id);
        ticketAuditAppend(t.id,{action:'state',actor:'sistema',target:t.user_id,state:'escalated'});
        await publishOperationalAlert('ticket_sla','warning','Ticket escalado',`Ticket ${t.id.slice(0,8)} de <@${t.user_id}> está sem responsável há mais de ${s.tickets.escalationMinutes} min.`,`ticket-escalated:${t.id}`);
        try{const tc=await channel(t.channel_id),roles=(s.roleGroups?.highStaff||[]).map(id=>`<@&${id}>`).join(' ');await tc.send({content:`${roles?roles+' ':''}⚠️ Este atendimento foi escalado por tempo de espera.`,allowedMentions:{parse:[],roles:s.roleGroups?.highStaff||[]}});}catch{}
      }
    }
    if(s.alerts?.staleTickets!==false&&s.tickets.staleReminderMinutes>0){
      const cutoff=new Date(Date.now()-s.tickets.staleReminderMinutes*60000).toISOString();
      for(const t of store.all("SELECT * FROM tickets WHERE status='open' AND state='waiting_customer' AND updated<=?",cutoff)){
        const key=`ticket-stale:${t.id}:${String(t.updated).slice(0,13)}`;if(store.get(key))continue;store.set(key,{at:store.now()});
        try{const tc=await channel(t.channel_id);await tc.send({content:`<@${t.user_id}> lembrete: seu atendimento está aguardando sua resposta.`,allowedMentions:{parse:[],users:[t.user_id]}});}catch{}
      }
    }
    if(s.alerts?.lowStock){
      for(const p of store.products().filter(p=>p.type==='digital'&&p.stock<=s.sales.lowStockThreshold))await publishOperationalAlert('low_stock',p.stock===0?'critical':'warning','Estoque baixo',`**${p.name}** possui ${p.stock} unidade(s) disponível(is).`,`stock:${p.id}:${p.stock}`);
    }
    if(s.alerts?.deletedMessagesThreshold){
      const since=new Date(Date.now()-10*60000).toISOString(),deleted=store.one("SELECT COUNT(*) AS n FROM logs WHERE type='mensagem excluída' AND created>=?",since)?.n||0;
      if(deleted>=s.alerts.deletedMessagesThreshold)await publishOperationalAlert('message_deletes','warning','Muitas mensagens apagadas',`${deleted} mensagens foram apagadas nos últimos 10 minutos.`,`deleted:${new Date().toISOString().slice(0,15)}`);
    }
    if(s.tickets.autoCloseHours)for(const t of store.all("SELECT * FROM tickets WHERE status='open' AND updated<?",new Date(Date.now()-s.tickets.autoCloseHours*3600000).toISOString()))try{await closeTicket(t.id,'sistema','Inatividade');}catch(e){store.log('erro',`Ticket ${t.id.slice(0,8)}: ${e.message}`);}
  }catch(e){store.log('erro',e.message);}finally{busy=false;}}
  client.on(Events.InteractionCreate,async i=>{
    const customId=String(i.customId||''),privateInteraction=(i.isButton()||i.isStringSelectMenu()||i.isModalSubmit())&&(customId.startsWith('feedback')||customId.startsWith('translate')||customId.startsWith('reopen'));
    if((i.guildId!==env.DISCORD_GUILD_ID&&!privateInteraction)||(!i.isChatInputCommand()&&!i.isMessageContextMenuCommand()&&!i.isButton()&&!i.isStringSelectMenu()&&!i.isModalSubmit()))return;
    if(i.isButton()&&i.customId.startsWith('feedback:')){
      try{
        const id=i.customId.split(':')[1],request=store.one('SELECT * FROM feedback_requests WHERE id=?',id);
        if(!request||request.user_id!==i.user.id)throw new AppError('Este pedido de feedback não pertence a você.',403);
        if(request.status==='submitted'){await localizedReply(i,{content:'Você já enviou seu feedback. Obrigada! 💜'});return;}
        const stars=[1,2,3,4,5].map(n=>button(`${n} ⭐`,`feedback-rate:${id}:${n}`,2));
        await localizedReply(i,{content:'Como você avalia sua experiência? Escolha de **1 a 5 estrelas**:',components:[row(...stars)]});
      }catch(e){await localizedReply(i,{content:e instanceof AppError?e.message:'Não foi possível abrir o feedback.'}).catch(()=>{});}
      return;
    }
    if(i.isButton()&&i.customId.startsWith('feedback-rate:')){
      try{
        const [,id,ratingRaw]=i.customId.split(':'),rating=Number(ratingRaw),request=store.one('SELECT * FROM feedback_requests WHERE id=?',id);
        if(!request||request.user_id!==i.user.id)throw new AppError('Este pedido de feedback não pertence a você.',403);
        if(request.status==='submitted')throw new AppError('Você já enviou seu feedback.');
        if(!Number.isInteger(rating)||rating<1||rating>5)throw new AppError('Nota inválida.');
        const modal=new ModalBuilder().setCustomId(`feedback-submit:${id}:${rating}`).setTitle(`Feedback · ${rating} estrela${rating===1?'':'s'}`);
        const service=new TextInputBuilder().setCustomId('feedback-service').setLabel('Atendimento (1 a 5)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(1).setPlaceholder('5');
        const speed=new TextInputBuilder().setCustomId('feedback-speed').setLabel('Rapidez (1 a 5)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(1).setPlaceholder('5');
        const resolution=new TextInputBuilder().setCustomId('feedback-resolution').setLabel('Resolução (1 a 5)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(1).setPlaceholder('5');
        const input=new TextInputBuilder().setCustomId('feedback-comment').setLabel('Conte como foi sua experiência').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(3).setMaxLength(1200).setPlaceholder('Escreva seu feedback sobre o atendimento ou compra.');
        modal.addComponents(new ActionRowBuilder().addComponents(service),new ActionRowBuilder().addComponents(speed),new ActionRowBuilder().addComponents(resolution),new ActionRowBuilder().addComponents(input));
        await i.showModal(modal);
      }catch(e){await localizedReply(i,{content:e instanceof AppError?e.message:'Não foi possível abrir o formulário.'}).catch(()=>{});}
      return;
    }
    if(i.isModalSubmit()&&i.customId.startsWith('feedback-submit:')){
      let deferred=false,id='';
      try{
        const [,feedbackId,ratingRaw]=i.customId.split(':');id=feedbackId;const rating=Number(ratingRaw);
        await i.deferReply();deferred=true;
        const request=store.one('SELECT * FROM feedback_requests WHERE id=?',id);
        if(!request||request.user_id!==i.user.id)throw new AppError('Este pedido de feedback não pertence a você.',403);
        if(request.status==='submitted')throw new AppError('Você já enviou seu feedback.');
        if(!Number.isInteger(rating)||rating<1||rating>5)throw new AppError('Nota inválida.');
        const comment=String(i.fields.getTextInputValue('feedback-comment')||'').trim();if(comment.length<3)throw new AppError('Escreva um comentário sobre sua experiência.');
        const service=Number(i.fields.getTextInputValue('feedback-service')),speed=Number(i.fields.getTextInputValue('feedback-speed')),resolution=Number(i.fields.getTextInputValue('feedback-resolution'));
        if([service,speed,resolution].some(v=>!Number.isInteger(v)||v<1||v>5))throw new AppError('As notas de atendimento, rapidez e resolução devem ser de 1 a 5.');
        const requestMeta=(()=>{try{return JSON.parse(request.meta||'{}')}catch{return {}}})();requestMeta.service=service;requestMeta.speed=speed;requestMeta.resolution=resolution;
        const detailedComment=`Atendimento: ${service}/5 · Rapidez: ${speed}/5 · Resolução: ${resolution}/5\n\n${comment}`;
        const claim=store.run("UPDATE feedback_requests SET status='publishing',meta=? WHERE id=? AND user_id=? AND status='pending'",JSON.stringify(requestMeta),id,i.user.id);
        if(!claim.changes)throw new AppError('Este feedback já foi processado.');
        try{
          await publishFeedback({...request,meta:JSON.stringify(requestMeta)},rating,detailedComment,i.user);
          store.run("UPDATE feedback_requests SET status='submitted',rating=?,comment=?,meta=?,submitted_at=? WHERE id=?",rating,comment,JSON.stringify(requestMeta),store.now(),id);
        }catch(e){
          store.run("UPDATE feedback_requests SET status='pending' WHERE id=? AND status='publishing'",id);
          throw e;
        }
        await localizedEdit(i,`Obrigada pelo feedback! 💜 Sua avaliação **${feedbackStars(rating)} ${rating}/5** foi enviada.`);
      }catch(e){
        const msg=e instanceof AppError?e.message:'Não foi possível enviar seu feedback.';
        if(deferred)await localizedEdit(i,msg).catch(()=>{});else await localizedReply(i,{content:msg}).catch(()=>{});
      }
      return;
    }
    if(i.isButton()&&i.customId.startsWith('note:')){
      try{if(!await isStaff(i))throw new AppError('Somente a equipe pode adicionar notas.',403);const id=i.customId.split(':')[1];if(!store.one("SELECT id FROM tickets WHERE id=? AND status='open'",id))throw new AppError('Ticket aberto não encontrado.',404);const modal=new ModalBuilder().setCustomId(`note-submit:${id}`).setTitle('Nota interna');const input=new TextInputBuilder().setCustomId('note-text').setLabel('Nota visível apenas para a equipe').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);modal.addComponents(new ActionRowBuilder().addComponents(input));await i.showModal(modal);}catch(e){await localizedReply(i,{content:e.message,flags:MessageFlags.Ephemeral}).catch(()=>{});}return;
    }
    if(i.isModalSubmit()&&i.customId.startsWith('note-submit:')){
      try{if(!await isStaff(i))throw new AppError('Somente a equipe pode adicionar notas.',403);const id=i.customId.split(':')[1],t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);const note=String(i.fields.getTextInputValue('note-text')||'').trim();store.run('INSERT INTO ticket_notes(id,ticket_id,actor,note,private,created) VALUES(?,?,?,?,1,?)',randomUUID(),id,i.user.id,note,store.now());ticketAuditAppend(id,{action:'note',actor:i.user.id,target:t.user_id,note});store.recordStaffAction(i.user.id,'note',id,t.user_id);await localizedReply(i,{content:'Nota interna adicionada.',flags:MessageFlags.Ephemeral});}catch(e){await localizedReply(i,{content:e.message,flags:MessageFlags.Ephemeral}).catch(()=>{});}return;
    }
    if(i.isButton()&&i.customId.startsWith('tags:')){
      try{if(!await isStaff(i))throw new AppError('Somente a equipe pode editar tags.',403);const id=i.customId.split(':')[1],t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);const modal=new ModalBuilder().setCustomId(`tags-submit:${id}`).setTitle('Tags do ticket');let tags=[];try{tags=JSON.parse(t.tags||'[]')}catch{}const input=new TextInputBuilder().setCustomId('tags-text').setLabel('Tags separadas por vírgula').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300).setValue(tags.join(', ').slice(0,300));modal.addComponents(new ActionRowBuilder().addComponents(input));await i.showModal(modal);}catch(e){await localizedReply(i,{content:e.message,flags:MessageFlags.Ephemeral}).catch(()=>{});}return;
    }
    if(i.isModalSubmit()&&i.customId.startsWith('tags-submit:')){
      try{if(!await isStaff(i))throw new AppError('Somente a equipe pode editar tags.',403);const id=i.customId.split(':')[1],t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);const tags=[...new Set(String(i.fields.getTextInputValue('tags-text')||'').split(',').map(x=>x.trim()).filter(Boolean))].slice(0,10);store.run('UPDATE tickets SET tags=?,updated=? WHERE id=?',JSON.stringify(tags),store.now(),id);ticketAuditAppend(id,{action:'tags',actor:i.user.id,target:t.user_id,tags});await localizedReply(i,{content:`Tags atualizadas: ${tags.join(', ')||'nenhuma'}.`,flags:MessageFlags.Ephemeral});}catch(e){await localizedReply(i,{content:e.message,flags:MessageFlags.Ephemeral}).catch(()=>{});}return;
    }
    if(i.isButton()&&i.customId.startsWith('close:')){
      try{if(!await hasStaffPermission(i,'ticketClose'))throw new AppError('Você não possui permissão para finalizar tickets.',403);const id=i.customId.split(':')[1];if(!store.one("SELECT id FROM tickets WHERE id=? AND status='open'",id))throw new AppError('Ticket aberto não encontrado.',404);const modal=new ModalBuilder().setCustomId(`close-submit:${id}`).setTitle('Finalizar atendimento');const input=new TextInputBuilder().setCustomId('close-reason').setLabel('Motivo do encerramento').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(2).setMaxLength(500);modal.addComponents(new ActionRowBuilder().addComponents(input));await i.showModal(modal);}catch(e){await localizedReply(i,{content:e.message,flags:MessageFlags.Ephemeral}).catch(()=>{});}return;
    }
    if(i.isModalSubmit()&&i.customId.startsWith('close-submit:')){
      try{if(!await hasStaffPermission(i,'ticketClose'))throw new AppError('Você não possui permissão para finalizar tickets.',403);const id=i.customId.split(':')[1],reason=String(i.fields.getTextInputValue('close-reason')||'').trim();await i.deferReply({flags:MessageFlags.Ephemeral});await closeTicket(id,i.user.id,reason);await localizedEdit(i,'Atendimento encerrado e registrado.');}catch(e){if(i.deferred)await localizedEdit(i,e.message).catch(()=>{});else await localizedReply(i,{content:e.message,flags:MessageFlags.Ephemeral}).catch(()=>{});}return;
    }
    if(i.isButton()&&i.customId.startsWith('rename:')){
      try{
        if(!await isStaff(i))throw new AppError('Somente a equipe pode renomear tickets.',403);
        const id=i.customId.split(':')[1],t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);
        const c=await channel(t.channel_id);
        const modal=new ModalBuilder().setCustomId(`rename-submit:${id}`).setTitle('Renomear ticket');
        const input=new TextInputBuilder().setCustomId('ticket-name').setLabel('Novo nome do ticket').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(90).setValue(c.name.slice(0,90));
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await i.showModal(modal);
      }catch(e){
        await localizedReply(i,{content:e instanceof AppError?e.message:'Não foi possível abrir o editor de nome.',flags:MessageFlags.Ephemeral}).catch(()=>{});
      }
      return;
    }
    try{
      await i.deferReply({flags:MessageFlags.Ephemeral});
      const action=i.commandName||i.customId;
      if(action==='ajuda'||action==='central-help'){
        const query=i.isChatInputCommand()?i.options.getString('busca'):'';const matches=faqMatches(query);
        if(query){await localizedEdit(i,matches.length?matches.map(x=>`**${x.question}**\n${x.answer}`).join('\n\n').slice(0,1900):'Não encontrei uma resposta para essa busca. Você pode abrir um ticket para falar com a equipe.');return;}
        const items=matches.slice(0,25);await localizedEdit(i,{content:'**Ajuda Studio K**\nEscolha uma dúvida comum ou abra um atendimento.',components:[...(items.length?[row({type:3,custom_id:'help-faq',placeholder:'Escolha uma dúvida',options:items.map((x,n)=>({label:x.question.slice(0,100),value:String(n)}))})]:[]),row(button('Abrir atendimento','central-ticket',2))]});return;
      }
      if(action==='help-faq'){const item=(store.settings().faq?.items||[])[Number(i.values?.[0])];await localizedEdit(i,item?`**${item.question}**\n${item.answer}`:'Essa resposta não está mais disponível.');return;}
      if(action==='notificacoes'){
        const current=store.one('SELECT * FROM user_notifications WHERE user_id=?',i.user.id)||{promotions:0,giveaways:1,orders:1,tickets:1};
        const selected=[['promotions','Promoções',current.promotions],['giveaways','Sorteios',current.giveaways],['orders','Pedidos',current.orders],['tickets','Tickets',current.tickets]];
        await localizedEdit(i,{content:'Escolha quais notificações opcionais você quer receber:',components:[row({type:3,custom_id:'notification-select',placeholder:'Preferências de notificação',min_values:0,max_values:4,options:selected.map(([value,label,on])=>({label,value,default:!!on}))})]});return;
      }
      if(action==='notification-select'){
        const values=new Set(i.values||[]),now=store.now();store.run('INSERT INTO user_notifications(user_id,promotions,giveaways,orders,tickets,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET promotions=excluded.promotions,giveaways=excluded.giveaways,orders=excluded.orders,tickets=excluded.tickets,updated=excluded.updated',i.user.id,values.has('promotions')?1:0,values.has('giveaways')?1:0,values.has('orders')?1:0,values.has('tickets')?1:0,now);
        if(values.size)store.run('INSERT INTO optins(user_id,created) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING',i.user.id,now);else store.run('DELETE FROM optins WHERE user_id=?',i.user.id);
        await localizedEdit(i,'Preferências de notificação atualizadas.');return;
      }
      if(action==='loja'){if(store.settings().operationsLive?.storeOpen===false)throw new AppError('A loja está fechada no momento.');const products=store.products().filter(p=>p.active);await localizedEdit(i,products.length?{content:'**Catálogo Studio K**\nSelecione um produto para comprar.',components:[row({type:3,custom_id:'store-buy',placeholder:'Escolha um produto',options:products.slice(0,25).map(p=>({label:p.name.slice(0,100),description:`${money(p.priceCents)} · ${p.type==='service'?'Serviço':`${p.stock} em estoque`}`,value:p.id}))})]}:'Ainda não há produtos disponíveis.');return;}
      if(action==='ticket-open'||action==='ticket'){
        if(store.settings().operationsLive?.ticketsOpen===false)throw new AppError('Os tickets estão fechados no momento.');
        const settings=store.settings().tickets,open=Number(store.one("SELECT COUNT(*) AS n FROM tickets WHERE user_id=? AND status='open'",i.user.id)?.n||0),maxOpen=settings.maxOpen||TICKET_OPEN_LIMIT;
        if(open>=maxOpen)throw new AppError(`Você já possui ${maxOpen} ticket(s) aberto(s). Encerre um antes de abrir outro.`,409);
        const categoryButtons=settings.categories.map((name,index)=>button(name.slice(0,80),`ticket-category:${index}`,2));
        const rows=[];for(let p=0;p<categoryButtons.length;p+=5)rows.push(row(...categoryButtons.slice(p,p+5)));
        await localizedEdit(i,{content:`Você possui **${open}/${maxOpen}** ticket(s) aberto(s). Escolha a categoria do novo atendimento:`,components:rows});
        return;
      }
      if(action.startsWith('ticket-category:')||action==='ticket-category'){
        if(store.settings().operationsLive?.ticketsOpen===false)throw new AppError('Os tickets estão fechados no momento.');
        const index=action==='ticket-category'?Number(i.values?.[0]||0):Number(action.split(':')[1]),category=store.settings().tickets.categories[index];
        if(!category)throw new AppError('Categoria indisponível.');
        const t=await openTicket(i.user.id,category);
        const open=Number(store.one("SELECT COUNT(*) AS n FROM tickets WHERE user_id=? AND status='open'",i.user.id)?.n||0),maxOpen=store.settings().tickets.maxOpen||TICKET_OPEN_LIMIT;
        const queue=store.settings().tickets.queueEnabled?`\nPosição aproximada na fila: **${t.queuePosition}**.`:'';
        await localizedEdit(i,{content:`Olá <@${i.user.id}>! Seu atendimento foi criado em <#${t.channel_id}>.\nVocê está com **${open}/${maxOpen}** ticket(s) aberto(s).${queue}`,components:[],allowedMentions:{parse:[],users:[i.user.id]}});
        return;
      }
      if(action.startsWith('claim:')){if(!await isStaff(i))throw new AppError('Somente a equipe pode assumir tickets.',403);const id=action.split(':')[1],changed=store.run("UPDATE tickets SET claimed_by=?,state='in_progress',updated=? WHERE id=? AND status='open' AND claimed_by IS NULL",i.user.id,store.now(),id);if(changed.changes){const t=store.one('SELECT * FROM tickets WHERE id=?',id),c=await channel(t.channel_id),style=store.settings().messageStyles.ticketClaim,customer=await memberVariables(t.user_id,c.guild),staffMember=await member(i.user.id);const variables={...customer,staff:`<@${i.user.id}>`,staffUsername:staffMember.displayName||staffMember.user.globalName||staffMember.user.username||i.user.id,ticket:c.name,category:t.category,channel:`<#${c.id}>`,server:c.guild.name};const claimPayload=styledPayload(style,variables,env.DISCORD_GUILD_ID);await c.send({...claimPayload,allowedMentions:mentionPolicy(claimPayload,[i.user.id,t.user_id])});ticketAuditAppend(t.id,{action:'claim',actor:i.user.id,target:t.user_id});store.recordStaffAction(i.user.id,'claim',t.id,t.user_id);await refreshTicketControls(t.id);}await localizedEdit(i,changed.changes?'Atendimento atribuído a você.':'Esse atendimento já está atribuído ou encerrado.');return;}
      if(action.startsWith('call:')){
        if(!await isStaff(i))throw new AppError('Somente a equipe pode chamar o cliente.',403);
        const id=action.split(':')[1],t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);
        const c=await channel(t.channel_id),settings=store.settings(),style=settings.messageStyles.ticketCall,customer=await memberVariables(t.user_id,c.guild);
        const variables={...customer,ticket:c.name,category:t.category,channel:`<#${c.id}>`,server:c.guild.name};
        const callPayload=styledPayload(style,variables,env.DISCORD_GUILD_ID);await c.send({...callPayload,allowedMentions:mentionPolicy(callPayload,[t.user_id])});
        let dmSent=false;
        if(settings.tickets.callDm){
          try{const dmPayload=styledPayload(settings.messageStyles.ticketCallDm,variables,env.DISCORD_GUILD_ID),localizedDm=await localizeFor(t.user_id,dmPayload);await(await member(t.user_id)).send({...localizedDm,allowedMentions:mentionPolicy(localizedDm)});dmSent=true;}
          catch(e){store.log('aviso',`Cliente chamado em ${c.name}, mas a DM falhou: ${String(e.message).slice(0,300)}`);}
        }
        store.run("UPDATE tickets SET state='waiting_customer',updated=? WHERE id=?",store.now(),id);ticketAuditAppend(t.id,{action:'call',actor:i.user.id,target:t.user_id,dmSent});store.recordStaffAction(i.user.id,'call',t.id,t.user_id,{dmSent});await refreshTicketControls(t.id);await localizedEdit(i,dmSent?'Cliente chamado no ticket e no privado.':'Cliente chamado no ticket. A DM não pôde ser entregue.');return;
      }
      if(action.startsWith('rename-submit:')){
        if(!await isStaff(i))throw new AppError('Somente a equipe pode renomear tickets.',403);
        const id=action.split(':')[1],t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);
        const requested=i.fields.getTextInputValue('ticket-name'),newName=channelSlug(requested);if(!newName)throw new AppError('Digite um nome válido.');
        const c=await channel(t.channel_id),oldName=c.name;await c.setName(newName,`Studio K: renomeado por ${i.user.id}`);
        store.run('UPDATE tickets SET updated=? WHERE id=?',store.now(),id);ticketAuditAppend(t.id,{action:'rename',actor:i.user.id,target:t.user_id,from:oldName,to:newName});store.recordStaffAction(i.user.id,'rename',t.id,t.user_id,{from:oldName,to:newName});await localizedEdit(i,`Ticket renomeado para **${newName}**.`);return;
      }
      if(action.startsWith('status-direct:')){
        if(!await isStaff(i))throw new AppError('Somente a equipe pode alterar o status.',403);
        const parts=action.split(':'),id=parts[1],state=parts[2],allowed=new Set(['waiting_staff','in_progress','waiting_customer','escalated']);if(!allowed.has(state))throw new AppError('Status inválido.');
        const t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);
        store.run('UPDATE tickets SET state=?,updated=? WHERE id=?',state,store.now(),id);ticketAuditAppend(id,{action:'state',actor:i.user.id,target:t.user_id,state});store.recordStaffAction(i.user.id,'state',id,t.user_id,{state});await refreshTicketControls(id);
        await localizedEdit(i,`Status atualizado para **${state}**.`);return;
      }
      if(action.startsWith('status:')){
        if(!await isStaff(i))throw new AppError('Somente a equipe pode alterar o status.',403);
        const id=action.split(':')[1],t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);
        await localizedEdit(i,{content:'Escolha o novo status do atendimento:',components:[row({type:3,custom_id:`status-select:${id}`,placeholder:'Status do ticket',options:[['waiting_staff','Aguardando staff'],['in_progress','Em atendimento'],['waiting_customer','Aguardando cliente'],['escalated','Escalado']].map(([value,label])=>({label,value,default:t.state===value}))})]});return;
      }
      if(action.startsWith('status-select:')){
        if(!await isStaff(i))throw new AppError('Somente a equipe pode alterar o status.',403);
        const id=action.split(':')[1],state=String(i.values?.[0]||''),allowed=new Set(['waiting_staff','in_progress','waiting_customer','escalated']);if(!allowed.has(state))throw new AppError('Status inválido.');
        const t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);
        store.run('UPDATE tickets SET state=?,updated=? WHERE id=?',state,store.now(),id);ticketAuditAppend(id,{action:'state',actor:i.user.id,target:t.user_id,state});store.recordStaffAction(i.user.id,'state',id,t.user_id,{state});await refreshTicketControls(id);
        await localizedEdit(i,`Status atualizado para **${state}**.`);return;
      }
      if(action.startsWith('priority:')){
        if(!await isStaff(i))throw new AppError('Somente a equipe pode alterar a prioridade.',403);
        const id=action.split(':')[1],t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);
        await localizedEdit(i,{content:'Escolha a prioridade:',components:[row({type:3,custom_id:`priority-select:${id}`,placeholder:'Prioridade',options:[['low','Baixa'],['normal','Normal'],['high','Alta'],['urgent','Urgente']].map(([value,label])=>({label,value,default:t.priority===value}))})]});return;
      }
      if(action.startsWith('priority-select:')){
        if(!await isStaff(i))throw new AppError('Somente a equipe pode alterar a prioridade.',403);
        const id=action.split(':')[1],priority=String(i.values?.[0]||''),allowed=new Set(['low','normal','high','urgent']);if(!allowed.has(priority))throw new AppError('Prioridade inválida.');
        const t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);
        store.run('UPDATE tickets SET priority=?,updated=? WHERE id=?',priority,store.now(),id);ticketAuditAppend(id,{action:'priority',actor:i.user.id,target:t.user_id,priority});store.recordStaffAction(i.user.id,'priority',id,t.user_id,{priority});
        await localizedEdit(i,`Prioridade atualizada para **${priority}**.`);return;
      }
      if(action.startsWith('transfer:')){
        if(!await hasStaffPermission(i,'ticketTransfer'))throw new AppError('Você não possui permissão para transferir tickets.',403);
        const id=action.split(':')[1],t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);
        await localizedEdit(i,{content:'Escolha o membro da equipe que receberá o atendimento:',components:[row({type:5,custom_id:`transfer-select:${id}`,placeholder:'Selecionar staff',min_values:1,max_values:1})]});return;
      }
      if(action.startsWith('transfer-select:')){
        if(!await hasStaffPermission(i,'ticketTransfer'))throw new AppError('Você não possui permissão para transferir tickets.',403);
        const id=action.split(':')[1],to=String(i.values?.[0]||''),t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);
        const guild=requireGuild(),m=await guild.members.fetch(to),settings=store.settings(),allowedRoles=[...new Set([...staffRoleIds(settings),...(settings.permissions?.ticketManage||[])])];
        if(!allowedRoles.some(r=>m.roles.cache.has(r))&&!m.permissions.has(PermissionFlagsBits.ManageGuild)&&!m.permissions.has(PermissionFlagsBits.Administrator))throw new AppError('Escolha um membro que pertença à equipe.');
        store.run("UPDATE tickets SET claimed_by=?,state='in_progress',updated=? WHERE id=?",to,store.now(),id);ticketAuditAppend(id,{action:'transfer',actor:i.user.id,target:t.user_id,to});store.recordStaffAction(i.user.id,'transfer',id,t.user_id,{to});await refreshTicketControls(id);
        try{const tc=await channel(t.channel_id);await tc.send({content:`Atendimento transferido para <@${to}> por <@${i.user.id}>.`,allowedMentions:{parse:[],users:[to,i.user.id]}});}catch{}
        await localizedEdit(i,`Atendimento transferido para <@${to}>.`);return;
      }
      if(action.startsWith('reopen:')){
        if(store.settings().operationsLive?.ticketsOpen===false)throw new AppError('Os tickets estão fechados no momento.');
        const oldId=action.split(':')[1],old=store.one("SELECT * FROM tickets WHERE id=? AND status='closed' AND user_id=?",oldId,i.user.id);if(!old)throw new AppError('Esse atendimento não pode ser reaberto.',404);
        if(!store.settings().tickets.allowReopen)throw new AppError('A reabertura de tickets está desativada.');
        const t=await openTicket(i.user.id,old.category,{reopenedFrom:old.id,priority:old.priority||'normal'});ticketAuditAppend(t.id,{action:'reopen',actor:i.user.id,target:i.user.id});await localizedEdit(i,{content:`Novo atendimento criado: <#${t.channel_id}>. Ele está relacionado ao ticket anterior ${old.id.slice(0,8)}.`,components:[]});return;
      }
      if(action==='central'||action==='central-profile'||action==='perfil'){
        await localizedEdit(i,{content:await userProfileText(i.user.id),components:[row(button('📦 Meus pedidos','central-orders',2),button('🎫 Abrir atendimento','central-ticket',2),button('🌎 Idioma','central-language',2))]});return;
      }
      if(action==='central-store'){if(store.settings().operationsLive?.storeOpen===false)throw new AppError('A loja está fechada no momento.');const products=store.products().filter(p=>p.active);await localizedEdit(i,products.length?{content:'**Loja Studio K**\nEscolha um produto:',components:[row({type:3,custom_id:'store-buy',placeholder:'Produto',options:products.slice(0,25).map(p=>({label:p.name.slice(0,100),description:`${money(p.priceCents)} · ${p.type==='service'?'Serviço':`${p.stock} em estoque`}`,value:p.id}))})]}:'Não há produtos disponíveis.');return;}
      if(action==='central-ticket'){if(store.settings().operationsLive?.ticketsOpen===false)throw new AppError('Os tickets estão fechados no momento.');const settings=store.settings().tickets,open=Number(store.one("SELECT COUNT(*) AS n FROM tickets WHERE user_id=? AND status='open'",i.user.id)?.n||0),maxOpen=settings.maxOpen||TICKET_OPEN_LIMIT;if(open>=maxOpen)throw new AppError(`Você já possui ${maxOpen} ticket(s) aberto(s).`);const buttons=settings.categories.map((name,index)=>button(name.slice(0,80),`ticket-category:${index}`,2)),rows=[];for(let p=0;p<buttons.length;p+=5)rows.push(row(...buttons.slice(p,p+5)));await localizedEdit(i,{content:'Escolha a categoria do atendimento:',components:rows});return;}
      if(action==='central-orders'){
        const rows=store.all('SELECT * FROM orders WHERE user_id=? ORDER BY created DESC LIMIT 5',i.user.id);if(!rows.length){await localizedEdit(i,'Você ainda não possui pedidos.');return;}
        const lines=rows.map(o=>{const p=JSON.parse(o.product);return`**${o.id.slice(0,8)}** · ${p.name} · ${orderStatusLabel(o.status)} · ${money(o.price)}`;});
        await localizedEdit(i,{content:'**Seus pedidos recentes**\n'+lines.join('\n'),components:[row(button('Abrir suporte','central-ticket',2))]});return;
      }
      if(action==='central-language'){const current=languagePreference(i.user.id)?.language||'';await localizedEdit(i,{content:'Escolha seu idioma:',components:[row(languageSelect('set-language',current))]});return;}
      if(action==='central-giveaways'){
        const gs=store.all("SELECT * FROM giveaways WHERE status='active' ORDER BY created DESC LIMIT 10");if(!gs.length){await localizedEdit(i,'Não há sorteios ativos no momento.');return;}
        const lines=gs.map(g=>{const d=JSON.parse(g.data);return`🎁 **${d.title}** · termina <t:${Math.floor(Date.parse(d.endsAt)/1000)}:R>`;});await localizedEdit(i,lines.join('\n'));return;
      }
      if(action==='cupom'){
        const code=String(i.options.getString('codigo')||'').trim().toUpperCase();if(!code)throw new AppError('Informe o código do cupom.');
        const cp=store.one('SELECT * FROM coupons WHERE code=? AND active=1',code);if(!cp)throw new AppError('Cupom inválido ou inativo.');if(cp.expires&&Date.parse(cp.expires)<=Date.now())throw new AppError('Este cupom expirou.');if(cp.role_id){const m=i.member?.roles?.cache?i.member:await requireGuild().members.fetch(i.user.id);if(!m.roles.cache.has(cp.role_id))throw new AppError('Este cupom exige um cargo específico no servidor.');}
        store.set(`coupon-user:${i.user.id}`,{code,expires:Date.now()+60*60000});await localizedEdit(i,`Cupom **${code}** aplicado. Ele será usado na sua próxima compra dentro de 1 hora.`);return;
      }
      if(action==='idioma'){
        const current=languagePreference(i.user.id)?.language||'';
        await localizedEdit(i,{content:'Escolha o idioma que o Studio K deve usar para você:',components:[row(languageSelect('set-language',current))]});
        return;
      }
      if(action==='set-language'){
        const language=saveLanguage(i.user.id,normalizeLanguage(i.values?.[0]));
        await localizedEdit(i,{content:'Idioma atualizado para **'+languageLabel(language)+'**.',components:[]});
        return;
      }
      if(action==='Traduzir mensagem'){
        if(!store.settings().translator?.enabled)throw new AppError('A tradução personalizada está desativada.');
        if(!translationReady())throw new AppError('O tradutor ainda não foi configurado pelo administrador.');
        const pref=languagePreference(i.user.id),target=i.targetMessage;
        if(!target)throw new AppError('Mensagem não encontrada.');
        if(!pref){
          await localizedEdit(i,{content:'Escolha seu idioma. Essa preferência será usada nas próximas traduções:',components:[row(languageSelect('translate-language:'+target.channelId+':'+target.id))]});
          return;
        }
        await translatedMessageEdit(i,target,normalizeLanguage(pref.language));
        return;
      }
      if(action==='verify'||action==='verificar'){
        const current=languagePreference(i.user.id)?.language||'';
        await localizedEdit(i,{content:'Escolha o idioma que o Studio K deve usar nas suas mensagens privadas:',components:[row(languageSelect('verify-language',current))]});
        return;
      }
      if(action==='verify-browser'){
        const current=languagePreference(i.user.id)?.language||'';
        await localizedEdit(i,{content:'Escolha seu idioma antes de continuar pelo navegador:',components:[row(languageSelect('verify-browser-language',current))]});
        return;
      }
      if(action==='verify-language'){
        const language=saveLanguage(i.user.id,normalizeLanguage(i.values?.[0]));
        if(store.settings().verification.oauthEnabled){
          const url=String(env.PUBLIC_URL||'').replace(/\/$/,'')+'/api/oauth/discord/start?lang='+encodeURIComponent(language);
          await localizedEdit(i,{content:'Idioma salvo. Continue pela autorização oficial do Discord. A autorização também permite restaurar sua entrada em um novo servidor do Studio K caso seja necessário no futuro.',components:[row(linkButton('Autorizar e verificar',url))]});
        }else{
          await completeNativeVerification(i,language);
        }
        return;
      }
      if(action==='verify-browser-language'){
        const language=saveLanguage(i.user.id,normalizeLanguage(i.values?.[0]));
        const url=String(env.PUBLIC_URL||'').replace(/\/$/,'')+'/api/oauth/discord/start?lang='+encodeURIComponent(language);
        await localizedEdit(i,{content:'Idioma salvo. Continue pela autorização oficial do Discord:',components:[row(linkButton('Continuar no navegador',url))]});
        return;
      }
      if(action==='translate-message'){
        if(!store.settings().translator?.enabled)throw new AppError('A tradução personalizada está desativada.');
        if(!translationReady())throw new AppError('O tradutor ainda não foi configurado pelo administrador.');
        const pref=languagePreference(i.user.id);
        if(!pref){
          await localizedEdit(i,{content:'Escolha seu idioma. O Studio K salvará essa preferência para as próximas traduções:',components:[row(languageSelect('translate-language:'+i.channelId+':'+i.message.id))]});
          return;
        }
        await translatedMessageEdit(i,i.message,normalizeLanguage(pref.language));
        return;
      }
      if(action.startsWith('translate-language:')){
        const parts=action.split(':'),channelId=parts[1],messageId=parts[2],language=saveLanguage(i.user.id,normalizeLanguage(i.values?.[0]));
        const targetChannel=i.channelId===channelId?i.channel:await client.channels.fetch(channelId);
        const original=await targetChannel.messages.fetch(messageId);
        await translatedMessageEdit(i,original,language);
        return;
      }
      if(action.startsWith('buy:')||action==='store-buy'){if(store.settings().operationsLive?.storeOpen===false)throw new AppError('A loja está fechada no momento.');if(!store.settings().sales.pixKey)throw new AppError('As vendas ainda não foram configuradas.');const pendingCoupon=store.get(`coupon-user:${i.user.id}`),couponCode=pendingCoupon&&Number(pendingCoupon.expires)>Date.now()?pendingCoupon.code:'';
        if(couponCode){
          const cp=store.one('SELECT role_id FROM coupons WHERE code=?',couponCode);
          if(cp?.role_id){const m=i.member?.roles?.cache?i.member:await requireGuild().members.fetch(i.user.id);if(!m.roles.cache.has(cp.role_id))throw new AppError('Este cupom exige um cargo específico no servidor.');}
        }
        const order=store.createOrder(action==='store-buy'?i.values[0]:action.split(':')[1],i.user.id,couponCode);if(couponCode)store.run('DELETE FROM kv WHERE key=?',`coupon-user:${i.user.id}`);void updateOperationsLive(true);await localizedEdit(i,{content:await orderText(order),components:[row(button('Enviar comprovante / falar com equipe','ticket',2))]});return;}
      if(action==='pedido'){const orderId=i.options.getString('id');const order=orderId?store.one('SELECT * FROM orders WHERE id=? AND user_id=?',orderId,i.user.id):store.one('SELECT * FROM orders WHERE user_id=? ORDER BY created DESC LIMIT 1',i.user.id);if(!order)throw new AppError('Pedido não encontrado.');let text=order.status==='pending'?await orderText(order):`**Pedido ${order.id}**\nSituação: **${orderStatusLabel(order.status)}**\nValor: **${money(order.price)}**${order.coupon_code?`\nCupom: **${order.coupon_code}** · desconto ${money(order.discount||0)}`:''}`;if(['paid','delivered'].includes(order.status)){const unit=store.one('SELECT secret FROM stock WHERE order_id=?',order.id);if(unit)text+=`\n\nSua entrega: ${store.decrypt(unit.secret)}`;}await localizedEdit(i,{content:text.slice(0,1900),components:[row(button('Abrir suporte','central-ticket',2),button('Minha conta','central-profile',2))],allowedMentions:safe});return;}
      if(action.startsWith('giveaway:')){
        const id=action.split(':')[1],g=store.one('SELECT * FROM giveaways WHERE id=?',id);
        if(!g||g.status!=='active'||Date.parse(JSON.parse(g.data).endsAt)<=Date.now())throw new AppError('Sorteio encerrado.');
        const checked=await evaluateGiveaway(id,i.user.id,{enter:true,record:true});
        const lines=checked.results.map(r=>`${r.ok?'✅':'❌'} **${r.label}** — ${r.detail}`);
        const components=[];
        if(checked.results.some(r=>r.type==='invites')){
          try{const url=await giveawayInviteUrl(id,i.user.id);components.push(linkButton('Meu convite',url));}catch(e){lines.push(`⚠️ Convites: ${e.message}`);}
        }
        if(checked.results.some(r=>r.needsYoutube)){
          const url=await createGoogleConnectUrl(id,i.user.id);
          if(url)components.push(linkButton('Conectar YouTube',url));else lines.push('⚠️ YouTube: integração Google ainda não configurada.');
        }
        components.push(button('Verificar novamente',`giveaway:${id}`,2));
        const head=checked.ok?'🎉 **Participação confirmada! Você está concorrendo.**':'**Complete os requisitos abaixo para participar:**';
        await localizedEdit(i,{content:`${head}\n\n${lines.join('\n')}`.slice(0,1900),components:components.length?[row(...components.slice(0,5))]:[]});
        return;
      }
      await localizedEdit(i,'Ação indisponível.');
    }catch(e){store.log('erro',e.message,'interação');if(i.deferred||i.replied)await localizedEdit(i,{content:e instanceof AppError?e.message:'Não foi possível concluir. Confira as permissões do bot ou procure a equipe.',components:[]}).catch(()=>{});}
  });
  for(const [event,key] of [[Events.GuildMemberAdd,'welcome'],[Events.GuildMemberRemove,'goodbye']])client.on(event,async m=>{
    if(m.guild.id!==env.DISCORD_GUILD_ID)return;
    try{
      if(key==='welcome')await attributeInvite(m);
      else{const leftAt=store.now();store.run("UPDATE invite_joins SET left_at=? WHERE joined_user_id=? AND left_at IS NULL",leftAt,m.id);store.run("UPDATE referral_joins SET left_at=? WHERE joined_user_id=? AND left_at IS NULL",leftAt,m.id);}
      store.run('INSERT INTO member_events(user_id,event,created) VALUES(?,?,?)',m.id,key==='welcome'?'join':'leave',store.now());
      const s=store.settings(),t=s[key];
      if(t.enabled&&t.channelId){
        const variables={user:`<@${m.id}>`,username:m.user.username,server:m.guild.name,count:String(m.guild.memberCount)};
        const content=t.content.replace(/\{(user|username|server|count)\}/g,(v,k)=>variables[k]);const e=embedPayload(t.embed,variables);
        const payload=withTranslator({content:content||undefined,embeds:e.title||e.description||e.fields?.length?[e]:[],components:linkRows(t.buttons||[],env.DISCORD_GUILD_ID)});
        payload.allowedMentions=mentionPolicy(payload,key==='welcome'?[m.id]:[]);
        await(await channel(t.channelId)).send(payload);
      }
      if(s.logs.members){
        if(key==='welcome'){
          await audit('membro entrou',`<@${m.id}> entrou no servidor.`,m.id,{targetId:m.id});
        }else{
          await wait(650);
          const banEntry=await recentAudit(m.guild,AuditLogEvent.MemberBanAdd,{targetId:m.id,maxAge:3500});
          if(!banEntry){
            const kickEntry=await recentAudit(m.guild,AuditLogEvent.MemberKick,{targetId:m.id,maxAge:3500});
            if(kickEntry?.executorId)await audit('membro expulso',`<@${kickEntry.executorId}> expulsou <@${m.id}> do servidor.${kickEntry.reason?` Motivo: ${kickEntry.reason}`:''}`,kickEntry.executorId,{targetId:m.id});
            else await audit('membro saiu',`<@${m.id}> saiu do servidor.`,m.id,{targetId:m.id});
          }
        }
      }
      void updateLivePanels(true);
    }catch(e){store.log('erro',e.message);}
  });
  client.on(Events.MessageCreate,m=>{
    if(m.guildId!==env.DISCORD_GUILD_ID||m.author.bot||m.webhookId||configuredLogChannels(store.settings().logs).includes(m.channelId))return;
    const day=new Date().toISOString().slice(0,10);
    store.run('INSERT INTO message_activity(day,user_id,count) VALUES(?,?,1) ON CONFLICT(day,user_id) DO UPDATE SET count=count+1',day,m.author.id);
    store.run("UPDATE tickets SET updated=? WHERE channel_id=? AND status='open'",store.now(),m.channelId);
  });
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function recentAudit(guild,type,{targetId='',channelId='',maxAge=5000}={}){
    try{
      const logs=await guild.fetchAuditLogs({type,limit:8});
      return [...logs.entries.values()].find(entry=>{
        if(Date.now()-entry.createdTimestamp>maxAge)return false;
        if(targetId&&entry.targetId!==targetId)return false;
        const extraChannelId=entry.extra?.channel?.id||entry.extra?.channelId||entry.extra?.channel_id||'';
        if(channelId&&extraChannelId&&extraChannelId!==channelId)return false;
        return true;
      })||null;
    }catch{return null;}
  }
  client.on(Events.VoiceStateUpdate,async(oldState,newState)=>{
    if(newState.guild.id!==env.DISCORD_GUILD_ID||newState.member?.user?.bot)return;
    if(!oldState.channelId&&newState.channelId)startVoiceForUser(newState.id,store.now());
    else if(oldState.channelId&&!newState.channelId)stopVoiceForUser(newState.id);
    if(!store.settings().logs.moderation)return;
    if(oldState.channelId&&!newState.channelId){
      await wait(650);
      const entry=await recentAudit(newState.guild,AuditLogEvent.MemberDisconnect,{maxAge:2500});
      if(entry?.executorId){
        await audit('membro removido da call',`<@${entry.executorId}> removeu <@${newState.id}> da call <#${oldState.channelId}>.${entry.reason?` Motivo: ${entry.reason}`:''}`,entry.executorId,{targetId:newState.id,channelId:oldState.channelId}).catch(()=>{});
      }
    }else if(oldState.channelId&&newState.channelId&&oldState.channelId!==newState.channelId){
      await wait(650);
      const entry=await recentAudit(newState.guild,AuditLogEvent.MemberMove,{channelId:newState.channelId,maxAge:2500});
      if(entry?.executorId){
        await audit('membro movido de call',`<@${entry.executorId}> moveu <@${newState.id}> de <#${oldState.channelId}> para <#${newState.channelId}>.${entry.reason?` Motivo: ${entry.reason}`:''}`,entry.executorId,{targetId:newState.id,channelId:newState.channelId,fromChannelId:oldState.channelId}).catch(()=>{});
      }
    }
  });
  const logEvent=(event,setting,type,text,actor=()=> 'Discord')=>client.on(event,(...args)=>{
    const object=args.at(-1),guildId=object.guild?.id||object.guildId;
    if(guildId===env.DISCORD_GUILD_ID&&store.settings().logs[setting])void audit(type,text(...args),actor(...args)).catch(()=>{});
  });
  const shouldIgnoreMessageLog=m=>{
    const logChannels=new Set(configuredLogChannels(store.settings().logs));
    return !m||m.guildId!==env.DISCORD_GUILD_ID||logChannels.has(m.channelId)||m.author?.bot===true||!!m.webhookId||m.system===true;
  };
  client.on(Events.MessageDelete,async m=>{
    if(shouldIgnoreMessageLog(m)||!store.settings().logs.messages)return;
    await wait(500);
    const entry=m.guild?await recentAudit(m.guild,AuditLogEvent.MessageDelete,{targetId:m.author?.id||'',channelId:m.channelId,maxAge:3000}):null;
    const actor=entry?.executorId||m.author?.id||'Discord',target=m.author?.id||'';
    const actorText=/^\d{17,20}$/.test(String(actor))?`<@${actor}>`:'Discord';
    const targetText=target?`<@${target}>`:'autor não disponível';
    const detail=`${actorText} excluiu uma mensagem de ${targetText} em <#${m.channelId}>.`;
    void audit('mensagem excluída',detail,actor,{targetId:target,channelId:m.channelId,messageId:m.id,previewBefore:m.content||'[conteúdo não disponível no cache]'}).catch(()=>{});
  });
  client.on(Events.MessageUpdate,(oldMessage,newMessage)=>{
    if(shouldIgnoreMessageLog(newMessage)||!store.settings().logs.messages)return;
    if(oldMessage?.content===newMessage?.content&&JSON.stringify(oldMessage?.embeds||[])===JSON.stringify(newMessage?.embeds||[]))return;
    const actor=newMessage.author?.id||'Discord',target=newMessage.author?.id||'';
    const actorText=target?`<@${target}>`:'autor não disponível';
    const detail=`${actorText} editou a própria mensagem em <#${newMessage.channelId}>.`;
    void audit('mensagem editada',detail,actor,{targetId:target,channelId:newMessage.channelId,messageId:newMessage.id,previewBefore:oldMessage?.content||'[conteúdo anterior não disponível]',previewAfter:newMessage?.content||'[conteúdo atual não disponível]'}).catch(()=>{});
  });
  client.on(Events.GuildBanAdd,async b=>{
    if(b.guild.id!==env.DISCORD_GUILD_ID||!store.settings().logs.moderation)return;
    await wait(500);const entry=await recentAudit(b.guild,AuditLogEvent.MemberBanAdd,{targetId:b.user.id,maxAge:3500}),actor=entry?.executorId||'Discord';
    const actorText=entry?.executorId?`<@${entry.executorId}>`:'Discord';void audit('membro banido',`${actorText} baniu <@${b.user.id}>.${entry?.reason?` Motivo: ${entry.reason}`:''}`,actor,{targetId:b.user.id}).catch(()=>{});
  });
  client.on(Events.GuildBanRemove,async b=>{
    if(b.guild.id!==env.DISCORD_GUILD_ID||!store.settings().logs.moderation)return;
    await wait(500);const entry=await recentAudit(b.guild,AuditLogEvent.MemberBanRemove,{targetId:b.user.id,maxAge:3500}),actor=entry?.executorId||'Discord';
    const actorText=entry?.executorId?`<@${entry.executorId}>`:'Discord';void audit('membro desbanido',`${actorText} removeu o banimento de <@${b.user.id}>.${entry?.reason?` Motivo: ${entry.reason}`:''}`,actor,{targetId:b.user.id}).catch(()=>{});
  });
  const channelAuditType={criado:AuditLogEvent.ChannelCreate,excluído:AuditLogEvent.ChannelDelete,alterado:AuditLogEvent.ChannelUpdate};
  for(const [event,label] of [[Events.ChannelCreate,'criado'],[Events.ChannelDelete,'excluído'],[Events.ChannelUpdate,'alterado']])client.on(event,async(...args)=>{
    const ch=args.at(-1);if(ch.guild?.id!==env.DISCORD_GUILD_ID||!store.settings().logs.channels)return;
    await wait(400);const entry=await recentAudit(ch.guild,channelAuditType[label],{targetId:ch.id,maxAge:3000}),actor=entry?.executorId||'Discord',actorText=entry?.executorId?`<@${entry.executorId}>`:'Discord';
    void audit(`canal ${label}`,`${actorText} ${label==='criado'?'criou':label==='excluído'?'excluiu':'alterou'} o canal **#${ch.name}** (<#${ch.id}>).`,actor,{targetLabel:`#${ch.name}`,channelId:ch.id}).catch(()=>{});
  });
  const roleAuditType={criado:AuditLogEvent.RoleCreate,excluído:AuditLogEvent.RoleDelete,alterado:AuditLogEvent.RoleUpdate};
  for(const [event,label] of [[Events.GuildRoleCreate,'criado'],[Events.GuildRoleDelete,'excluído'],[Events.GuildRoleUpdate,'alterado']])client.on(event,async(...args)=>{
    const role=args.at(-1);if(role.guild?.id!==env.DISCORD_GUILD_ID||!store.settings().logs.roles)return;
    await wait(400);const entry=await recentAudit(role.guild,roleAuditType[label],{targetId:role.id,maxAge:3000}),actor=entry?.executorId||'Discord',actorText=entry?.executorId?`<@${entry.executorId}>`:'Discord';
    void audit(`cargo ${label}`,`${actorText} ${label==='criado'?'criou':label==='excluído'?'excluiu':'alterou'} o cargo <@&${role.id}> (**${role.name}**).`,actor,{targetLabel:role.name}).catch(()=>{});
  });
  client.on(Events.Error,e=>{error=e.message;store.log('erro','Falha na conexão com o Discord.');});
  client.once(Events.ClientReady,async()=>{console.log(`Discord conectado como ${client.user?.tag||client.user?.username||'Studio K'}.`);
    try{const guild=requireGuild();const commands=[{name:'central',description:'Abra a Central Studio K'},{name:'perfil',description:'Veja sua conta, tickets e pedidos'},{name:'ajuda',description:'Pesquise ajuda e perguntas frequentes',options:[{name:'busca',description:'Assunto ou palavra-chave',type:3,required:false}]},{name:'loja',description:'Veja produtos e serviços disponíveis'},{name:'cupom',description:'Aplique um cupom na próxima compra',options:[{name:'codigo',description:'Código do cupom',type:3,required:true}]},{name:'pedido',description:'Consulte um pedido e recupere sua entrega',options:[{name:'id',description:'Código completo do pedido; deixe vazio para o mais recente',type:3,required:false}]},{name:'ticket',description:'Abra um atendimento privado'},{name:'verificar',description:'Aceite as regras e receba acesso'},{name:'notificacoes',description:'Escolha quais notificações deseja receber'},{name:'idioma',description:'Escolha o idioma das mensagens privadas do Studio K'},{name:'Traduzir mensagem',type:3}];await new REST({version:'10'}).setToken(env.DISCORD_TOKEN).put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID||client.user.id,guild.id),{body:commands});const s=store.settings().brand;client.user.setPresence({status:s.status,activities:s.activity?[{name:s.activity,type:ActivityType[s.activityType]}]:[]});await refreshInviteCache(guild);for(const state of guild.voiceStates.cache.values())if(state.member&&!state.member.user.bot&&state.channelId)startVoiceForUser(state.id,store.now());try{await applyVoicePresence();}catch(e){store.log('aviso',`Presença em call: ${e.message}`);}store.log('conexão',`Conectado ao servidor ${guild.name}.`);error='';await tick();}catch(e){error=e.message;store.log('erro',e.message);}
  });
  const timer=setInterval(()=>void tick(),30000);timer.unref();
  return {status,client,channel,member,memberProfile,assignRole,verifyOAuthUser,sendMessage,openTicket,closeTicket,publishPanel,publishConfiguredMessage,publishProduct,createGiveaway,evaluateGiveaway,updateSalesLive,updateLivePanels,createEvent,applyBrand,applyVoicePresence,makeBackup,tick,
    async metadata(){
      const g=requireGuild();
      await Promise.all([g.channels.fetch(),g.roles.fetch(),g.emojis.fetch(),g.members.fetch()]);
      return{
        channels:[...g.channels.cache.values()].filter(Boolean).map(c=>({id:c.id,name:c.name,type:c.type})),
        roles:[...g.roles.cache.values()].filter(r=>!r.managed&&r.id!==g.id).map(r=>({id:r.id,name:r.name})),
        members:[...g.members.cache.values()].filter(m=>!m.user?.bot).slice(0,1000).map(m=>({id:m.id,name:m.displayName||m.user?.username||m.id,username:m.user?.username||''})),
        emojis:[...g.emojis.cache.values()].map(e=>({id:e.id,name:e.name||'emoji',animated:!!e.animated,url:e.imageURL({extension:e.animated?'gif':'png',size:64})}))
      };
    },
    async start(){if(!env.DISCORD_TOKEN)return;if(!env.DISCORD_GUILD_ID){error='Configure DISCORD_GUILD_ID.';return;}try{await client.login(env.DISCORD_TOKEN);}catch(e){error='Não foi possível conectar. Confira token, servidor e intents no Discord Developer Portal.';console.error(`Discord: ${error} ${e?.message||''}`.trim());store.log('erro',error);}},
    async stop(){clearInterval(timer);const vc=env.DISCORD_GUILD_ID?getVoiceConnection(env.DISCORD_GUILD_ID):null;if(vc)vc.destroy();await client.destroy();}
  };
}
