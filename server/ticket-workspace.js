import {createHash} from 'node:crypto';
import {ChannelType,PermissionFlagsBits as P} from 'discord.js';
import {AppError} from './store.js';
import {TICKET_LOG_FIELDS,ticketParent} from './ticket-config.js';
export {TICKET_LOG_FIELDS,ticketParent} from './ticket-config.js';

const safe={parse:[],users:[],roles:[],repliedUser:false};
const hash=value=>createHash('sha256').update(value).digest('hex');
const stateLabel=value=>({waiting_staff:'Aguardando equipe',in_progress:'Em atendimento',waiting_customer:'Aguardando cliente',escalated:'Escalado',closed:'Finalizado'}[value]||value);
const priorityLabel=value=>({low:'Baixa',normal:'Normal',high:'Alta',urgent:'Urgente'}[value]||value);
const staffOverwrites=(guild,botId,roles)=>[
  {id:guild.id,deny:[P.ViewChannel]},
  {id:botId,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.ManageChannels,P.ManageMessages,P.AttachFiles]},
  ...roles.map(id=>({id,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.AttachFiles]}))
];
export async function assertPrivateStaffChannel(channel,guild,roles,botId){
  if(!channel||channel.guild?.id!==guild.id||![ChannelType.GuildText,ChannelType.GuildCategory].includes(channel.type))throw new AppError('Escolha um canal/categoria deste servidor.',400);
  if(channel.permissionsFor(guild.roles.everyone)?.has(P.ViewChannel))throw new AppError('O canal de informações/logs deve ser privado para a equipe.',400);
  await guild.roles.fetch();
  for(const role of guild.roles.cache.values()){
    if(role.id===guild.id||roles.includes(role.id)||role.permissions?.has(P.Administrator)||role.tags?.botId===botId)continue;
    if(channel.permissionsFor(role)?.has(P.ViewChannel))throw new AppError('O canal de informações/logs permite acesso a um cargo fora da equipe.',400);
  }
  for(const overwrite of channel.permissionOverwrites?.cache.values()||[]){
    if(overwrite.type!==1||overwrite.id===botId||!overwrite.allow.has(P.ViewChannel))continue;
    const member=await guild.members.fetch(overwrite.id);
    if(!member.permissions.has(P.Administrator)&&!roles.some(id=>member.roles.cache.has(id)))throw new AppError('O canal de informações/logs permite acesso a uma pessoa fora da equipe.',400);
  }
}
function historyLine(event){
  const actor=/^\d{17,20}$/.test(String(event.actor||''))?`<@${event.actor}>`:'Sistema/painel';
  const labels={open:'abriu o ticket',reopen:'reabriu o ticket',claim:'assumiu o atendimento',call:'chamou o cliente',rename:'renomeou o ticket',transfer:'transferiu o atendimento',type:`alterou o tipo de ${event.from||''} para ${event.to||''}`,state:`alterou o estado para ${stateLabel(event.state)}`,priority:`alterou a prioridade para ${priorityLabel(event.priority)}`,tags:`atualizou as tags: ${(event.tags||[]).join(', ')}`,note:'adicionou uma nota interna','web-reply':'respondeu pelo site',close:'finalizou o ticket'};
  return `[${event.at||''}] ${actor} ${labels[event.action]||String(event.action||'Atualização')}`;
}
function textFiles(lines,prefix){
  const files=[];let current='';
  for(const line of lines){
    if(current&&Buffer.byteLength(current+line)>240000){files.push({attachment:Buffer.from(current),name:`${prefix}-${files.length+1}.txt`});current='';}
    current+=line+'\n';
  }
  if(current)files.push({attachment:Buffer.from(current),name:`${prefix}-${files.length+1}.txt`});
  return files;
}
export function ticketSummary(ticket,{notes=[],fields=TICKET_LOG_FIELDS,transcriptUrl='',reason='',events=[]}={}){
  const selected=new Set(fields),result=[];
  const field=(key,name,value,inline=true)=>{if(selected.has(key))result.push({name,value:String(value||'—').slice(0,1024),inline});};
  field('customer','Cliente',`<@${ticket.user_id}>`);
  field('type','Tipo de atendimento',ticket.category);
  field('priority','Prioridade',priorityLabel(ticket.priority));
  field('state','Estado',stateLabel(ticket.status==='closed'?'closed':ticket.state));
  field('assignee','Responsável',ticket.claimed_by?`<@${ticket.claimed_by}>`:'Não atribuído');
  let tags=[];try{tags=JSON.parse(ticket.tags||'[]');}catch{}
  field('tags','Tags',tags.join(', ')||'Nenhuma');
  field('dates','Datas',`Abertura: ${ticket.created}\nÚltima atualização: ${ticket.updated}`,false);
  field('reason','Motivo do encerramento',reason||ticket.closed_reason||'Não informado',false);
  field('notes','Notas internas',notes.length?`${notes.length} nota(s). Consulte as mensagens internas e o arquivo completo no encerramento.`:'Nenhuma',false);
  field('history','Última ação',events.length?historyLine(events.at(-1)):'Ticket aberto',false);
  field('transcript','Conversa com o cliente',transcriptUrl?`[Abrir transcript](${transcriptUrl})`:'Disponível após o encerramento.',false);
  return{title:`Ticket ${ticket.id.slice(0,8)} · ${ticket.status==='closed'?'Finalizado':'Acompanhamento interno'}`,color:0xF345FE,fields:result,footer:{text:`Studio K · ticket:${ticket.id}`}};
}

export function createTicketWorkspace({store,getGuild,getChannel,botId,staffRoles,renderControls=()=>({})}){
  const tasks=new Map(),closing=new Map(),nextTry=new Map();let maintenanceBusy=false;
  const jobKey=id=>`ticket-close-job:${id}`;
  const infoTopic=id=>`studio-k-ticket-info:${id}`;
  const notesFor=id=>store.all('SELECT * FROM ticket_notes WHERE ticket_id=? AND private=1 ORDER BY created,id',id);
  const eventsFor=id=>{
    const rows=store.all('SELECT data FROM ticket_events WHERE ticket_id=? ORDER BY created,id',id);
    return rows.length?rows.map(row=>JSON.parse(row.data)):(store.get(`ticket-audit:${id}`,{events:[]}).events||[]);
  };
  async function category(id){
    const c=await getChannel(id);
    if(c.type!==ChannelType.GuildCategory||c.guild.id!==getGuild().id)throw new AppError('Escolha uma categoria válida deste servidor.',400);
    return c;
  }
  async function validate(settings){
    for(const id of new Set([settings.categoryId,...(settings.categoryRoutes||[]).map(route=>route.categoryId)].filter(Boolean)))await category(id);
    const guild=getGuild(),roles=staffRoles();
    if(settings.panelChannelId){const c=await getChannel(settings.panelChannelId);if(c.type!==ChannelType.GuildText||c.guild.id!==guild.id)throw new AppError('Escolha um canal de texto para o painel público.',400);}
    if(settings.staffInfoCategoryId)await assertPrivateStaffChannel(await category(settings.staffInfoCategoryId),guild,roles,botId());
    const logId=settings.logChannelId||store.settings().logs.ticketsChannelId||store.settings().logs.channelId;
    if(logId){const c=await getChannel(logId);if(c.type!==ChannelType.GuildText)throw new AppError('Escolha um canal de texto para os logs.',400);await assertPrivateStaffChannel(c,guild,roles,botId());}
  }
  async function createDestination({name,kind,parentId=''}){
    const guild=getGuild(),roles=staffRoles();
    if(!roles.length)throw new AppError('Configure os cargos da equipe antes de criar categorias privadas.',400);
    await guild.channels.fetch();
    const type=kind==='category'?ChannelType.GuildCategory:ChannelType.GuildText;
    const existing=[...guild.channels.cache.values()].find(c=>c?.name===name&&c.type===type);
    if(existing){await assertPrivateStaffChannel(existing,guild,roles,botId());return{id:existing.id,name:existing.name,reused:true};}
    if(parentId)await category(parentId);
    const created=await guild.channels.create({name,type,...(parentId?{parent:parentId}:{}),permissionOverwrites:staffOverwrites(guild,botId(),roles),reason:'Organização dos atendimentos Studio K pelo painel.'});
    return{id:created.id,name:created.name,reused:false};
  }
  async function syncNow(id){
    let ticket=store.one('SELECT * FROM tickets WHERE id=?',id);
    const settings=store.settings().tickets;
    if(!ticket)return;
    if((nextTry.get(id)||0)>Date.now())return;
    const destination=ticketParent(settings,ticket.category);
    if(ticket.status==='open'&&destination&&ticket.channel_id){
      await category(destination);
      const customer=await getChannel(ticket.channel_id);
      if(customer.parentId!==destination)await customer.setParent(destination,{lockPermissions:false,reason:'Categoria configurada para este tipo de atendimento.'});
    }
    if(!settings.staffInfoCategoryId&&!ticket.staff_channel_id)return;
    const guild=getGuild(),roles=staffRoles();
    if(!roles.length)throw new AppError('Cargos da equipe não configurados.',400);
    let channel;
    if(ticket.staff_channel_id){try{channel=await getChannel(ticket.staff_channel_id);}catch(error){if(error.code!==10003&&error.status!==404)throw error;}}
    if(!channel){
      if(ticket.status!=='open')return;
      if(!settings.staffInfoCategoryId)return;
      await assertPrivateStaffChannel(await category(settings.staffInfoCategoryId),guild,roles,botId());
      await guild.channels.fetch();
      channel=[...guild.channels.cache.values()].find(c=>c?.topic===infoTopic(id));
      if(!channel){
        const customer=await getChannel(ticket.channel_id);
        channel=await guild.channels.create({name:`info-${customer.name}`.slice(0,100),type:ChannelType.GuildText,parent:settings.staffInfoCategoryId,topic:infoTopic(id),permissionOverwrites:staffOverwrites(guild,botId(),roles),reason:`Acompanhamento interno do ticket ${id}`});
      }
      store.run('UPDATE tickets SET staff_channel_id=?,staff_message_id=NULL WHERE id=?',channel.id,id);
      ticket=store.one('SELECT * FROM tickets WHERE id=?',id);
    }
    await assertPrivateStaffChannel(channel,guild,roles,botId());
    if(ticket.status==='open'&&settings.staffInfoCategoryId&&channel.parentId!==settings.staffInfoCategoryId){
      await assertPrivateStaffChannel(await category(settings.staffInfoCategoryId),guild,roles,botId());
      await channel.setParent(settings.staffInfoCategoryId,{lockPermissions:false,reason:'Categoria interna configurada no painel.'});
    }
    const notes=notesFor(id),events=eventsFor(id),controls=renderControls(ticket),summary=ticketSummary(ticket,{notes,events});
    const payload={...controls,embeds:[...(controls.embeds||[]).slice(0,8),summary],allowedMentions:safe};
    if(ticket.status!=='open')payload.components=[];
    const signature=hash(JSON.stringify(payload)),signatureKey=`ticket-info-signature:${id}`;
    let message;
    if(ticket.staff_message_id){try{message=await channel.messages.fetch(ticket.staff_message_id);}catch(error){if(error.code!==10008&&error.status!==404)throw error;}}
    if(!message){
      message=await channel.send({...payload,nonce:`ti-${hash(id).slice(0,20)}`,enforceNonce:true});
      store.run('UPDATE tickets SET staff_message_id=? WHERE id=?',message.id,id);
      const old=store.get(`ticket-controls:${id}`);
      if(old&&old!==message.id){
        try{const customer=await getChannel(ticket.channel_id),previous=await customer.messages.fetch(old);await previous.edit({content:'A equipe está acompanhando este atendimento.',embeds:[],components:[],allowedMentions:safe});}catch{}
      }
      store.set(`ticket-controls:${id}`,message.id);
      store.set(signatureKey,signature);
    }else if(store.get(signatureKey)!==signature){await message.edit(payload);store.set(signatureKey,signature);}
    // Each internal note is also retained as its own message while the ticket is open.
    for(const note of notes.filter(n=>!store.get(`ticket-info-note:${n.id}`)).slice(0,20)){
      const posted=await channel.send({content:`**Nota interna · ${/^\d{17,20}$/.test(note.actor)?`<@${note.actor}>`:'Painel'}**\n${note.note}`.slice(0,2000),nonce:`tn-${hash(note.id).slice(0,20)}`,enforceNonce:true,allowedMentions:safe});
      store.set(`ticket-info-note:${note.id}`,posted.id);
    }
    for(const event of events.filter(e=>!['note','web-reply'].includes(e.action)).slice(-50)){
      const eventHash=hash(JSON.stringify(event)),key=`ticket-info-event:${id}:${eventHash}`;
      if(store.get(key))continue;
      const posted=await channel.send({content:historyLine(event).slice(0,2000),nonce:`te-${eventHash.slice(0,20)}`,enforceNonce:true,allowedMentions:safe});
      store.set(key,posted.id);
    }
  }
  function sync(id){
    if(tasks.has(id))return tasks.get(id);
    const task=syncNow(id).catch(error=>{nextTry.set(id,Date.now()+30000);throw error;}).finally(()=>tasks.delete(id));
    tasks.set(id,task);return task;
  }
  function publishClose(id){
    if(closing.has(id))return closing.get(id);
    const task=publishCloseNow(id).finally(()=>closing.delete(id));closing.set(id,task);return task;
  }
  async function publishCloseNow(id){
    const job=store.get(jobKey(id));if(!job||(job.nextAt||0)>Date.now())return false;
    const ticket=store.one('SELECT * FROM tickets WHERE id=?',id);if(!ticket||ticket.status!=='closed')return false;
    try{
      const cfg=store.settings(),logId=cfg.tickets.logChannelId||cfg.logs.ticketsChannelId||cfg.logs.channelId;
      if(!logId)throw new AppError('Configure um canal privado para os logs de tickets.',400);
      const channel=await getChannel(logId);
      if(channel.type!==ChannelType.GuildText)throw new AppError('O destino de logs precisa ser um canal de texto.',400);
      await assertPrivateStaffChannel(channel,getGuild(),staffRoles(),botId());
      const notes=notesFor(id),events=eventsFor(id),fields=cfg.tickets.logFields;
      const files=[
        ...(fields.includes('notes')?textFiles(notes.map(n=>`[${n.created}] ${n.actor}: ${n.note}`),`notas-${id.slice(0,8)}`):[]),
        ...(fields.includes('history')?textFiles(events.map(historyLine),`historico-${id.slice(0,8)}`):[])
      ];
      const parts=Math.max(1,Math.ceil(files.length/8)),destination=`${logId}:${hash(JSON.stringify(fields))}`;
      if(job.destination!==destination){job.destination=destination;job.part=0;}
      for(let part=job.part||0;part<parts;part++){
        const sent=await channel.send({embeds:[ticketSummary(ticket,{notes,events,fields,transcriptUrl:job.transcriptUrl,reason:ticket.closed_reason})],files:files.slice(part*8,part*8+8),nonce:`tl-${hash(id+destination+part).slice(0,20)}`,enforceNonce:true,allowedMentions:safe});
        job.part=part+1;job.messageId=sent.id;store.set(jobKey(id),job);
      }
      store.set(`ticket-close-published:${id}`,{channelId:logId,messageId:job.messageId,at:store.now()});
      store.run('DELETE FROM kv WHERE key=?',jobKey(id));
      if(cfg.tickets.deleteInfoChannelOnClose&&ticket.staff_channel_id){
        try{await(await getChannel(ticket.staff_channel_id)).delete('Ticket finalizado; informações preservadas no log.');}catch(error){store.log('aviso',`Canal interno do ticket ${id.slice(0,8)} preservado: ${String(error.message).slice(0,180)}`);}
      }
      return true;
    }catch(error){
      job.nextAt=Date.now()+60000;job.error=String(error.message).slice(0,300);store.set(jobKey(id),job);
      store.log('aviso',`Log do ticket ${id.slice(0,8)} pendente; dados internos preservados: ${job.error}`);return false;
    }
  }
  async function close(id,details){
    if(store.get(`ticket-close-published:${id}`))return true;
    if(!store.get(jobKey(id)))store.set(jobKey(id),{...details,nextAt:0,part:0});
    await sync(id).catch(()=>{});
    return publishClose(id);
  }
  async function maintain(){
    if(maintenanceBusy)return;maintenanceBusy=true;
    try{
    const settings=store.settings().tickets;
    if(settings.staffInfoCategoryId||settings.categoryId||settings.categoryRoutes.length){
      for(const t of store.all("SELECT id FROM tickets WHERE status='open' ORDER BY updated DESC LIMIT 50"))await sync(t.id).catch(error=>store.log('aviso',`Informações internas ${t.id.slice(0,8)}: ${String(error.message).slice(0,180)}`));
    }
    for(const row of store.all("SELECT key FROM kv WHERE key LIKE 'ticket-close-job:%' LIMIT 20"))await publishClose(row.key.slice('ticket-close-job:'.length));
    }finally{maintenanceBusy=false;}
  }
  return{sync,close,maintain,validate,createDestination};
}
