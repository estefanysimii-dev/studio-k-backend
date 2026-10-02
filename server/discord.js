import { Client, GatewayIntentBits, Partials, Events, ChannelType, PermissionFlagsBits, ActivityType, REST, Routes, MessageFlags, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } from 'discord.js';
import { randomUUID, createHash } from 'node:crypto';
import { AppError } from './store.js';
export function embedPayload(e,variables={}) {
  const expand=s=>String(s||'').replace(/\{(user|username|server|count)\}/g,(m,k)=>variables[k]??m);
  const result={color:parseInt(e.color.slice(1),16)};
  for(const field of ['title','description','url'])if(e[field])result[field]=expand(e[field]);
  if(e.author)result.author={name:expand(e.author),...(e.authorIcon?{icon_url:e.authorIcon}:{})};
  if(e.footer)result.footer={text:expand(e.footer)};
  if(e.image)result.image={url:e.image};if(e.thumbnail)result.thumbnail={url:e.thumbnail};
  if(e.timestamp)result.timestamp=new Date().toISOString();
  if(e.fields?.length)result.fields=e.fields.map(f=>({...f,name:expand(f.name),value:expand(f.value)}));
  return result;
}
const button=(label,custom_id,style=1)=>({type:2,label,custom_id,style});
const row=(...components)=>({type:1,components});
const money=n=>(n/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const safe={parse:[]};
export function createBot(store,env=process.env){
  const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,GatewayIntentBits.GuildModeration],partials:[Partials.Message,Partials.Channel]});
  let error='',busy=false,backupBusy=false;
  const requireGuild=()=>{if(!client.isReady())throw new AppError('Conecte o bot ao Discord antes desta ação.',503);const guild=client.guilds.cache.get(env.DISCORD_GUILD_ID);if(!guild)throw new AppError('O bot não está no servidor configurado.',503);return guild;};
  const channel=async channelId=>{const c=await requireGuild().channels.fetch(channelId);if(!c?.isTextBased()||!('send' in c))throw new AppError('Escolha um canal de texto do servidor.');return c;};
  const member=async userId=>requireGuild().members.fetch(userId);
  const status=()=>({connected:client.isReady()&&client.guilds.cache.has(env.DISCORD_GUILD_ID),configured:!!env.DISCORD_TOKEN,name:client.user?.username||'Studio K',guild:client.guilds.cache.get(env.DISCORD_GUILD_ID)?.name||null,members:client.guilds.cache.get(env.DISCORD_GUILD_ID)?.memberCount||0,latency:client.ws.ping,error});
  async function audit(type,detail,actor='Discord'){
    store.log(type,detail,actor);const cid=store.settings().logs.channelId;
    if(cid&&client.isReady())try{await(await channel(cid)).send({embeds:[{title:`Studio K · ${type}`,description:String(detail).slice(0,4000),color:0x995cff,timestamp:new Date().toISOString(),footer:{text:`Responsável: ${actor}`}}],allowedMentions:safe});}catch{store.log('erro','Não foi possível publicar no canal de logs.');}
  }
  async function assignRole(userId,roleId){
    if(!roleId)return;const guild=requireGuild(),role=await guild.roles.fetch(roleId),me=await guild.members.fetchMe();
    if(!role||role.managed||role.id===guild.id||role.permissions.has(PermissionFlagsBits.Administrator)||role.position>=me.roles.highest.position)throw new AppError('O cargo precisa existir, não pode ser administrativo e deve ficar abaixo do cargo do bot.');
    await(await member(userId)).roles.add(role,'Studio K: cargo configurado');
  }
  async function sendMessage(data){
    const payload={content:data.content||undefined,embeds:data.embed?[embedPayload(data.embed)]:[],allowedMentions:safe};
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
  const isStaff=i=>i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)||i.member?.roles?.cache.has(store.settings().tickets.staffRoleId);
  async function openTicket(userId,category){
    const old=store.one("SELECT * FROM tickets WHERE user_id=? AND status='open'",userId);if(old?.channel_id)return old;
    if(old)throw new AppError('Seu ticket está sendo criado. Tente novamente em instantes.');
    const guild=requireGuild(),s=store.settings().tickets;
    if(!s.staffRoleId)throw new AppError('Configure o cargo da equipe antes de abrir tickets.');
    const staffRole=await guild.roles.fetch(s.staffRoleId);if(!staffRole||staffRole.id===guild.id)throw new AppError('Configure um cargo válido e exclusivo para a equipe.');
    const id=randomUUID();store.run('INSERT INTO tickets(id,user_id,category,status,created,updated) VALUES(?,?,?,?,?,?)',id,userId,category,'open',store.now(),store.now());
    let c;
    try{
      c=await guild.channels.create({name:`ticket-${id.slice(0,8)}`,type:ChannelType.GuildText,parent:s.categoryId||undefined,permissionOverwrites:[{id:guild.id,deny:[PermissionFlagsBits.ViewChannel]},{id:userId,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles]},{id:client.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageChannels]},{id:s.staffRoleId,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]}]});
      store.run('UPDATE tickets SET channel_id=? WHERE id=?',c.id,id);
      await c.send({content:`<@${userId}>`,embeds:[{title:`${category} · Studio K`,description:'Descreva o que você precisa. Nossa equipe continuará o atendimento por aqui.',color:parseInt(s.color.slice(1),16)}],components:[row(button('Assumir atendimento',`claim:${id}`,2),button('Encerrar ticket',`close:${id}`,4))],allowedMentions:{users:[userId]}});
      await audit('ticket',`Ticket ${id.slice(0,8)} aberto: ${category}`,userId);return store.one('SELECT * FROM tickets WHERE id=?',id);
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
    const transcript=messages.reverse().map(m=>`[${m.createdAt.toISOString()}] ${m.author?.tag||'desconhecido'} (${m.author?.id||''}): ${m.content||''}${m.attachments.size?'\n'+[...m.attachments.values()].map(a=>a.url).join('\n'):''}${m.embeds.length?'\n'+m.embeds.map(e=>[e.title,e.description].filter(Boolean).join('\n')).join('\n'):''}`).join('\n\n');
    // Persist before removing access, so retrying a failed close never loses the transcript.
    store.run('UPDATE tickets SET transcript=? WHERE id=?',transcript,id);
    await c.permissionOverwrites.edit(ticket.user_id,{SendMessages:false});
    await c.send({content:'Atendimento encerrado. O histórico foi salvo no painel.',components:[],allowedMentions:safe});
    store.run("UPDATE tickets SET status='closed',updated=? WHERE id=?",store.now(),id);await audit('ticket',`Ticket ${id.slice(0,8)} encerrado.`,actor);
  }
  async function publishPanel(kind,channelId){
    const s=store.settings(),c=await channel(channelId);let payload;
    if(kind==='tickets')payload={embeds:[{title:s.tickets.title,description:s.tickets.description,color:parseInt(s.tickets.color.slice(1),16)}],components:[row({type:3,custom_id:'ticket-category',placeholder:s.tickets.button.slice(0,150),options:s.tickets.categories.map((name,i)=>({label:name,value:String(i)}))})]};
    else payload={embeds:[{title:s.verification.title,description:s.verification.description,color:0x995cff}],components:[row(button(s.verification.button,'verify'))]};
    const message=await c.send({...payload,allowedMentions:safe});await audit('painel',`Painel de ${kind} publicado.`, 'painel');return{id:message.id};
  }
  async function publishProduct(productId,channelId){const p=store.products().find(p=>p.id===productId);if(!p)throw new AppError('Produto não encontrado.',404);const m=await(await channel(channelId)).send({embeds:[{title:p.name,description:p.description||'Peça pelo botão abaixo.',color:0x995cff,fields:[{name:'Valor',value:money(p.priceCents),inline:true},{name:'Disponibilidade',value:p.type==='service'?'Sob demanda':`${p.stock} unidade(s)`,inline:true}],...(p.image?{image:{url:p.image}}:{})}],components:[row(button('Comprar com Pix',`buy:${p.id}`))],allowedMentions:safe});return{id:m.id};}
  async function orderText(order){const s=store.settings().sales,p=JSON.parse(order.product);return`**Pedido ${order.id}**\n${p.name} · **${money(order.price)}**\n\nChave Pix: **${s.pixKey}**\nRecebedor: ${s.recipient}\n${s.instructions}\n\nValidade: <t:${Math.floor(Date.parse(order.expires)/1000)}:R>. A entrega depende da conferência manual do pagamento.\nConsulte novamente com /pedido.`;}
  async function deliverOrder(order){
    const p=JSON.parse(order.product);
    try{
      if(!order.role_done){await assignRole(order.user_id,p.roleId);store.run('UPDATE orders SET role_done=1 WHERE id=?',order.id);}
      if(!order.delivery_done){
        let delivery;
        if(p.type==='digital'){const unit=store.one('SELECT secret FROM stock WHERE order_id=?',order.id);if(!unit)throw new Error('Estoque reservado não encontrado.');delivery=store.decrypt(unit.secret);}
        else{const ticket=await openTicket(order.user_id,`Serviço: ${p.name}`);delivery=`Seu atendimento: <#${ticket.channel_id}>`;}
        const user=await member(order.user_id);
        await user.send({content:`**Compra aprovada · ${p.name}**\nPedido ${order.id}\n\n${delivery}\n\n${p.delivery}`.slice(0,2000),allowedMentions:safe,nonce:createHash('sha256').update(order.id).digest('hex').slice(0,24),enforceNonce:true});
        store.run('UPDATE orders SET delivery_done=1 WHERE id=?',order.id);
      }
      store.run("UPDATE orders SET status='delivered',error=NULL WHERE id=?",order.id);await audit('entrega',`Pedido ${order.id.slice(0,8)} entregue.`);
    }catch(e){store.run('UPDATE orders SET error=? WHERE id=?',String(e.message).slice(0,500),order.id);}
  }
  async function createGiveaway(data){
    const c=await channel(data.channelId),id=randomUUID();store.run('INSERT INTO giveaways(id,data,status,created) VALUES(?,?,?,?)',id,JSON.stringify(data),'draft',store.now());
    const message=await c.send({embeds:[{title:`🎁 ${data.title}`,description:`${data.description}\n\nEncerra <t:${Math.floor(Date.parse(data.endsAt)/1000)}:R>.\n${data.winners} vencedor(es).${data.requiredRoleId?`\nCargo necessário: <@&${data.requiredRoleId}>`:''}`,color:0x995cff}],components:[row(button('Participar do sorteio',`giveaway:${id}`))],allowedMentions:safe});
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
    const c=await channel(data.channelId);await c.messages.edit(g.message_id,{embeds:[{title:`Sorteio encerrado · ${data.title}`,description:winners.length?`Vencedor(es): ${winners.map(id=>`<@${id}>`).join(', ')}`:'Não houve participantes elegíveis.',color:0x995cff}],components:[],allowedMentions:safe});
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
    if(i.guildId!==env.DISCORD_GUILD_ID||(!i.isChatInputCommand()&&!i.isButton()&&!i.isStringSelectMenu()))return;
    try{
      await i.deferReply({flags:MessageFlags.Ephemeral});
      const action=i.commandName||i.customId;
      if(action==='ajuda'){await i.editReply('**Studio K**\n/loja · catálogo\n/pedido · consultar compra e entrega\n/ticket · atendimento\n/verificar · liberar acesso\n/notificacoes · autorizar ou desativar mensagens privadas');return;}
      if(action==='notificacoes'){
        const exists=store.one('SELECT * FROM optins WHERE user_id=?',i.user.id);if(exists)store.run('DELETE FROM optins WHERE user_id=?',i.user.id);else store.run('INSERT INTO optins VALUES(?,?)',i.user.id,store.now());await i.editReply(exists?'Mensagens opcionais desativadas.':'Mensagens opcionais ativadas. Use este comando novamente para desativar.');return;
      }
      if(action==='loja'){const products=store.products().filter(p=>p.active);await i.editReply(products.length?{content:'**Catálogo Studio K**\nSelecione um produto para comprar.',components:[row({type:3,custom_id:'store-buy',placeholder:'Escolha um produto',options:products.slice(0,25).map(p=>({label:p.name.slice(0,100),description:`${money(p.priceCents)} · ${p.type==='service'?'Serviço':`${p.stock} em estoque`}`,value:p.id}))})]}:'Ainda não há produtos disponíveis.');return;}
      if(action==='ticket'||action==='ticket-category'){const category=action==='ticket-category'?store.settings().tickets.categories[Number(i.values[0])]:store.settings().tickets.categories[0];if(!category)throw new AppError('Categoria indisponível.');const t=await openTicket(i.user.id,category);await i.editReply(`Seu atendimento: <#${t.channel_id}>`);return;}
      if(action.startsWith('claim:')){if(!isStaff(i))throw new AppError('Somente a equipe pode assumir tickets.',403);const changed=store.run("UPDATE tickets SET claimed_by=?,updated=? WHERE id=? AND status='open' AND claimed_by IS NULL",i.user.id,store.now(),action.split(':')[1]);await i.editReply(changed.changes?'Atendimento atribuído a você.':'Esse atendimento já está atribuído ou encerrado.');return;}
      if(action.startsWith('close:')){const t=store.one('SELECT * FROM tickets WHERE id=?',action.split(':')[1]);if(!t||(!isStaff(i)&&t.user_id!==i.user.id))throw new AppError('Você não pode encerrar este ticket.',403);await closeTicket(t.id,i.user.id);await i.editReply('Atendimento encerrado.');return;}
      if(action==='verify'||action==='verificar'){const s=store.settings().verification;if(!s.roleId)throw new AppError('A verificação ainda não foi configurada.');if(Date.now()-i.user.createdTimestamp<s.minimumAccountDays*86400000)throw new AppError(`Sua conta precisa ter pelo menos ${s.minimumAccountDays} dias.`);await assignRole(i.user.id,s.roleId);await i.editReply('Verificação concluída. Bem-vindo(a)!');return;}
      if(action.startsWith('buy:')||action==='store-buy'){if(!store.settings().sales.pixKey)throw new AppError('As vendas ainda não foram configuradas.');const order=store.createOrder(action==='store-buy'?i.values[0]:action.split(':')[1],i.user.id);await i.editReply({content:await orderText(order),components:[row(button('Enviar comprovante / falar com equipe','ticket',2))]});return;}
      if(action==='pedido'){const orderId=i.options.getString('id');const order=orderId?store.one('SELECT * FROM orders WHERE id=? AND user_id=?',orderId,i.user.id):store.one('SELECT * FROM orders WHERE user_id=? ORDER BY created DESC LIMIT 1',i.user.id);if(!order)throw new AppError('Pedido não encontrado.');let text=order.status==='pending'?await orderText(order):`Pedido ${order.id}\nSituação: ${{paid:'Aprovado; entrega em processamento',delivered:'Entregue',cancelled:'Cancelado'}[order.status]}`;if(['paid','delivered'].includes(order.status)){const unit=store.one('SELECT secret FROM stock WHERE order_id=?',order.id);if(unit)text+=`\n\nSua entrega: ${store.decrypt(unit.secret)}`;}await i.editReply({content:text.slice(0,2000),allowedMentions:safe});return;}
      if(action.startsWith('giveaway:')){const id=action.split(':')[1],g=store.one('SELECT * FROM giveaways WHERE id=?',id);if(!g||g.status!=='active'||Date.parse(JSON.parse(g.data).endsAt)<=Date.now())throw new AppError('Sorteio encerrado.');const data=JSON.parse(g.data);if(data.requiredRoleId&&!i.member.roles.cache.has(data.requiredRoleId))throw new AppError('Você não possui o cargo necessário.');store.run('INSERT OR IGNORE INTO entries VALUES(?,?)',id,i.user.id);await i.editReply('Participação confirmada. Boa sorte!');return;}
      await i.editReply('Ação indisponível.');
    }catch(e){store.log('erro',e.message,'interação');if(i.deferred||i.replied)await i.editReply({content:e instanceof AppError?e.message:'Não foi possível concluir. Confira as permissões do bot ou procure a equipe.',components:[]}).catch(()=>{});}
  });
  for(const [event,key] of [[Events.GuildMemberAdd,'welcome'],[Events.GuildMemberRemove,'goodbye']])client.on(event,async m=>{
    if(m.guild.id!==env.DISCORD_GUILD_ID)return;try{const s=store.settings(),t=s[key];if(t.enabled&&t.channelId){const variables={user:`<@${m.id}>`,username:m.user.username,server:m.guild.name,count:String(m.guild.memberCount)};const content=t.content.replace(/\{(user|username|server|count)\}/g,(v,k)=>variables[k]);const e=embedPayload(t.embed,variables);await(await channel(t.channelId)).send({content:content||undefined,embeds:e.title||e.description||e.fields?.length?[e]:[],allowedMentions:{users:key==='welcome'?[m.id]:[]}});}if(s.logs.members)await audit('membro',`${m.user.username} ${key==='welcome'?'entrou':'saiu'} do servidor.`,m.id);}catch(e){store.log('erro',e.message);}
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
  return {status,client,channel,member,assignRole,sendMessage,openTicket,closeTicket,publishPanel,publishProduct,createGiveaway,createEvent,applyBrand,makeBackup,tick,
    async metadata(){const g=requireGuild();await g.channels.fetch();await g.roles.fetch();return{channels:[...g.channels.cache.values()].filter(Boolean).map(c=>({id:c.id,name:c.name,type:c.type})),roles:[...g.roles.cache.values()].filter(r=>!r.managed&&r.id!==g.id).map(r=>({id:r.id,name:r.name}))};},
    async start(){if(!env.DISCORD_TOKEN)return;if(!env.DISCORD_GUILD_ID){error='Configure DISCORD_GUILD_ID.';return;}try{await client.login(env.DISCORD_TOKEN);}catch(e){error='Não foi possível conectar. Confira token, servidor e intents no Discord Developer Portal.';console.error(`Discord: ${error} ${e?.message||''}`.trim());store.log('erro',error);}},
    async stop(){clearInterval(timer);await client.destroy();}
  };
}
