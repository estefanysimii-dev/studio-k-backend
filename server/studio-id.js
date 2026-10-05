import { z } from 'zod';

const discordRoleId=z.string().regex(/^\d{17,20}$/).or(z.literal(''));

const defaultTitleSchema=z.object({
  label:z.string().trim().min(1).max(80).default('Studio K Member'),
  description:z.string().trim().max(240).default('Título padrão do perfil Studio K.')
});

const roleTitleSchema=z.object({
  id:z.string().trim().regex(/^[a-z0-9-]+$/).min(1).max(80),
  label:z.string().trim().min(1).max(80),
  description:z.string().trim().max(240).default(''),
  roleId:discordRoleId,
  enabled:z.boolean().default(true)
});

export const defaultStudioIdConfig={
  enabled:true,
  defaultTitle:{
    label:'Studio K Member',
    description:'Título padrão do perfil Studio K.'
  },
  titles:[]
};

export const studioIdConfigSchema=z.object({
  enabled:z.boolean().default(true),
  defaultTitle:defaultTitleSchema.default(defaultStudioIdConfig.defaultTitle),
  titles:z.array(roleTitleSchema).max(40).default([])
}).superRefine((value,ctx)=>{
  const ids=new Set();
  const roles=new Set();
  for(const [index,title] of value.titles.entries()){
    if(title.id==='member'){
      ctx.addIssue({code:'custom',path:['titles',index,'id'],message:'O ID member é reservado para o título padrão.'});
    }
    if(ids.has(title.id)){
      ctx.addIssue({code:'custom',path:['titles',index,'id'],message:'IDs de título precisam ser únicos.'});
    }
    ids.add(title.id);
    if(title.roleId){
      if(roles.has(title.roleId)){
        ctx.addIssue({code:'custom',path:['titles',index,'roleId'],message:'Cada cargo do Discord pode conceder apenas um título.'});
      }
      roles.add(title.roleId);
    }
  }
});

export function studioIdConfig(store){
  const saved=store.get('portfolio:studio-id-config',null);
  const source=saved&&typeof saved==='object'?saved:{};
  const merged={
    enabled:source.enabled!==false,
    defaultTitle:{
      ...defaultStudioIdConfig.defaultTitle,
      ...(source.defaultTitle&&typeof source.defaultTitle==='object'?source.defaultTitle:{})
    },
    titles:Array.isArray(source.titles)?source.titles:[]
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

export function studioIdProfile(store,userId,member={},options={}){
  const config=studioIdConfig(store);
  const identity=studioIdentityFor(store,userId);
  const favorites=studioFavoritesFor(store,userId);
  const purchases=store.all("SELECT product_id,product,price FROM orders WHERE user_id=? AND status IN ('paid','delivered')",userId);
  const feedbackCount=Number(store.one("SELECT COUNT(*) AS n FROM feedback_requests WHERE user_id=? AND status='submitted'",userId)?.n||0);
  const ticketStats=store.one("SELECT COUNT(*) AS total,SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open FROM tickets WHERE user_id=?",userId)||{};
  const favoriteCount=favorites.items.length+favorites.products.length;
  const lifetimeSpend=purchases.reduce((sum,row)=>sum+Number(row.price||0),0);

  const memberRoles=Array.isArray(member?.roles)?member.roles:[];
  const memberRoleIds=new Set(memberRoles.map(role=>String(role?.id||'')).filter(Boolean));
  const memberRoleNames=new Map(memberRoles.map(role=>[String(role?.id||''),String(role?.name||'')]));

  const defaultTitle={
    id:'member',
    label:config.defaultTitle.label,
    description:config.defaultTitle.description,
    roleId:'',
    roleName:'',
    source:'default'
  };
  const roleTitles=(config.titles||[])
    .filter(title=>title.enabled!==false&&title.roleId&&memberRoleIds.has(title.roleId))
    .map(title=>({
      id:title.id,
      label:title.label,
      description:title.description,
      roleId:title.roleId,
      roleName:memberRoleNames.get(title.roleId)||'Cargo do Discord',
      source:'discord'
    }));
  const titleCatalog=[defaultTitle,...roleTitles];

  const prefs=studioProfilePrefsFor(store,userId);
  const equippedTitle=titleCatalog.find(title=>title.id===prefs.equippedTitleId)||defaultTitle;
  if(equippedTitle.id!==prefs.equippedTitleId){
    store.set(`portfolio:profile-prefs:${userId}`,{...prefs,equippedTitleId:equippedTitle.id});
  }

  return{
    studioId:identity.studioId,
    joinedAt:identity.joinedAt,
    equippedTitle,
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
