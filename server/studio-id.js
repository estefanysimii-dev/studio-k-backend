import { z } from 'zod';

export const studioRaritySchema=z.enum(['common','rare','epic','legendary']);

export const defaultStudioIdConfig={
  enabled:true,
  earlyMemberLimit:250,
  thresholds:{
    collectorPurchases:5
  },
  supporterRolePattern:'supporter|vip|premium|apoiador|cliente'
};

export const studioIdConfigSchema=z.object({
  enabled:z.boolean().default(true),
  earlyMemberLimit:z.number().int().min(0).max(1000000).default(250),
  thresholds:z.object({
    collectorPurchases:z.number().int().min(1).max(10000).default(5)
  }).default(defaultStudioIdConfig.thresholds),
  supporterRolePattern:z.string().trim().max(300).default(defaultStudioIdConfig.supporterRolePattern)
});

export function studioIdConfig(store){
  const saved=store.get('portfolio:studio-id-config',null);
  const merged={
    ...defaultStudioIdConfig,
    ...(saved&&typeof saved==='object'?saved:{}),
    thresholds:{...defaultStudioIdConfig.thresholds,...(saved?.thresholds||{})}
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

  return{
    studioId:identity.studioId,
    joinedAt:identity.joinedAt,
    equippedTitle:{id:equippedTitle.id,label:equippedTitle.label,rarity:equippedTitle.rarity},
    titles:titleCatalog,
    discountPercent:Math.max(0,Number(options.discountPercent||0)),
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
