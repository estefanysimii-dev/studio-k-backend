import { z } from 'zod';
export const id = z.string().regex(/^\d{17,20}$/, 'Use um ID válido do Discord.');
const optionalId = z.union([id, z.literal('')]).default('');
const https = z.union([z.string().url().startsWith('https://').max(2000), z.literal('')]).default('');
export const embedSchema = z.object({
  title: z.string().max(256).default(''), description: z.string().max(4096).default(''),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#995cff'), url: https,
  author: z.string().max(256).default(''), authorIcon: https,
  footer: z.string().max(2048).default(''), thumbnail: https, image: https,
  timestamp: z.boolean().default(false),
  fields: z.array(z.object({ name: z.string().min(1).max(256), value: z.string().min(1).max(1024), inline: z.boolean().default(false) })).max(25).default([])
}).refine(e => e.title.length + e.description.length + e.author.length + e.footer.length + e.fields.reduce((n,f) => n + f.name.length + f.value.length, 0) <= 6000, 'O embed ultrapassa 6.000 caracteres.');
const linkButtonSchema = z.object({
  label: z.string().min(1).max(80),
  type: z.enum(['url','channel']).default('url'),
  url: https,
  channelId: optionalId,
  emoji: z.string().max(100).default('')
}).superRefine((b,ctx)=>{
  if(b.type==='url'&&!b.url)ctx.addIssue({code:'custom',message:'Informe a URL do botão.'});
  if(b.type==='channel'&&!b.channelId)ctx.addIssue({code:'custom',message:'Escolha o canal do botão.'});
});
const linkButtonsSchema = z.array(linkButtonSchema).max(5).default([]);

const template = z.object({ enabled: z.boolean().default(false), channelId: optionalId, content: z.string().max(1800).default(''), embed: embedSchema.prefault({}), buttons: linkButtonsSchema });
const messageStyle = (content='', embed={}) => z.object({
  content: z.string().max(2000).default(content),
  embed: embedSchema.prefault(embed),
  buttons: linkButtonsSchema
}).prefault({});
const messageStylesSchema = z.object({
  ticketPanel: messageStyle('', { title:'Como podemos ajudar?', description:'Abra um atendimento privado com nossa equipe.', color:'#995cff' }),
  ticketOpen: messageStyle('{user}', { title:'{category} · Studio K', description:'Descreva o que você precisa. Nossa equipe continuará o atendimento por aqui.', color:'#995cff' }),
  ticketStaffPanel: messageStyle('', { title:'Painel da equipe', description:'Controles restritos ao cargo de atendimento e cargos superiores.', color:'#995cff' }),
  ticketClaim: messageStyle('', { title:'Atendimento assumido', description:'Seu atendimento agora está com {staff}.', color:'#995cff' }),
  ticketCall: messageStyle('{user}', { title:'A equipe chamou você', description:'Há uma nova atualização no seu atendimento. Retorne ao ticket quando puder.', color:'#995cff' }),
  ticketClose: messageStyle('', { title:'Atendimento encerrado', description:'O histórico foi salvo no painel.', color:'#995cff' }),
  verificationPanel: messageStyle('', { title:'Verifique sua conta', description:'Leia as regras. Ao confirmar, você receberá acesso à comunidade.', color:'#995cff' }),
  verificationDm: messageStyle('', { title:'Verificação concluída', description:'Sua conta foi autorizada com sucesso em **{server}**. Você recebeu o cargo de acesso e já pode entrar nas áreas liberadas.', color:'#995cff' }),
  ticketCallDm: messageStyle('', { title:'A equipe chamou você', description:'Há uma atualização no seu atendimento **{ticket}** em {server}. Volte ao canal {channel} quando puder.', color:'#995cff' }),
  product: messageStyle('', { title:'{product}', description:'{description}', color:'#995cff', fields:[{name:'Valor',value:'{price}',inline:true},{name:'Disponibilidade',value:'{availability}',inline:true}] }),
  giveaway: messageStyle('', { title:'🎁 {title}', description:'{description}\n\nEncerra {ends}.\n{winners} vencedor(es).{roleLine}', color:'#995cff' }),
  giveawayResult: messageStyle('', { title:'Sorteio encerrado · {title}', description:'{result}', color:'#995cff' }),
  salesLive: messageStyle('', { title:'📊 Vendas da semana', description:'**{sales}** venda(s) confirmada(s)\n**{revenue}** em receita\n\nPeríodo: {periodStart} → {periodEnd}', color:'#995cff', footer:'Atualizado {updated}', timestamp:true }),
  communityLive: messageStyle('', { title:'👥 Comunidade em tempo real', description:'**{members}** membros atuais\n**+{newToday}** entraram hoje\n**+{newWeek}** entraram nesta semana\n**{growthWeek}** crescimento líquido semanal\n**{growthMonth}** crescimento líquido mensal\n\n✅ **{verifiedTotal}** membros verificados\n🛡️ **{verifiedWeek}** verificações nesta semana\n🔊 **{voiceNow}** em call agora\n🚀 **{boosts}** boosts ativos\n🎫 **{openTickets}** tickets abertos\n💬 **{messagesToday}** mensagens hoje\n👤 **{activeMembersWeek}** membros ativos em 7 dias\n\n**{leftWeek}** saída(s) nesta semana', color:'#995cff', footer:'Atualizado {updated}', timestamp:true }),
  giveawaysLive: messageStyle('', { title:'🎁 Sorteios ativos', description:'**{activeGiveaways}** sorteio(s) ativo(s)\n**{eligible}** participante(s) elegível(is)\n\n{giveawayList}', color:'#995cff', footer:'Atualizado {updated}', timestamp:true }),
  operationsLive: messageStyle('', { title:'🟢 Status operacional · Studio K', description:'Bot: **{botStatus}**\nLoja: **{storeStatus}**\nTickets: **{ticketsStatus}**\nTickets abertos: **{openTickets}**\nPedidos pendentes: **{pendingOrders}**', color:'#995cff', footer:'Atualizado {updated}', timestamp:true }),
  inviteRankingLive: messageStyle('', { title:'🏆 Ranking de convites · {month}', description:'{ranking}', color:'#995cff', footer:'Somente convites válidos rastreados pelo Studio K · Atualizado {updated}', timestamp:true }),
  logs: messageStyle('', { title:'Studio K · {type}', description:'{detail}', color:'#995cff', footer:'Responsável: {actor}', timestamp:true }),
  orderDelivery: messageStyle('', { title:'Compra aprovada · {product}', description:'Pedido {order}\n\n{delivery}\n\n{instructions}', color:'#995cff' }),
  feedback: messageStyle('', { title:'💜 Novo feedback · {source}', description:'{stars} **{rating}/5**\n\n{comment}', color:'#995cff', fields:[{name:'Cliente',value:'{user}',inline:true},{name:'Referência',value:'{reference}',inline:true}], footer:'Studio K · Feedback verificado', timestamp:true })
}).prefault({});
export const settingsSchema = z.object({
  messageStyles: messageStylesSchema,
  brand: z.object({ name: z.string().min(2).max(32).default('Studio K'), status: z.enum(['online','idle','dnd','invisible']).default('online'), activity: z.string().max(128).default('Sua loja, sua comunidade.'), activityType: z.enum(['Playing','Watching','Listening','Competing']).default('Watching'), description: z.string().max(400).default(''), avatar: z.string().max(4000000).regex(/^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+)?$/).default(''), banner: z.string().max(4000000).regex(/^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+)?$/).default('') }).prefault({}),
  welcome: template.prefault({ content: 'Bem-vindo(a), {user}! Você está no {server}.', embed: { title: 'Seu lugar é aqui.', description: 'Confira as regras e conheça nossa loja.' } }),
  goodbye: template.prefault({ content: '{username} saiu do servidor.' }),
  tickets: z.object({ categoryId: optionalId, staffRoleId: optionalId, staffRoleIds: z.array(id).max(25).default([]), logChannelId: optionalId, title: z.string().min(1).max(256).default('Como podemos ajudar?'), description: z.string().max(2000).default('Abra um atendimento privado com nossa equipe.'), button: z.string().min(1).max(80).default('Abrir ticket'), categories: z.array(z.string().min(1).max(80)).min(1).max(10).default(['Suporte','Compras','Orçamento']), color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#995cff'), autoCloseHours: z.number().int().min(0).max(720).default(0), callDm: z.boolean().default(true) }).prefault({}),
  verification: z.object({ roleId: optionalId, roleIds: z.array(id).max(25).default([]), redirectChannelId: optionalId, title: z.string().min(1).max(256).default('Verifique sua conta'), description: z.string().max(2000).default('Leia as regras. Ao confirmar, você receberá acesso à comunidade.'), button: z.string().min(1).max(80).default('Liberar meu acesso'), minimumAccountDays: z.number().int().min(0).max(365).default(7), oauthEnabled: z.boolean().default(false), sendDm: z.boolean().default(true) }).prefault({}),
  roleGroups: z.object({
    staff:z.array(id).max(50).default([]),
    highStaff:z.array(id).max(50).default([]),
    partners:z.array(id).max(50).default([]),
    customers:z.array(id).max(50).default([]),
    decorative:z.array(id).max(100).default([])
  }).prefault({}),
  sales: z.object({ pixKey: z.string().max(200).default(''), recipient: z.string().max(100).default(''), instructions: z.string().max(1200).default('Envie o comprovante no ticket e aguarde a conferência da equipe.'), orderExpiryMinutes: z.number().int().min(10).max(10080).default(60), lowStockThreshold: z.number().int().min(0).max(10000).default(3) }).prefault({}),
  salesLive: z.object({ enabled:z.boolean().default(false), channelId:optionalId }).prefault({}),
  communityLive: z.object({ enabled:z.boolean().default(false), channelId:optionalId }).prefault({}),
  giveawaysLive: z.object({ enabled:z.boolean().default(false), channelId:optionalId }).prefault({}),
  operationsLive: z.object({ enabled:z.boolean().default(false), channelId:optionalId, storeOpen:z.boolean().default(true), ticketsOpen:z.boolean().default(true) }).prefault({}),
  inviteRankingLive: z.object({ enabled:z.boolean().default(false), channelId:optionalId, top:z.number().int().min(3).max(20).default(10) }).prefault({}),
  feedback: z.object({ enabled:z.boolean().default(true), channelId:optionalId, tickets:z.boolean().default(true), orders:z.boolean().default(true) }).prefault({}),
  voicePresence: z.object({ enabled:z.boolean().default(false), channelId:optionalId }).prefault({}),
  translator: z.object({ enabled:z.boolean().default(false) }).prefault({}),
  logs: z.object({ channelId: optionalId, tickets: z.boolean().default(true), ticketsChannelId: optionalId, members: z.boolean().default(true), membersChannelId: optionalId, messages: z.boolean().default(true), messagesChannelId: optionalId, moderation: z.boolean().default(true), moderationChannelId: optionalId, channels: z.boolean().default(true), channelsChannelId: optionalId, roles: z.boolean().default(true), rolesChannelId: optionalId, verification: z.boolean().default(true), verificationChannelId: optionalId, sales: z.boolean().default(true), salesChannelId: optionalId, system: z.boolean().default(true), systemChannelId: optionalId, feedback: z.boolean().default(true), feedbackChannelId: optionalId }).prefault({}),
  backups: z.object({ enabled: z.boolean().default(true), intervalHours: z.number().int().min(1).max(720).default(24), retain: z.number().int().min(2).max(100).default(14) }).prefault({})
});
export const defaults = settingsSchema.parse({});
export const productSchema = z.object({ name: z.string().min(2).max(100), description: z.string().max(2000).default(''), priceCents: z.number().int().min(1).max(100000000), type: z.enum(['digital','service']), roleId: optionalId, active: z.boolean().default(true), image: https, delivery: z.string().max(1500).default(''), category: z.string().max(80).default('Geral') });
const messageObject = z.object({ target: z.enum(['channel','dm']), targetId: id, content: z.string().max(2000).default(''), embed: embedSchema.optional(), buttons: linkButtonsSchema, webhookName: z.string().max(80).default(''), webhookAvatar: https });
export const templateSchema = messageObject.extend({ targetId: optionalId });
export const messageSchema = messageObject.refine(m => m.content || (m.embed && (m.embed.title || m.embed.description || m.embed.fields.length)), 'Escreva uma mensagem ou um embed.');
export const giveawayRequirementSchema = z.discriminatedUnion('type',[
  z.object({id:z.string().max(80).default(''),type:z.literal('verified')}),
  z.object({id:z.string().max(80).default(''),type:z.literal('role'),roleId:id}),
  z.object({id:z.string().max(80).default(''),type:z.literal('accountAge'),days:z.number().int().min(1).max(3650)}),
  z.object({id:z.string().max(80).default(''),type:z.literal('serverAge'),days:z.number().int().min(1).max(3650)}),
  z.object({id:z.string().max(80).default(''),type:z.literal('invites'),count:z.number().int().min(1).max(1000),minStayHours:z.number().int().min(0).max(8760).default(0),minAccountDays:z.number().int().min(0).max(3650).default(0),requireVerified:z.boolean().default(true)}),
  z.object({id:z.string().max(80).default(''),type:z.literal('youtubeSubscription'),channel:z.string().min(2).max(500)}),
  z.object({id:z.string().max(80).default(''),type:z.literal('youtubeLike'),video:z.string().min(2).max(500)}),
  z.object({id:z.string().max(80).default(''),type:z.literal('reaction'),channelId:id,messageId:id,emoji:z.string().min(1).max(100)}),
  z.object({id:z.string().max(80).default(''),type:z.literal('voiceMinutes'),minutes:z.number().int().min(1).max(100000)}),
  z.object({id:z.string().max(80).default(''),type:z.literal('manual'),label:z.string().min(2).max(200)})
]);
export const giveawaySchema = z.object({
  title:z.string().min(2).max(200),
  description:z.string().max(2000).default(''),
  channelId:id,
  endsAt:z.string().datetime(),
  winners:z.number().int().min(1).max(20),
  requiredRoleId:optionalId,
  requirements:z.array(giveawayRequirementSchema).max(20).default([])
}).refine(g=>Date.parse(g.endsAt)>Date.now()+60000,'O sorteio precisa terminar daqui a mais de um minuto.');
export const eventSchema = z.object({ name: z.string().min(2).max(100), description: z.string().max(1000).default(''), startsAt: z.string().datetime(), endsAt: z.string().datetime(), location: z.string().min(1).max(100) }).refine(e => Date.parse(e.startsAt) > Date.now() && Date.parse(e.endsAt) > Date.parse(e.startsAt), 'Confira início e fim do evento.');
