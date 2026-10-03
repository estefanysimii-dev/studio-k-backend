import { z } from 'zod';

export const studioRaritySchema=z.enum(['common','rare','epic','legendary']);

export const defaultStudioIdConfig={
  enabled:true,
  xp:{
    base:100,
    discordMember:100,
    purchase:250,
    feedback:75,
    favorite:15
  },
  levelStep:300,
  earlyMemberLimit:250,
  thresholds:{
    collectorPurchases:5,
    profileFramePurchases:3,
    creatorLevel:3,
    levelFive:5,
    insiderLevel:6,
    iconLevel:10
  },
  supporterRolePattern:'supporter|vip|premium|apoiador|cliente',
  features:{
    badges:true,
    achievements:true,
    perks:true
  },
  ranks:[
    {id:'member',label:'Studio Member',icon:'•',rarity:'common',minLevel:1},
    {id:'creator',label:'Studio Creator',icon:'◇',rarity:'rare',minLevel:3},
    {id:'insider',label:'Studio Insider',icon:'◆',rarity:'epic',minLevel:6},
    {id:'icon',label:'Studio Icon',icon:'✦',rarity:'legendary',minLevel:10}
  ],
  discordRankSync:{
    enabled:false,
    roleIds:{member:'',creator:'',insider:'',icon:''}
  }
};

const rankSchema=z.object({
  id:z.string().trim().regex(/^[a-z0-9-]+$/).max(40),
  label:z.string().trim().min(1).max(60),
  icon:z.string().trim().max(12).default('•'),
  rarity:studioRaritySchema.default('common'),
  minLevel:z.number().int().min(1).max(1000)
});

export const studioIdConfigSchema=z.object({
  enabled:z.boolean().default(true),
  xp:z.object({
    base:z.number().int().min(0).max(100000).default(100),
    discordMember:z.number().int().min(0).max(100000).default(100),
    purchase:z.number().int().min(0).max(100000).default(250),
    feedback:z.number().int().min(0).max(100000).default(75),
    favorite:z.number().int().min(0).max(100000).default(15)
  }).default(defaultStudioIdConfig.xp),
  levelStep:z.number().int().min(50).max(100000).default(300),
  earlyMemberLimit:z.number().int().min(0).max(1000000).default(250),
  thresholds:z.object({
    collectorPurchases:z.number().int().min(1).max(10000).default(5),
    profileFramePurchases:z.number().int().min(1).max(10000).default(3),
    creatorLevel:z.number().int().min(1).max(1000).default(3),
    levelFive:z.number().int().min(1).max(1000).default(5),
    insiderLevel:z.number().int().min(1).max(1000).default(6),
    iconLevel:z.number().int().min(1).max(1000).default(10)
  }).default(defaultStudioIdConfig.thresholds),
  supporterRolePattern:z.string().trim().max(300).default(defaultStudioIdConfig.supporterRolePattern),
  features:z.object({
    badges:z.boolean().default(true),
    achievements:z.boolean().default(true),
    perks:z.boolean().default(true)
  }).default(defaultStudioIdConfig.features),
  ranks:z.array(rankSchema).min(1).max(12).default(defaultStudioIdConfig.ranks),
  discordRankSync:z.object({
    enabled:z.boolean().default(false),
    roleIds:z.record(z.string(),z.string().max(24)).default(defaultStudioIdConfig.discordRankSync.roleIds)
  }).default(defaultStudioIdConfig.discordRankSync)
}).superRefine((value,ctx)=>{
  const ids=new Set();
  for(const [index,rank] of value.ranks.entries()){
    if(ids.has(rank.id))ctx.addIssue({code:'custom',path:['ranks',index,'id'],message:'IDs de rank precisam ser únicos.'});
    ids.add(rank.id);
  }
});

export function studioIdConfig(store){
  const saved=store.get('portfolio:studio-id-config',null);
  const merged={
    ...defaultStudioIdConfig,
    ...(saved&&typeof saved==='object'?saved:{}),
    xp:{...defaultStudioIdConfig.xp,...(saved?.xp||{})},
    thresholds:{...defaultStudioIdConfig.thresholds,...(saved?.thresholds||{})},
    features:{...defaultStudioIdConfig.features,...(saved?.features||{})},
    discordRankSync:{
      ...defaultStudioIdConfig.discordRankSync,
      ...(saved?.discordRankSync||{}),
      roleIds:{...defaultStudioIdConfig.discordRankSync.roleIds,...(saved?.discordRankSync?.roleIds||{})}
    }
  };
  const result=studioIdConfigSchema.safeParse(merged);
  return result.success?normalizeRanks(result.data):structuredClone(defaultStudioIdConfig);
}

export function saveStudioIdConfig(store,input){
  const parsed=studioIdConfigSchema.parse(input);
  const normalized=normalizeRanks(parsed);
  store.set('portfolio:studio-id-config',normalized);
  return normalized;
}

function normalizeRanks(config){
  const ranks=[...config.ranks].sort((a,b)=>a.minLevel-b.minLevel||a.id.localeCompare(b.id));
  if(!ranks.some(rank=>rank.minLevel===1)){
    ranks.unshift({id:'member',label:'Studio Member',icon:'•',rarity:'common',minLevel:1});
  }
  return{...config,ranks};
}

export function studioIdentityFor(store,userId){
  const key=`portfolio:member:${userId}`;
  let identity=store.get(key,null);
  if(identity?.studioId)return identity;
  const sequence=Math.max(1,Number(store.get('portfolio:member-sequence',0)||0)+1);
  store.set('portfolio:member-sequence',sequence);
  identity={studioId:`SK-${String(sequence).padStart(5,'0')}`,sequence,joinedAt:store.now()};
  store.set(key,identity);
  return identity;
}

export function studioFavoritesFor(store,userId){
  const saved=store.get(`portfolio:favorites:${userId}`,{items:[],products:[]})||{};
  const normalize=list=>[...new Set((Array.isArray(list)?list:[]).map(value=>String(value||'').trim()).filter(Boolean))].slice(0,500);
  return{items:normalize(saved.items),products:normalize(saved.products)};
}

export function studioProfilePrefsFor(store,userId){
  const saved=store.get(`portfolio:profile-prefs:${userId}`,{})||{};
  return{equippedTitleId:String(saved.equippedTitleId||'member').slice(0,80)};
}

const safeRarity=rarity=>['common','rare','epic','legendary'].includes(rarity)?rarity:'common';

export function studioIdProfile(store,userId,member={},options={}){
  const config=studioIdConfig(store);
  const identity=studioIdentityFor(store,userId);
  const favorites=studioFavoritesFor(store,userId);
  const purchases=store.all("SELECT product_id,product,price FROM orders WHERE user_id=? AND status IN ('paid','delivered')",userId);
  const feedbackCount=Number(store.one("SELECT COUNT(*) AS n FROM feedback_requests WHERE user_id=? AND status='submitted'",userId)?.n||0);
  const ticketStats=store.one("SELECT COUNT(*) AS total,SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open FROM tickets WHERE user_id=?",userId)||{};
  const favoriteCount=favorites.items.length+favorites.products.length;
  const lifetimeSpend=purchases.reduce((sum,row)=>sum+Number(row.price||0),0);
  const roleNames=(member?.roles||[]).map(role=>String(role?.name||'')).filter(Boolean);
  const purchaseText=purchases.map(row=>String(row.product||'')).join(' ').toLowerCase();
  let supporterMatcher=null;
  try{supporterMatcher=config.supporterRolePattern?new RegExp(config.supporterRolePattern,'i'):null;}catch{}
  const isSupporter=!!supporterMatcher&&roleNames.some(name=>supporterMatcher.test(name));
  const isNeonLover=/neon|emissiv/.test(purchaseText);
  const xp=Number(config.xp.base||0)
    +(member?.inGuild?Number(config.xp.discordMember||0):0)
    +(purchases.length*Number(config.xp.purchase||0))
    +(feedbackCount*Number(config.xp.feedback||0))
    +(favoriteCount*Number(config.xp.favorite||0));
  const step=Math.max(50,Number(config.levelStep||300));
  const level=Math.max(1,Math.floor(xp/step)+1);
  const rank=[...config.ranks].filter(item=>level>=item.minLevel).sort((a,b)=>b.minLevel-a.minLevel)[0]||config.ranks[0];
  const earlyMember=Number(config.earlyMemberLimit||0)>0&&Number(identity.sequence||0)<=Number(config.earlyMemberLimit||0);
  const th=config.thresholds;
  const badgeCatalog=[
    {id:'early-member',label:'Early Member',icon:'✦',rarity:'legendary',description:`Entre os primeiros ${config.earlyMemberLimit} Studio K IDs.`,unlocked:earlyMember},
    {id:'discord-member',label:'Discord Member',icon:'◆',rarity:'common',description:'Conta conectada à comunidade Studio K.',unlocked:!!member?.inGuild},
    {id:'supporter',label:'Supporter',icon:'★',rarity:'epic',description:'Possui um cargo de apoiador, VIP ou cliente.',unlocked:isSupporter},
    {id:'first-purchase',label:'Primeira Compra',icon:'♡',rarity:'common',description:'Concluiu a primeira compra no Studio K.',unlocked:purchases.length>=1},
    {id:'collector',label:`${Math.max(th.collectorPurchases,purchases.length)} Compras`,icon:'◇',rarity:'rare',description:`Construiu uma coleção com pelo menos ${th.collectorPurchases} compras.`,unlocked:purchases.length>=th.collectorPurchases},
    {id:'neon-lover',label:'Neon Lover',icon:'✧',rarity:'epic',description:'Adquiriu um item Neon ou emissivo.',unlocked:isNeonLover},
    {id:'reviewer',label:'Reviewer',icon:'✓',rarity:'rare',description:'Enviou feedback para o Studio K.',unlocked:feedbackCount>=1},
    {id:'level-five',label:`Level ${th.levelFive}`,icon:'Ⅴ',rarity:'rare',description:`Alcançou o nível ${th.levelFive} do Studio K ID.`,unlocked:level>=th.levelFive},
    {id:'studio-icon',label:'Studio Icon',icon:'K',rarity:'legendary',description:`Alcançou o nível ${th.iconLevel} do ecossistema.`,unlocked:level>=th.iconLevel}
  ].map(badge=>({...badge,rarity:safeRarity(badge.rarity)}));
  const badges=config.features.badges?badgeCatalog.filter(badge=>badge.unlocked).map(({unlocked,...badge})=>badge):[];
  const titleCatalog=[
    {id:'member',label:'Studio K Member',rarity:'common',description:'Título base de todo Studio K ID.',unlocked:true},
    {id:'early-member',label:'Early Member',rarity:'legendary',description:'Reservado aos primeiros membros do ecossistema.',unlocked:earlyMember},
    {id:'supporter',label:'Supporter',rarity:'epic',description:'Para quem possui um cargo de apoiador, VIP ou cliente.',unlocked:isSupporter},
    {id:'collector',label:'Collector',rarity:'rare',description:`Desbloqueado ao concluir ${th.collectorPurchases} compras.`,unlocked:purchases.length>=th.collectorPurchases},
    {id:'neon-lover',label:'Neon Lover',rarity:'epic',description:'Desbloqueado por uma compra Neon/emissiva.',unlocked:isNeonLover},
    {id:'reviewer',label:'Studio Reviewer',rarity:'rare',description:'Desbloqueado após o primeiro feedback.',unlocked:feedbackCount>=1},
    ...config.ranks.filter(item=>item.id!=='member').map(item=>({id:item.id,label:item.label,rarity:item.rarity,description:`Desbloqueado no level ${item.minLevel}.`,unlocked:level>=item.minLevel}))
  ].map(title=>({...title,rarity:safeRarity(title.rarity)}));
  const prefs=studioProfilePrefsFor(store,userId);
  const equippedTitle=titleCatalog.find(title=>title.id===prefs.equippedTitleId&&title.unlocked)||titleCatalog[0];
  if(equippedTitle.id!==prefs.equippedTitleId)store.set(`portfolio:profile-prefs:${userId}`,{...prefs,equippedTitleId:equippedTitle.id});
  const achievementCatalog=[
    {id:'studio-id',label:'Identidade criada',description:'Seu Studio K ID entrou oficialmente no ecossistema.',icon:'K',rarity:'common',unlocked:true},
    {id:'discord-connected',label:'Conectado à comunidade',description:'Vinculou o Studio K ID ao Discord.',icon:'◆',rarity:'common',unlocked:!!member?.inGuild},
    {id:'first-favorite',label:'Primeira escolha',description:'Salvou o primeiro favorito.',icon:'♡',rarity:'common',unlocked:favoriteCount>=1},
    {id:'first-purchase',label:'Primeira aquisição',description:'Concluiu a primeira compra.',icon:'✦',rarity:'rare',unlocked:purchases.length>=1},
    {id:'collector',label:'Colecionador',description:`Concluiu ${th.collectorPurchases} compras no Studio K.`,icon:'◇',rarity:'epic',unlocked:purchases.length>=th.collectorPurchases},
    {id:'reviewer',label:'Sua voz conta',description:'Enviou o primeiro feedback.',icon:'✓',rarity:'rare',unlocked:feedbackCount>=1},
    {id:'neon-lover',label:'Energia Neon',description:'Adquiriu um produto Neon/emissivo.',icon:'✧',rarity:'epic',unlocked:isNeonLover},
    {id:'level-five',label:'Ascensão',description:`Alcançou o level ${th.levelFive}.`,icon:'Ⅴ',rarity:'epic',unlocked:level>=th.levelFive},
    {id:'studio-icon',label:'Ícone Studio K',description:`Alcançou o level ${th.iconLevel}.`,icon:'★',rarity:'legendary',unlocked:level>=th.iconLevel}
  ].map(item=>({...item,rarity:safeRarity(item.rarity)}));
  const achievementHistory=store.get(`portfolio:achievements:${userId}`,{})||{};
  let achievementsChanged=false;
  for(const achievement of achievementCatalog){
    if(achievement.unlocked&&!achievementHistory[achievement.id]){
      achievementHistory[achievement.id]=store.now();
      achievementsChanged=true;
    }
  }
  if(achievementsChanged)store.set(`portfolio:achievements:${userId}`,achievementHistory);
  const achievements=config.features.achievements?achievementCatalog.map(({unlocked,...achievement})=>({
    ...achievement,
    unlocked,
    unlockedAt:unlocked?String(achievementHistory[achievement.id]||identity.joinedAt||store.now()):''
  })):[];
  const perks=config.features.perks?[
    {id:'ecosystem-sync',label:'Studio K Sync',description:'Identidade reconhecida pelo site e bot do Studio K.',icon:'K',rarity:'common',unlocked:true,progress:1,target:1},
    {id:'badge-showcase',label:'Badge Showcase',description:'Exibição expandida de badges no perfil.',icon:'✦',rarity:'common',unlocked:level>=2,progress:Math.min(level,2),target:2},
    {id:'profile-frame',label:'Collector Frame',description:`Moldura especial para o Studio K ID após ${th.profileFramePurchases} compras.`,icon:'◇',rarity:'rare',unlocked:purchases.length>=th.profileFramePurchases,progress:Math.min(purchases.length,th.profileFramePurchases),target:th.profileFramePurchases},
    {id:'neon-aura',label:'Neon Aura',description:'Efeito Neon especial no cartão do Studio K ID.',icon:'✧',rarity:'epic',unlocked:isNeonLover,progress:isNeonLover?1:0,target:1},
    {id:'insider-mark',label:'Insider Mark',description:`Marca avançada de perfil para membros level ${th.insiderLevel}+.`,icon:'◆',rarity:'epic',unlocked:level>=th.insiderLevel,progress:Math.min(level,th.insiderLevel),target:th.insiderLevel},
    {id:'priority-support',label:'Priority Support',description:'Identifica apoiadores elegíveis para fluxos prioritários de suporte.',icon:'★',rarity:'epic',unlocked:isSupporter,progress:isSupporter?1:0,target:1},
    {id:'icon-aura',label:'Icon Aura',description:'Tratamento visual máximo do Studio K ID.',icon:'K',rarity:'legendary',unlocked:level>=th.iconLevel,progress:Math.min(level,th.iconLevel),target:th.iconLevel}
  ].map(perk=>({...perk,rarity:safeRarity(perk.rarity)})):[];
  return{
    studioId:identity.studioId,
    joinedAt:identity.joinedAt,
    level,
    xp,
    levelFloor:(level-1)*step,
    nextLevelXp:level*step,
    rank:{...rank,rarity:safeRarity(rank.rarity)},
    equippedTitle:{id:equippedTitle.id,label:equippedTitle.label,rarity:equippedTitle.rarity},
    titles:titleCatalog,
    discountPercent:Math.max(0,Number(options.discountPercent||0)),
    badges,
    achievements,
    perks,
    favorites,
    stats:{
      purchases:purchases.length,
      lifetimeSpend,
      feedbacks:feedbackCount,
      favorites:favoriteCount,
      tickets:Number(ticketStats.total||0),
      openTickets:Number(ticketStats.open||0)
    },
    purchasedProductIds:[...new Set(purchases.map(row=>String(row.product_id||'')).filter(Boolean))]
  };
}
