import { z } from 'zod';
import { addNotification } from './commerce.js';

export const studioRaritySchema=z.enum(['common','rare','epic','legendary']);

export const defaultStudioIdConfig={
  enabled:true,
  earlyMemberLimit:250,
  thresholds:{
    collectorPurchases:5,
    profileFramePurchases:3
  },
  supporterRolePattern:'supporter|vip|premium|apoiador|cliente',
  features:{
    badges:true,
    achievements:true,
    perks:true
  },
  badges:[
    {id:'early-member',label:'Early Member',icon:'✦',rarity:'legendary',description:'Entre os primeiros membros do Studio K.',condition:'early-member',value:250,enabled:true},
    {id:'discord-member',label:'Discord Member',icon:'◆',rarity:'common',description:'Conta conectada à comunidade Studio K.',condition:'discord-member',value:1,enabled:true},
    {id:'supporter',label:'Supporter',icon:'★',rarity:'epic',description:'Possui um cargo de apoiador, VIP ou cliente.',condition:'supporter',value:1,enabled:true},
    {id:'first-purchase',label:'Primeira Compra',icon:'♡',rarity:'common',description:'Concluiu a primeira compra no Studio K.',condition:'purchases',value:1,enabled:true},
    {id:'collector',label:'Collector',icon:'◇',rarity:'rare',description:'Construiu uma coleção no Studio K.',condition:'purchases',value:5,enabled:true},
    {id:'neon-lover',label:'Neon Lover',icon:'✧',rarity:'epic',description:'Adquiriu um item Neon ou emissivo.',condition:'neon-lover',value:1,enabled:true},
    {id:'reviewer',label:'Reviewer',icon:'✓',rarity:'rare',description:'Enviou feedback para o Studio K.',condition:'feedbacks',value:1,enabled:true},
    {id:'level-five',label:'Level V',icon:'Ⅴ',rarity:'rare',description:'Alcançou o nível 5 do Studio K ID.',condition:'level',value:5,enabled:true},
    {id:'studio-icon',label:'Studio Icon',icon:'K',rarity:'legendary',description:'Alcançou o nível 10 do ecossistema.',condition:'level',value:10,enabled:true}
  ]
};

const badgeConditionSchema=z.enum(['always','early-member','discord-member','supporter','purchases','neon-lover','feedbacks','level','favorites']);
const badgeSchema=z.object({
  id:z.string().trim().regex(/^[a-z0-9-]+$/).max(60),
  label:z.string().trim().min(1).max(80),
  icon:z.string().trim().max(12).default('✦'),
  rarity:studioRaritySchema.default('common'),
  description:z.string().trim().max(240).default(''),
  condition:badgeConditionSchema.default('always'),
  value:z.number().int().min(0).max(1000000).default(1),
  enabled:z.boolean().default(true)
});

export const studioIdConfigSchema=z.object({
  enabled:z.boolean().default(true),
  earlyMemberLimit:z.number().int().min(0).max(1000000).default(250),
  thresholds:z.object({
    collectorPurchases:z.number().int().min(1).max(10000).default(5),
    profileFramePurchases:z.number().int().min(1).max(10000).default(3)
  }).default(defaultStudioIdConfig.thresholds),
  supporterRolePattern:z.string().trim().max(300).default(defaultStudioIdConfig.supporterRolePattern),
  features:z.object({
    badges:z.boolean().default(true),
    achievements:z.boolean().default(true),
    perks:z.boolean().default(true)
  }).default(defaultStudioIdConfig.features),
  badges:z.array(badgeSchema).max(24).default(defaultStudioIdConfig.badges)
}).superRefine((value,ctx)=>{
  const badgeIds=new Set();
  for(const [index,badge] of value.badges.entries()){
    if(badgeIds.has(badge.id))ctx.addIssue({code:'custom',path:['badges',index,'id'],message:'IDs de badge precisam ser únicos.'});
    badgeIds.add(badge.id);
  }
});

export function studioIdConfig(store){
  const saved=store.get('portfolio:studio-id-config',null);
  const merged={
    ...defaultStudioIdConfig,
    ...(saved&&typeof saved==='object'?saved:{}),
    thresholds:{...defaultStudioIdConfig.thresholds,...(saved?.thresholds||{})},
    features:{...defaultStudioIdConfig.features,...(saved?.features||{})},
    badges:Array.isArray(saved?.badges)?saved.badges:defaultStudioIdConfig.badges
  };
  const result=studioIdConfigSchema.safeParse(merged);
  return result.success?result.data:structuredClone(defaultStudioIdConfig);
}

export function saveStudioIdConfig(store,input){
  const parsed=studioIdConfigSchema.parse(input);
  store.set('portfolio:studio-id-config',parsed);
  return parsed;
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
  const earlyMember=Number(config.earlyMemberLimit||0)>0&&Number(identity.sequence||0)<=Number(config.earlyMemberLimit||0);
  const th=config.thresholds;
  const badgeUnlocked=(badge)=>{
    const value=Math.max(0,Number(badge.value||0));
    switch(badge.condition){
      case 'always':return true;
      case 'early-member':return value>0&&Number(identity.sequence||0)<=value;
      case 'discord-member':return !!member?.inGuild;
      case 'supporter':return isSupporter;
      case 'purchases':return purchases.length>=value;
      case 'neon-lover':return isNeonLover;
      case 'feedbacks':return feedbackCount>=value;
      case 'favorites':return favoriteCount>=value;
      default:return false;
    }
  };
  const badgeCatalog=(config.badges||[])
    .filter(badge=>badge.enabled!==false&&badge.condition!=='level')
    .map(badge=>({...badge,rarity:safeRarity(badge.rarity),unlocked:badgeUnlocked(badge)}));
  const badges=config.features.badges?badgeCatalog.filter(badge=>badge.unlocked).map(({unlocked,...badge})=>badge):[];
  const titleCatalog=[
    {id:'member',label:'Studio K Member',rarity:'common',description:'Título base de todo Studio K ID.',unlocked:true},
    {id:'early-member',label:'Early Member',rarity:'legendary',description:'Reservado aos primeiros membros do ecossistema.',unlocked:earlyMember},
    {id:'supporter',label:'Supporter',rarity:'epic',description:'Para quem possui um cargo de apoiador, VIP ou cliente.',unlocked:isSupporter},
    {id:'collector',label:'Collector',rarity:'rare',description:`Desbloqueado ao concluir ${th.collectorPurchases} compras.`,unlocked:purchases.length>=th.collectorPurchases},
    {id:'neon-lover',label:'Neon Lover',rarity:'epic',description:'Desbloqueado por uma compra Neon/emissiva.',unlocked:isNeonLover},
    {id:'reviewer',label:'Studio Reviewer',rarity:'rare',description:'Desbloqueado após o primeiro feedback.',unlocked:feedbackCount>=1}
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
    {id:'neon-lover',label:'Energia Neon',description:'Adquiriu um produto Neon/emissivo.',icon:'✧',rarity:'epic',unlocked:isNeonLover}
  ].map(item=>({...item,rarity:safeRarity(item.rarity)}));
  const achievementHistory=store.get(`portfolio:achievements:${userId}`,{})||{};
  let achievementsChanged=false;
  for(const achievement of achievementCatalog){
    if(achievement.unlocked&&!achievementHistory[achievement.id]){
      achievementHistory[achievement.id]=store.now();
      achievementsChanged=true;
      addNotification(store,userId,{type:'achievement',title:'Conquista desbloqueada 🏆',text:achievement.label,href:'/account'});
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
    {id:'profile-frame',label:'Collector Frame',description:`Moldura especial para o Studio K ID após ${th.profileFramePurchases} compras.`,icon:'◇',rarity:'rare',unlocked:purchases.length>=th.profileFramePurchases,progress:Math.min(purchases.length,th.profileFramePurchases),target:th.profileFramePurchases},
    {id:'neon-aura',label:'Neon Aura',description:'Efeito Neon especial no cartão do Studio K ID.',icon:'✧',rarity:'epic',unlocked:isNeonLover,progress:isNeonLover?1:0,target:1},
    {id:'priority-support',label:'Priority Support',description:'Identifica apoiadores elegíveis para fluxos prioritários de suporte.',icon:'★',rarity:'epic',unlocked:isSupporter,progress:isSupporter?1:0,target:1}
  ].map(perk=>({...perk,rarity:safeRarity(perk.rarity)})):[];
  const perkStateKey=`portfolio:perk-state:${userId}`;
  const previousPerks=store.get(perkStateKey,null);
  const unlockedPerkIds=perks.filter(perk=>perk.unlocked).map(perk=>perk.id);
  if(Array.isArray(previousPerks)){
    const known=new Set(previousPerks);
    for(const perk of perks){
      if(perk.unlocked&&!known.has(perk.id)){
        addNotification(store,userId,{type:'perk',title:'Novo benefício liberado 💜',text:perk.label,href:'/account'});
      }
    }
  }
  store.set(perkStateKey,unlockedPerkIds);
  return{
    studioId:identity.studioId,
    joinedAt:identity.joinedAt,
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
    purchasedProductIds:[...new Set(purchases.map(row=>{
      const orderId=String(row.product_id||'');
      const portfolioProducts=store.get('portfolio:products',[])||[];
      const match=Array.isArray(portfolioProducts)?portfolioProducts.find(product=>String(product.botProductId||'')===orderId||String(product.id||'')===orderId):null;
      return String(match?.id||orderId);
    }).filter(Boolean))]
  };
}
