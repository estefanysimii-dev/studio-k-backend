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
const template = z.object({ enabled: z.boolean().default(false), channelId: optionalId, content: z.string().max(1800).default(''), embed: embedSchema.prefault({}) });
const messageStyle = (content='', embed={}) => z.object({
  content: z.string().max(2000).default(content),
  embed: embedSchema.prefault(embed)
}).prefault({});
const messageStylesSchema = z.object({
  ticketPanel: messageStyle('', { title:'Como podemos ajudar?', description:'Abra um atendimento privado com nossa equipe.', color:'#995cff' }),
  ticketOpen: messageStyle('{user}', { title:'{category} · Studio K', description:'Descreva o que você precisa. Nossa equipe continuará o atendimento por aqui.', color:'#995cff' }),
  ticketStaffPanel: messageStyle('', { title:'Painel da equipe', description:'Controles restritos ao cargo de atendimento e cargos superiores.', color:'#995cff' }),
  ticketCall: messageStyle('{user}', { title:'A equipe chamou você', description:'Há uma nova atualização no seu atendimento. Retorne ao ticket quando puder.', color:'#995cff' }),
  ticketClose: messageStyle('', { title:'Atendimento encerrado', description:'O histórico foi salvo no painel.', color:'#995cff' }),
  verificationPanel: messageStyle('', { title:'Verifique sua conta', description:'Leia as regras. Ao confirmar, você receberá acesso à comunidade.', color:'#995cff' }),
  product: messageStyle('', { title:'{product}', description:'{description}', color:'#995cff', fields:[{name:'Valor',value:'{price}',inline:true},{name:'Disponibilidade',value:'{availability}',inline:true}] }),
  giveaway: messageStyle('', { title:'🎁 {title}', description:'{description}\n\nEncerra {ends}.\n{winners} vencedor(es).{roleLine}', color:'#995cff' }),
  giveawayResult: messageStyle('', { title:'Sorteio encerrado · {title}', description:'{result}', color:'#995cff' }),
  logs: messageStyle('', { title:'Studio K · {type}', description:'{detail}', color:'#995cff', footer:'Responsável: {actor}', timestamp:true }),
  orderDelivery: messageStyle('', { title:'Compra aprovada · {product}', description:'Pedido {order}\n\n{delivery}\n\n{instructions}', color:'#995cff' })
}).prefault({});
export const settingsSchema = z.object({
  messageStyles: messageStylesSchema,
  brand: z.object({ name: z.string().min(2).max(32).default('Studio K'), status: z.enum(['online','idle','dnd','invisible']).default('online'), activity: z.string().max(128).default('Sua loja, sua comunidade.'), activityType: z.enum(['Playing','Watching','Listening','Competing']).default('Watching'), description: z.string().max(400).default(''), avatar: z.string().max(4000000).regex(/^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+)?$/).default(''), banner: z.string().max(4000000).regex(/^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+)?$/).default('') }).prefault({}),
  welcome: template.prefault({ content: 'Bem-vindo(a), {user}! Você está no {server}.', embed: { title: 'Seu lugar é aqui.', description: 'Confira as regras e conheça nossa loja.' } }),
  goodbye: template.prefault({ content: '{username} saiu do servidor.' }),
  tickets: z.object({ categoryId: optionalId, staffRoleId: optionalId, logChannelId: optionalId, title: z.string().min(1).max(256).default('Como podemos ajudar?'), description: z.string().max(2000).default('Abra um atendimento privado com nossa equipe.'), button: z.string().min(1).max(80).default('Abrir ticket'), categories: z.array(z.string().min(1).max(80)).min(1).max(10).default(['Suporte','Compras','Orçamento']), color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#995cff'), autoCloseHours: z.number().int().min(0).max(720).default(0) }).prefault({}),
  verification: z.object({ roleId: optionalId, title: z.string().min(1).max(256).default('Verifique sua conta'), description: z.string().max(2000).default('Leia as regras. Ao confirmar, você receberá acesso à comunidade.'), button: z.string().min(1).max(80).default('Li e concordo'), minimumAccountDays: z.number().int().min(0).max(365).default(7) }).prefault({}),
  sales: z.object({ pixKey: z.string().max(200).default(''), recipient: z.string().max(100).default(''), instructions: z.string().max(1200).default('Envie o comprovante no ticket e aguarde a conferência da equipe.'), orderExpiryMinutes: z.number().int().min(10).max(10080).default(60), lowStockThreshold: z.number().int().min(0).max(10000).default(3) }).prefault({}),
  logs: z.object({ channelId: optionalId, members: z.boolean().default(true), messages: z.boolean().default(true), moderation: z.boolean().default(true), channels: z.boolean().default(true), roles: z.boolean().default(true) }).prefault({}),
  backups: z.object({ enabled: z.boolean().default(true), intervalHours: z.number().int().min(1).max(720).default(24), retain: z.number().int().min(2).max(100).default(14) }).prefault({})
});
export const defaults = settingsSchema.parse({});
export const productSchema = z.object({ name: z.string().min(2).max(100), description: z.string().max(2000).default(''), priceCents: z.number().int().min(1).max(100000000), type: z.enum(['digital','service']), roleId: optionalId, active: z.boolean().default(true), image: https, delivery: z.string().max(1500).default(''), category: z.string().max(80).default('Geral') });
const messageObject = z.object({ target: z.enum(['channel','dm']), targetId: id, content: z.string().max(2000).default(''), embed: embedSchema.optional(), webhookName: z.string().max(80).default(''), webhookAvatar: https });
export const templateSchema = messageObject.extend({ targetId: optionalId });
export const messageSchema = messageObject.refine(m => m.content || (m.embed && (m.embed.title || m.embed.description || m.embed.fields.length)), 'Escreva uma mensagem ou um embed.');
export const giveawaySchema = z.object({ title: z.string().min(2).max(200), description: z.string().max(2000).default(''), channelId: id, endsAt: z.string().datetime(), winners: z.number().int().min(1).max(20), requiredRoleId: optionalId }).refine(g => Date.parse(g.endsAt) > Date.now() + 60000, 'O sorteio precisa terminar daqui a mais de um minuto.');
export const eventSchema = z.object({ name: z.string().min(2).max(100), description: z.string().max(1000).default(''), startsAt: z.string().datetime(), endsAt: z.string().datetime(), location: z.string().min(1).max(100) }).refine(e => Date.parse(e.startsAt) > Date.now() && Date.parse(e.endsAt) > Date.parse(e.startsAt), 'Confira início e fim do evento.');
