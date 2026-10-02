import { Client, GatewayIntentBits, Partials, Events, ChannelType, PermissionFlagsBits, ActivityType, REST, Routes, MessageFlags, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
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
export function createBot(store,env=process.env){
  const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,GatewayIntentBits.GuildModeration],partials:[Partials.Message,Partials.Channel]});
  let error='',busy=false,backupBusy=false;
  const requireGuild=()=>{if(!client.isReady())throw new AppError('Conecte o bot ao Discord antes desta ação.',503);const guild=client.guilds.cache.get(env.DISCORD_GUILD_ID);if(!guild)throw new AppError('O bot não está no servidor configurado.',503);return guild;};
  const channel=async channelId=>{const c=await requireGuild().channels.fetch(channelId);if(!c?.isTextBased()||!('send' in c))throw new AppError('Escolha um canal de texto do servidor.');return c;};
  const member=async userId=>requireGuild().members.fetch(userId);
  const status=()=>({connected:client.isReady()&&client.guilds.cache.has(env.DISCORD_GUILD_ID),configured:!!env.DISCORD_TOKEN,name:client.user?.username||'Studio K',guild:client.guilds.cache.get(env.DISCORD_GUILD_ID)?.name||null,members:client.guilds.cache.get(env.DISCORD_GUILD_ID)?.memberCount||0,latency:client.ws.ping,error});
  async function audit(type,detail,actor='Discord'){
    store.log(type,detail,actor);const cid=store.settings().logs.channelId;
    if(cid&&client.isReady())try{
      const style=store.settings().messageStyles.logs;
      const payload=stylePayload(style,{type,detail:String(detail).slice(0,4000),actor},env.DISCORD_GUILD_ID);await(await channel(cid)).send({...payload,allowedMentions:mentionPolicy(payload)});
    }catch{store.log('erro','Não foi possível publicar no canal de logs.');}
  }
  async function assignRole(userId,roleId){
    if(!roleId)return;const guild=requireGuild(),role=await guild.roles.fetch(roleId),me=await guild.members.fetchMe();
    if(!role||role.managed||role.id===guild.id||role.permissions.has(PermissionFlagsBits.Administrator)||role.position>=me.roles.highest.position)throw new AppError('O cargo precisa existir, não pode ser administrativo e deve ficar abaixo do cargo do bot.');
    await(await member(userId)).roles.add(role,'Studio K: cargo configurado');
  }
  async function verifyOAuthUser(user){
    const settings=store.settings(),v=settings.verification;
    if(!v.oauthEnabled)throw new AppError('A verificação OAuth não está ativada.');
    if(!v.roleId)throw new AppError('Configure o cargo liberado pela verificação.');
    const guild=requireGuild(),m=await member(user.id);
    if(Date.now()-m.user.createdTimestamp<v.minimumAccountDays*86400000)throw new AppError(`Sua conta precisa ter pelo menos ${v.minimumAccountDays} dias.`,403);
    await assignRole(user.id,v.roleId);
    const now=store.now(),username=String(user.global_name||user.username||m.user.username||user.id).slice(0,120);
    store.run('INSERT INTO verifications(user_id,username,verified_at,last_authorized_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,last_authorized_at=excluded.last_authorized_at',user.id,username,now,now);
    let dmSent=false;
    if(v.sendDm){
      try{
        const style=settings.messageStyles.verificationDm;
        const payload=stylePayload(style,{user:username,username,server:guild.name,role:`<@&${v.roleId}>`},env.DISCORD_GUILD_ID);await m.send({...payload,allowedMentions:mentionPolicy(payload)});
        dmSent=true;
      }catch(e){store.log('aviso',`Verificação concluída para ${user.id}, mas a DM não pôde ser entregue: ${String(e.message).slice(0,300)}`);}
    }
    await audit('verificação',`OAuth concluído e cargo liberado para ${username} (${user.id}).`,user.id);
    return {userId:user.id,username,dmSent};
  }
  async function sendMessage(data){
    const payload={content:data.content||undefined,embeds:data.embed?[embedPayload(data.embed)]:[],components:linkRows(data.buttons||[],env.DISCORD_GUILD_ID)};
    payload.allowedMentions=mentionPolicy(payload);
    let result;
    if(data.target==='dm'){
      if(!store.one('SELECT user_id FROM optins WHERE user_id=?',data.targetId))throw new AppError('O membro precisa ativar /notificacoes antes de receber mensagens deste editor.');
      result=await(await member(data.targetId)).send(payload);
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
  const isStaff=async i=>{
    if(i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)||i.memberPermissions?.has(PermissionFlagsBits.Administrator))return true;
    const roleId=store.settings().tickets.staffRoleId;if(!roleId)return false;
    const guild=requireGuild(),staffRole=await guild.roles.fetch(roleId);if(!staffRole)return false;
    const m=i.member?.roles?.cache?i.member:await guild.members.fetch(i.user.id);
    return m.roles.cache.has(roleId)||m.roles.highest.position>=staffRole.position;
  };
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
  async function openTicket(userId,category){
    const old=store.one("SELECT * FROM tickets WHERE user_id=? AND status='open'",userId);if(old?.channel_id)return old;
    if(old)throw new AppError('Seu ticket está sendo criado. Tente novamente em instantes.');
    const guild=requireGuild(),settings=store.settings(),ticketSettings=settings.tickets;
    if(!ticketSettings.staffRoleId)throw new AppError('Configure o cargo da equipe antes de abrir tickets.');
    await guild.roles.fetch();
    const staffRole=await guild.roles.fetch(ticketSettings.staffRoleId);if(!staffRole||staffRole.id===guild.id)throw new AppError('Configure um cargo válido e exclusivo para a equipe.');
    const elevatedRoles=[...guild.roles.cache.values()].filter(r=>!r.managed&&r.id!==guild.id&&r.position>=staffRole.position);
    const ticketName=await nextTicketName(category,guild);
    const id=randomUUID();store.run('INSERT INTO tickets(id,user_id,category,status,created,updated) VALUES(?,?,?,?,?,?)',id,userId,category,'open',store.now(),store.now());
    let c;
    try{
      const staffPermissions=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles,PermissionFlagsBits.ManageMessages];
      c=await guild.channels.create({name:ticketName,type:ChannelType.GuildText,parent:ticketSettings.categoryId||undefined,permissionOverwrites:[
        {id:guild.id,deny:[PermissionFlagsBits.ViewChannel]},
        {id:userId,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles]},
        {id:client.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageChannels,PermissionFlagsBits.ManageMessages]},
        ...elevatedRoles.map(r=>({id:r.id,allow:staffPermissions}))
      ]});
      store.run('UPDATE tickets SET channel_id=? WHERE id=?',c.id,id);
      const customerPayload=stylePayload(settings.messageStyles.ticketOpen,{user:`<@${userId}>`,category,server:guild.name,ticket:ticketName});
      await c.send({...customerPayload,allowedMentions:mentionPolicy(customerPayload,[userId])});
      const staffPayload=stylePayload(settings.messageStyles.ticketStaffPanel,{user:`<@${userId}>`,category,server:guild.name,ticket:ticketName});
      await c.send({...staffPayload,components:[...(staffPayload.components||[]),row(
        button('Assumir atendimento',`claim:${id}`,1),
        button('Renomear',`rename:${id}`,2),
        button('Chamar cliente',`call:${id}`,2),
        button('Finalizar',`close:${id}`,4)
      )],allowedMentions:mentionPolicy(staffPayload)});
      await audit('ticket',`Ticket ${ticketName} aberto: ${category}`,userId);return store.one('SELECT * FROM tickets WHERE id=?',id);
    }catch(e){
      if(!c)store.run('DELETE FROM tickets WHERE id=?',id);
      else store.log('erro',`Ticket ${id.slice(0,8)} criado, mas mensagem inicial falhou.`);
      throw e;
    }
  }
  async function closeTicket(id,actor){
    const ticket=store.one('SELECT * FROM tickets WHERE id=?',id);if(!ticket)throw new AppError('Ticket não encontrado.',404);if(ticket.status==='closed')return;
    const c=await channel(ticket.channel_id),messages=[];let before;
    for(let page=0;page<50;page++){const batch=await c.messages.fetch({limit:100,before});if(!batch.size)break;messages.push(...batch.values());before=batch.last().id;if(batch.size<100)break;}
    const ticketName=c.name;
    const transcript=messages.reverse().map(m=>`[${m.createdAt.toISOString()}] ${m.author?.tag||'desconhecido'} (${m.author?.id||''}): ${m.content||''}${m.attachments.size?'\n'+[...m.attachments.values()].map(a=>a.url).join('\n'):''}${m.embeds.length?'\n'+m.embeds.map(e=>[e.title,e.description].filter(Boolean).join('\n')).join('\n'):''}`).join('\n\n');
    const shareToken=randomBytes(32).toString('base64url'),now=store.now();
    store.run("UPDATE tickets SET transcript=?,status='closed',updated=? WHERE id=?",transcript,now,id);
    store.set(`transcript-share:${id}`,{hash:createHash('sha256').update(shareToken).digest('hex'),created:now});
    const publicBase=(env.PUBLIC_URL||'').replace(/\/$/,'');
    const transcriptUrl=`${publicBase}/api/public/tickets/${id}/transcript/${shareToken}`;
    let dmSent=false;
    try{
      const user=await member(ticket.user_id),style=store.settings().messageStyles.ticketClose;
      const closePayload=stylePayload(style,{ticket:ticketName,transcript:transcriptUrl,category:ticket.category},env.DISCORD_GUILD_ID);await user.send({...closePayload,components:[...(closePayload.components||[]),row(linkButton('Abrir transcript',transcriptUrl))],allowedMentions:mentionPolicy(closePayload)});
      dmSent=true;
    }catch(e){
      store.log('aviso',`Ticket ${ticketName} encerrado, mas a DM com o transcript não pôde ser entregue: ${String(e.message).slice(0,300)}`,actor);
    }
    await audit('ticket',`Ticket ${ticketName} encerrado${dmSent?' e transcript enviado por DM':' sem entrega da DM'}. O canal será removido.`,actor);
    try{await c.delete(`Studio K: ticket encerrado por ${actor}`);}
    catch(e){store.log('erro',`Ticket ${ticketName} foi encerrado, mas o canal não pôde ser removido: ${String(e.message).slice(0,300)}`,actor);throw new AppError('O atendimento foi encerrado e o transcript salvo, mas não foi possível apagar o canal. Confira a permissão Gerenciar Canais do bot.',500);}
    return {dmSent,transcriptUrl};
  }
  async function publishPanel(kind,channelId){
    const s=store.settings(),c=await channel(channelId);let payload;
    if(kind==='tickets'){
      payload=stylePayload(s.messageStyles.ticketPanel,{},env.DISCORD_GUILD_ID);payload.components=[...(payload.components||[]),row({type:3,custom_id:'ticket-category',placeholder:s.tickets.button.slice(0,150),options:s.tickets.categories.map((name,i)=>({label:name,value:String(i)}))})];
    }else{
      const verifyComponent=s.verification.oauthEnabled
        ? linkButton(s.verification.button,`${String(env.PUBLIC_URL||'').replace(/\/$/,'')}/api/oauth/discord/start`)
        : button(s.verification.button,'verify');
      payload=stylePayload(s.messageStyles.verificationPanel,{},env.DISCORD_GUILD_ID);payload.components=[...(payload.components||[]),row(verifyComponent)];
    }
    const message=await c.send({...payload,allowedMentions:mentionPolicy(payload)});await audit('painel',`Painel de ${kind} publicado.`,'painel');return{id:message.id};
  }
  async function publishProduct(productId,channelId){
    const p=store.products().find(p=>p.id===productId);if(!p)throw new AppError('Produto não encontrado.',404);
    const availability=p.type==='service'?'Sob demanda':`${p.stock} unidade(s)`;
    const payload=stylePayload(store.settings().messageStyles.product,{product:p.name,description:p.description||'Peça pelo botão abaixo.',price:money(p.priceCents),availability,category:p.category});
    if(p.image&&payload.embeds[0]&&!payload.embeds[0].image)payload.embeds[0].image={url:p.image};
    const m=await(await channel(channelId)).send({...payload,components:[...(payload.components||[]),row(button('Comprar com Pix',`buy:${p.id}`))],allowedMentions:mentionPolicy(payload)});return{id:m.id};
  }
  async function orderText(order){const s=store.settings().sales,p=JSON.parse(order.product);return`**Pedido ${order.id}**\n${p.name} · **${money(order.price)}**\n\nChave Pix: **${s.pixKey}**\nRecebedor: ${s.recipient}\n${s.instructions}\n\nValidade: <t:${Math.floor(Date.parse(order.expires)/1000)}:R>. A entrega depende da conferência manual do pagamento.\nConsulte novamente com /pedido.`;}
  async function deliverOrder(order){
    const p=JSON.parse(order.product);
    try{
      if(!order.role_done){await assignRole(order.user_id,p.roleId);store.run('UPDATE orders SET role_done=1 WHERE id=?',order.id);}
      if(!order.delivery_done){
        let delivery;
        if(p.type==='digital'){const unit=store.one('SELECT secret FROM stock WHERE order_id=?',order.id);if(!unit)throw new Error('Estoque reservado não encontrado.');delivery=store.decrypt(unit.secret);}
        else{const ticket=await openTicket(order.user_id,`Serviço: ${p.name}`);delivery=`Seu atendimento: <#${ticket.channel_id}>`;}
        const user=await member(order.user_id),style=store.settings().messageStyles.orderDelivery;
        const payload=stylePayload(style,{product:p.name,order:order.id,delivery,instructions:p.delivery||''});
        await user.send({...payload,allowedMentions:mentionPolicy(payload),nonce:createHash('sha256').update(order.id).digest('hex').slice(0,24),enforceNonce:true});
        store.run('UPDATE orders SET delivery_done=1 WHERE id=?',order.id);
      }
      store.run("UPDATE orders SET status='delivered',error=NULL WHERE id=?",order.id);await audit('entrega',`Pedido ${order.id.slice(0,8)} entregue.`);
    }catch(e){store.run('UPDATE orders SET error=? WHERE id=?',String(e.message).slice(0,500),order.id);}
  }
  async function createGiveaway(data){
    const c=await channel(data.channelId),id=randomUUID();store.run('INSERT INTO giveaways(id,data,status,created) VALUES(?,?,?,?)',id,JSON.stringify(data),'draft',store.now());
    const roleLine=data.requiredRoleId?`\nCargo necessário: <@&${data.requiredRoleId}>`:'';
    const payload=stylePayload(store.settings().messageStyles.giveaway,{title:data.title,description:data.description,ends:`<t:${Math.floor(Date.parse(data.endsAt)/1000)}:R>`,winners:data.winners,roleLine});
    const message=await c.send({...payload,components:[...(payload.components||[]),row(button('Participar do sorteio',`giveaway:${id}`))],allowedMentions:mentionPolicy(payload)});
    store.run("UPDATE giveaways SET status='active',message_id=? WHERE id=?",message.id,id);return{id};
  }
  async function finishGiveaway(g){
    const data=JSON.parse(g.data);let winners=g.winners?JSON.parse(g.winners):null;
    if(g.status==='active'){
      const eligible=[];for(const e of store.all('SELECT user_id FROM entries WHERE giveaway_id=?',g.id)){
        try{const m=await member(e.user_id);if(!m.user.bot&&(!data.requiredRoleId||m.roles.cache.has(data.requiredRoleId)))eligible.push(e.user_id);}catch(e){if(e.code!==10007)throw e;}
      }
      winners=store.drawGiveaway(g.id,eligible);
    }
    const result=winners.length?`Vencedor(es): ${winners.map(id=>`<@${id}>`).join(', ')}`:'Não houve participantes elegíveis.';
    const payload=stylePayload(store.settings().messageStyles.giveawayResult,{title:data.title,result});
    const c=await channel(data.channelId);await c.messages.edit(g.message_id,{...payload,components:payload.components||[],allowedMentions:mentionPolicy(payload)});
    store.run("UPDATE giveaways SET status='ended' WHERE id=?",g.id);
  }
  async function createEvent(data){const event=await requireGuild().scheduledEvents.create({name:data.name,description:data.description||undefined,scheduledStartTime:new Date(data.startsAt),scheduledEndTime:new Date(data.endsAt),privacyLevel:GuildScheduledEventPrivacyLevel.GuildOnly,entityType:GuildScheduledEventEntityType.External,entityMetadata:{location:data.location}});const id=randomUUID();store.run('INSERT INTO events VALUES(?,?,?,?)',id,JSON.stringify(data),event.id,store.now());return{id,discordId:event.id};}
  async function applyBrand(){const s=store.settings().brand;requireGuild();const body={username:s.name};if(s.avatar)body.avatar=s.avatar;if(s.banner)body.banner=s.banner;await client.user.edit(body);await client.application.edit({description:s.description});client.user.setPresence({status:s.status,activities:s.activity?[{name:s.activity,type:ActivityType[s.activityType]}]:[]});await audit('identidade','Identidade do bot atualizada.','painel');}
  async function snapshot(){const guild=requireGuild();await guild.channels.fetch();await guild.roles.fetch();return{id:guild.id,name:guild.name,description:guild.description,roles:[...guild.roles.cache.values()].map(r=>({id:r.id,name:r.name,color:r.color,permissions:r.permissions.bitfield.toString(),position:r.position,managed:r.managed})),channels:[...guild.channels.cache.values()].filter(Boolean).map(c=>({id:c.id,name:c.name,type:c.type,parentId:c.parentId,position:c.rawPosition,topic:c.topic,overwrites:c.permissionOverwrites?[...c.permissionOverwrites.cache.values()].map(p=>({id:p.id,type:p.type,allow:p.allow.bitfield.toString(),deny:p.deny.bitfield.toString()})):[]}))};}
  async function makeBackup(){if(backupBusy)throw new AppError('Já há um backup em andamento.',409);backupBusy=true;try{return await store.makeBackup(client.isReady()?await snapshot():null);}finally{backupBusy=false;}}
  async function tick(){if(busy)return;busy=true;try{
    for(const o of store.all("SELECT id FROM orders WHERE status='pending' AND expires<=?",store.now()))store.cancelOrder(o.id);
    const s=store.settings();if(s.backups.enabled&&Date.now()-Date.parse(store.get('lastBackup','1970-01-01'))>=s.backups.intervalHours*3600000)try{await makeBackup();}catch(e){store.log('erro',`Backup: ${e.message}`);}
    if(!client.isReady())return;
    for(const o of store.all("SELECT * FROM orders WHERE status='paid' LIMIT 10"))await deliverOrder(o);
    for(const g of store.all("SELECT * FROM giveaways WHERE status IN ('active','drawn')")){if(g.status==='drawn'||Date.parse(JSON.parse(g.data).endsAt)<=Date.now())try{await finishGiveaway(g);}catch(e){store.log('erro',`Sorteio ${g.id.slice(0,8)}: ${e.message}`);}}
    if(s.tickets.autoCloseHours)for(const t of store.all("SELECT * FROM tickets WHERE status='open' AND updated<?",new Date(Date.now()-s.tickets.autoCloseHours*3600000).toISOString()))try{await closeTicket(t.id,'inatividade');}catch(e){store.log('erro',`Ticket ${t.id.slice(0,8)}: ${e.message}`);}
  }catch(e){store.log('erro',e.message);}finally{busy=false;}}
  client.on(Events.InteractionCreate,async i=>{
    if(i.guildId!==env.DISCORD_GUILD_ID||(!i.isChatInputCommand()&&!i.isButton()&&!i.isStringSelectMenu()&&!i.isModalSubmit()))return;
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
        await i.reply({content:e instanceof AppError?e.message:'Não foi possível abrir o editor de nome.',flags:MessageFlags.Ephemeral}).catch(()=>{});
      }
      return;
    }
    try{
      await i.deferReply({flags:MessageFlags.Ephemeral});
      const action=i.commandName||i.customId;
      if(action==='ajuda'){await i.editReply('**Studio K**\n/loja · catálogo\n/pedido · consultar compra e entrega\n/ticket · atendimento\n/verificar · liberar acesso\n/notificacoes · autorizar ou desativar mensagens privadas');return;}
      if(action==='notificacoes'){
        const exists=store.one('SELECT * FROM optins WHERE user_id=?',i.user.id);if(exists)store.run('DELETE FROM optins WHERE user_id=?',i.user.id);else store.run('INSERT INTO optins VALUES(?,?)',i.user.id,store.now());await i.editReply(exists?'Mensagens opcionais desativadas.':'Mensagens opcionais ativadas. Use este comando novamente para desativar.');return;
      }
      if(action==='loja'){const products=store.products().filter(p=>p.active);await i.editReply(products.length?{content:'**Catálogo Studio K**\nSelecione um produto para comprar.',components:[row({type:3,custom_id:'store-buy',placeholder:'Escolha um produto',options:products.slice(0,25).map(p=>({label:p.name.slice(0,100),description:`${money(p.priceCents)} · ${p.type==='service'?'Serviço':`${p.stock} em estoque`}`,value:p.id}))})]}:'Ainda não há produtos disponíveis.');return;}
      if(action==='ticket'||action==='ticket-category'){const category=action==='ticket-category'?store.settings().tickets.categories[Number(i.values[0])]:store.settings().tickets.categories[0];if(!category)throw new AppError('Categoria indisponível.');const t=await openTicket(i.user.id,category);await i.editReply(`Seu atendimento: <#${t.channel_id}>`);return;}
      if(action.startsWith('claim:')){if(!await isStaff(i))throw new AppError('Somente a equipe pode assumir tickets.',403);const id=action.split(':')[1],changed=store.run("UPDATE tickets SET claimed_by=?,updated=? WHERE id=? AND status='open' AND claimed_by IS NULL",i.user.id,store.now(),id);if(changed.changes){const t=store.one('SELECT * FROM tickets WHERE id=?',id),c=await channel(t.channel_id),style=store.settings().messageStyles.ticketClaim;const claimPayload=stylePayload(style,{staff:`<@${i.user.id}>`,user:`<@${t.user_id}>`,ticket:c.name,category:t.category},env.DISCORD_GUILD_ID);await c.send({...claimPayload,allowedMentions:mentionPolicy(claimPayload,[i.user.id,t.user_id])});await audit('ticket',`Ticket ${c.name} assumido.`,i.user.id);}await i.editReply(changed.changes?'Atendimento atribuído a você.':'Esse atendimento já está atribuído ou encerrado.');return;}
      if(action.startsWith('close:')){if(!await isStaff(i))throw new AppError('Somente a equipe pode finalizar tickets.',403);const t=store.one('SELECT * FROM tickets WHERE id=?',action.split(':')[1]);if(!t)throw new AppError('Ticket não encontrado.',404);await closeTicket(t.id,i.user.id);await i.editReply('Atendimento encerrado.');return;}
      if(action.startsWith('call:')){
        if(!await isStaff(i))throw new AppError('Somente a equipe pode chamar o cliente.',403);
        const id=action.split(':')[1],t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);
        const c=await channel(t.channel_id),settings=store.settings(),style=settings.messageStyles.ticketCall;
        const variables={user:`<@${t.user_id}>`,ticket:c.name,category:t.category,channel:`<#${c.id}>`,server:c.guild.name};
        const callPayload=stylePayload(style,variables,env.DISCORD_GUILD_ID);await c.send({...callPayload,allowedMentions:mentionPolicy(callPayload,[t.user_id])});
        let dmSent=false;
        if(settings.tickets.callDm){
          try{const dmPayload=stylePayload(settings.messageStyles.ticketCallDm,variables,env.DISCORD_GUILD_ID);await(await member(t.user_id)).send({...dmPayload,allowedMentions:mentionPolicy(dmPayload)});dmSent=true;}
          catch(e){store.log('aviso',`Cliente chamado em ${c.name}, mas a DM falhou: ${String(e.message).slice(0,300)}`);}
        }
        store.run('UPDATE tickets SET updated=? WHERE id=?',store.now(),id);await audit('ticket',`Cliente chamado no ticket ${c.name}${dmSent?' e por DM':''}.`,i.user.id);await i.editReply(dmSent?'Cliente chamado no ticket e no privado.':'Cliente chamado no ticket. A DM não pôde ser entregue.');return;
      }
      if(action.startsWith('rename-submit:')){
        if(!await isStaff(i))throw new AppError('Somente a equipe pode renomear tickets.',403);
        const id=action.split(':')[1],t=store.one("SELECT * FROM tickets WHERE id=? AND status='open'",id);if(!t)throw new AppError('Ticket aberto não encontrado.',404);
        const requested=i.fields.getTextInputValue('ticket-name'),newName=channelSlug(requested);if(!newName)throw new AppError('Digite um nome válido.');
        const c=await channel(t.channel_id),oldName=c.name;await c.setName(newName,`Studio K: renomeado por ${i.user.id}`);
        store.run('UPDATE tickets SET updated=? WHERE id=?',store.now(),id);await audit('ticket',`Ticket ${oldName} renomeado para ${newName}.`,i.user.id);await i.editReply(`Ticket renomeado para **${newName}**.`);return;
      }
      if(action==='verify'||action==='verificar'){const v=store.settings().verification;if(v.oauthEnabled){const url=`${String(env.PUBLIC_URL||'').replace(/\/$/,'')}/api/oauth/discord/start`;await i.editReply({content:'Para liberar o acesso, autorize sua conta pelo Discord.',components:[row(linkButton(v.button,url))]});return;}if(!v.roleId)throw new AppError('A verificação ainda não foi configurada.');if(Date.now()-i.user.createdTimestamp<v.minimumAccountDays*86400000)throw new AppError(`Sua conta precisa ter pelo menos ${v.minimumAccountDays} dias.`);await assignRole(i.user.id,v.roleId);await i.editReply('Verificação concluída. Bem-vindo(a)!');return;}
      if(action.startsWith('buy:')||action==='store-buy'){if(!store.settings().sales.pixKey)throw new AppError('As vendas ainda não foram configuradas.');const order=store.createOrder(action==='store-buy'?i.values[0]:action.split(':')[1],i.user.id);await i.editReply({content:await orderText(order),components:[row(button('Enviar comprovante / falar com equipe','ticket',2))]});return;}
      if(action==='pedido'){const orderId=i.options.getString('id');const order=orderId?store.one('SELECT * FROM orders WHERE id=? AND user_id=?',orderId,i.user.id):store.one('SELECT * FROM orders WHERE user_id=? ORDER BY created DESC LIMIT 1',i.user.id);if(!order)throw new AppError('Pedido não encontrado.');let text=order.status==='pending'?await orderText(order):`Pedido ${order.id}\nSituação: ${{paid:'Aprovado; entrega em processamento',delivered:'Entregue',cancelled:'Cancelado'}[order.status]}`;if(['paid','delivered'].includes(order.status)){const unit=store.one('SELECT secret FROM stock WHERE order_id=?',order.id);if(unit)text+=`\n\nSua entrega: ${store.decrypt(unit.secret)}`;}await i.editReply({content:text.slice(0,2000),allowedMentions:safe});return;}
      if(action.startsWith('giveaway:')){const id=action.split(':')[1],g=store.one('SELECT * FROM giveaways WHERE id=?',id);if(!g||g.status!=='active'||Date.parse(JSON.parse(g.data).endsAt)<=Date.now())throw new AppError('Sorteio encerrado.');const data=JSON.parse(g.data);if(data.requiredRoleId&&!i.member.roles.cache.has(data.requiredRoleId))throw new AppError('Você não possui o cargo necessário.');store.run('INSERT OR IGNORE INTO entries VALUES(?,?)',id,i.user.id);await i.editReply('Participação confirmada. Boa sorte!');return;}
      await i.editReply('Ação indisponível.');
    }catch(e){store.log('erro',e.message,'interação');if(i.deferred||i.replied)await i.editReply({content:e instanceof AppError?e.message:'Não foi possível concluir. Confira as permissões do bot ou procure a equipe.',components:[]}).catch(()=>{});}
  });
  for(const [event,key] of [[Events.GuildMemberAdd,'welcome'],[Events.GuildMemberRemove,'goodbye']])client.on(event,async m=>{
    if(m.guild.id!==env.DISCORD_GUILD_ID)return;try{const s=store.settings(),t=s[key];if(t.enabled&&t.channelId){const variables={user:`<@${m.id}>`,username:m.user.username,server:m.guild.name,count:String(m.guild.memberCount)};const content=t.content.replace(/\{(user|username|server|count)\}/g,(v,k)=>variables[k]);const e=embedPayload(t.embed,variables);const payload={content:content||undefined,embeds:e.title||e.description||e.fields?.length?[e]:[],components:linkRows(t.buttons||[],env.DISCORD_GUILD_ID)};payload.allowedMentions=mentionPolicy(payload,key==='welcome'?[m.id]:[]);await(await channel(t.channelId)).send(payload);}if(s.logs.members)await audit('membro',`${m.user.username} ${key==='welcome'?'entrou':'saiu'} do servidor.`,m.id);}catch(e){store.log('erro',e.message);}
  });
  client.on(Events.MessageCreate,m=>{if(m.guildId===env.DISCORD_GUILD_ID&&!m.author.bot)store.run("UPDATE tickets SET updated=? WHERE channel_id=? AND status='open'",store.now(),m.channelId);});
  const logEvent=(event,setting,text)=>client.on(event,(...args)=>{const object=args.at(-1),guildId=object.guild?.id||object.guildId;if(guildId===env.DISCORD_GUILD_ID&&store.settings().logs[setting])void audit(setting,text(...args)).catch(()=>{});});
  logEvent(Events.MessageDelete,'messages',m=>`Mensagem ${m.id} excluída no canal ${m.channelId}. Autor: ${m.author?.id||'não disponível'}.`);
  logEvent(Events.MessageUpdate,'messages',(a,b)=>`Mensagem ${b.id} editada no canal ${b.channelId}.`);
  logEvent(Events.GuildBanAdd,'moderation',b=>`Membro ${b.user.id} banido.`);logEvent(Events.GuildBanRemove,'moderation',b=>`Banimento de ${b.user.id} removido.`);
  for(const [event,label] of [[Events.ChannelCreate,'criado'],[Events.ChannelDelete,'excluído'],[Events.ChannelUpdate,'alterado']])logEvent(event,'channels',(...a)=>`Canal ${a.at(-1).name} ${label}.`);
  for(const [event,label] of [[Events.GuildRoleCreate,'criado'],[Events.GuildRoleDelete,'excluído'],[Events.GuildRoleUpdate,'alterado']])logEvent(event,'roles',(...a)=>`Cargo ${a.at(-1).name} ${label}.`);
  client.on(Events.Error,e=>{error=e.message;store.log('erro','Falha na conexão com o Discord.');});
  client.once(Events.ClientReady,async()=>{console.log(`Discord conectado como ${client.user?.tag||client.user?.username||'Studio K'}.`);
    try{const guild=requireGuild();const commands=[{name:'ajuda',description:'Conheça o Studio K'},{name:'loja',description:'Veja produtos e serviços disponíveis'},{name:'pedido',description:'Consulte um pedido e recupere sua entrega',options:[{name:'id',description:'Código completo do pedido; deixe vazio para o mais recente',type:3,required:false}]},{name:'ticket',description:'Abra um atendimento privado'},{name:'verificar',description:'Aceite as regras e receba acesso'},{name:'notificacoes',description:'Ative ou desative mensagens privadas opcionais'}];await new REST({version:'10'}).setToken(env.DISCORD_TOKEN).put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID||client.user.id,guild.id),{body:commands});const s=store.settings().brand;client.user.setPresence({status:s.status,activities:s.activity?[{name:s.activity,type:ActivityType[s.activityType]}]:[]});store.log('conexão',`Conectado ao servidor ${guild.name}.`);error='';await tick();}catch(e){error=e.message;store.log('erro',e.message);}
  });
  const timer=setInterval(()=>void tick(),30000);timer.unref();
  return {status,client,channel,member,assignRole,verifyOAuthUser,sendMessage,openTicket,closeTicket,publishPanel,publishProduct,createGiveaway,createEvent,applyBrand,makeBackup,tick,
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
    async stop(){clearInterval(timer);await client.destroy();}
  };
}
