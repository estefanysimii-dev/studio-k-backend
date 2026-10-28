import {randomUUID} from 'node:crypto';
import {AppError} from './store.js';

const noMentions={parse:[],users:[],roles:[],repliedUser:false};
const HOOK_NAME='Studio K · atendimento pelo site';

export function ticketMessageOrigin(store,ticket,message,botId){
  const saved=store.one('SELECT * FROM ticket_web_messages WHERE message_id=? AND ticket_id=?',message.id,ticket.id);
  let origin=saved?.user_id===ticket.user_id?saved:null,content=String(message.content||'');
  if(!origin&&message.author?.id===botId&&!message.webhookId){
    const legacy=content.match(/^\*\*Mensagem enviada pelo site · <@!?(\d{17,20})>\*\*\r?\n/);
    if(legacy?.[1]===ticket.user_id){
      const body=content.slice(legacy[0].length);
      if(store.one('SELECT id FROM ticket_notes WHERE ticket_id=? AND actor=? AND private=0 AND note=?',ticket.id,ticket.user_id,body)){
        origin={user_id:ticket.user_id,author_name:'',avatar_url:''};content=body;
      }
    }
  }
  return{origin,content};
}

export function createTicketWebBridge({store,getChannel,getProfile,botId,onReply=async()=>{}}){
  const hookTasks=new Map();
  function ticketFor(ticketId,userId){
    const ticket=store.one('SELECT * FROM tickets WHERE id=? AND user_id=?',ticketId,userId);
    if(!ticket)throw new AppError('Atendimento não encontrado.',404);
    return ticket;
  }
  async function webhook(channel){
    if(hookTasks.has(channel.id))return hookTasks.get(channel.id);
    const task=(async()=>{
      const hooks=await channel.fetchWebhooks();
      const owned=[...hooks.values()].find(h=>h.owner?.id===botId()&&h.channelId===channel.id&&h.name===HOOK_NAME&&h.type===1);
      return owned||channel.createWebhook({name:HOOK_NAME,reason:'Identificar as mensagens enviadas pela conta autenticada no site Studio K.'});
    })();
    hookTasks.set(channel.id,task);
    try{return await task;}finally{hookTasks.delete(channel.id);}
  }
  async function reply(ticketId,userId,text){
    const ticket=ticketFor(ticketId,userId);
    if(ticket.status!=='open'||!ticket.channel_id)throw new AppError('Este atendimento não está aberto.',409);
    const content=String(text||'').trim().slice(0,1800);
    if(!content)throw new AppError('Escreva uma mensagem.');
    const profile=await getProfile(userId,{force:true});
    if(!profile?.id||profile.id!==userId)throw new AppError('Não foi possível confirmar o autor no Discord.',503);
    const c=await getChannel(ticket.channel_id);
    let hook;
    try{hook=await webhook(c);}catch(error){if(error.code===50013)throw new AppError('O bot precisa da permissão Gerenciar Webhooks neste canal para mostrar o nome e a foto de quem envia.',503);throw error;}
    const author=String(profile.name||profile.username||userId).replace(/[\r\n\x00-\x1f]/g,'').slice(0,80);
    // The identity comes from Discord, never from client-supplied name/avatar fields.
    const message=await hook.send({content,username:author,avatarURL:profile.avatar||undefined,allowedMentions:noMentions});
    store.transaction(()=>{
      store.run('INSERT INTO ticket_web_messages(message_id,ticket_id,user_id,author_name,avatar_url,created) VALUES(?,?,?,?,?,?)',message.id,ticketId,userId,author,profile.avatar||'',store.now());
      store.run('INSERT INTO ticket_notes(id,ticket_id,actor,note,private,created) VALUES(?,?,?,?,0,?)',randomUUID(),ticketId,userId,content,store.now());
      store.run("UPDATE tickets SET state='waiting_staff',updated=? WHERE id=?",store.now(),ticketId);
    });
    await onReply(ticketId,userId,content);
    return{id:message.id,created:message.createdAt?.toISOString?.()||store.now()};
  }
  async function messages(ticketId,userId){
    const ticket=ticketFor(ticketId,userId);
    if(!ticket.channel_id||ticket.status!=='open')return[];
    const c=await getChannel(ticket.channel_id),batch=await c.messages.fetch({limit:100});
    const profiles=new Map();
    const profile=id=>{
      if(!profiles.has(id))profiles.set(id,Promise.resolve().then(()=>getProfile(id)).catch(()=>null));
      return profiles.get(id);
    };
    return Promise.all([...batch.values()].reverse().filter(message=>!message.system).map(async message=>{
      const {origin,content}=ticketMessageOrigin(store,ticket,message,botId());
      const person=origin?await profile(origin.user_id):null;
      return{
        id:message.id,authorId:origin?.user_id||message.author?.id||'',
        author:origin?(person?.name||origin.author_name||origin.user_id):(message.member?.displayName||message.author?.globalName||message.author?.username||'Studio K'),
        avatar:origin?(person?.avatar||origin.avatar_url||''):(message.member?.displayAvatarURL?.({size:64})||message.author?.displayAvatarURL?.({size:64})||''),
        customer:(origin?.user_id||message.author?.id)===userId,bot:origin?false:!!message.author?.bot,viaSite:!!origin,
        content:content.slice(0,3000),attachments:[...(message.attachments?.values?.()||[])].map(a=>({name:a.name||'arquivo',url:a.url})).slice(0,10),
        created:message.createdAt?.toISOString?.()||store.now()
      };
    }));
  }
  return{reply,messages};
}
