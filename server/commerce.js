import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './store.js';

const idText=z.string().trim().min(1).max(160);
const isoOrEmpty=z.union([z.literal(''),z.string().datetime()]).default('');
const httpsOrPath=z.string().trim().max(2000).default('');

export const bundleSchema=z.object({
  id:z.string().trim().max(80).default(''),
  name:z.string().trim().min(2).max(120),
  description:z.string().trim().max(500).default(''),
  productIds:z.array(idText).min(2).max(30),
  minItems:z.number().int().min(2).max(30).default(2),
  discountType:z.enum(['percent','fixed']).default('percent'),
  discountValue:z.number().int().min(0).max(100000000).default(10),
  active:z.boolean().default(true)
});

export const collectionSchema=z.object({
  id:z.string().trim().max(80).default(''),
  name:z.string().trim().min(2).max(120),
  slug:z.string().trim().regex(/^[a-z0-9-]+$/).max(100),
  description:z.string().trim().max(1200).default(''),
  coverUrl:httpsOrPath,
  productIds:z.array(idText).max(100).default([]),
  itemIds:z.array(idText).max(100).default([]),
  active:z.boolean().default(true),
  startsAt:isoOrEmpty,
  endsAt:isoOrEmpty
});

export const missionSchema=z.object({
  id:z.string().trim().max(80).default(''),
  title:z.string().trim().min(2).max(120),
  description:z.string().trim().max(600).default(''),
  type:z.enum(['view_product','favorite_products','purchases','feedbacks','join_discord','visit_path']),
  target:z.number().int().min(1).max(100000).default(1),
  targetId:z.string().trim().max(180).default(''),
  xp:z.number().int().min(0).max(100000).default(50),
  active:z.boolean().default(true),
  startsAt:isoOrEmpty,
  endsAt:isoOrEmpty
});

export const bannerSchema=z.object({
  id:z.string().trim().max(80).default(''),
  title:z.string().trim().min(1).max(140),
  text:z.string().trim().max(600).default(''),
  imageUrl:httpsOrPath,
  href:z.string().trim().max(2000).default(''),
  placement:z.enum(['all','home','products','portfolio','popup']).default('all'),
  active:z.boolean().default(true),
  startsAt:isoOrEmpty,
  endsAt:isoOrEmpty
});

export const roleBenefitSchema=z.object({
  id:z.string().trim().max(80).default(''),
  roleId:z.string().regex(/^\d{17,20}$/),
  label:z.string().trim().min(1).max(100),
  discountPercent:z.number().int().min(0).max(100).default(0),
  stackWithCoupon:z.boolean().default(false),
  productIds:z.array(idText).max(100).default([]),
  collectionIds:z.array(idText).max(100).default([]),
  active:z.boolean().default(true)
});

export const scheduleSchema=z.object({
  id:z.string().trim().max(80).default(''),
  kind:z.enum(['product_publish','product_unpublish','collection_activate','collection_deactivate','banner_activate','banner_deactivate']),
  targetId:idText,
  runAt:z.string().datetime(),
  status:z.enum(['scheduled','done','failed','cancelled']).default('scheduled'),
  error:z.string().max(400).default('')
});

export const gallerySchema=z.object({
  id:z.string().trim().max(80).default(''),
  userId:z.string().trim().max(30).default(''),
  name:z.string().trim().min(1).max(100),
  caption:z.string().trim().max(600).default(''),
  imageUrl:httpsOrPath,
  productIds:z.array(idText).max(20).default([]),
  status:z.enum(['pending','approved','rejected']).default('pending'),
  created:z.string().datetime().optional()
});

export const lookbookSchema=z.object({
  id:z.string().trim().max(80).default(''),
  name:z.string().trim().min(2).max(120),
  description:z.string().trim().max(700).default(''),
  coverUrl:httpsOrPath,
  productIds:z.array(idText).min(1).max(30),
  active:z.boolean().default(true)
});

const list=(store,key)=>Array.isArray(store.get(key,[]))?store.get(key,[]):[];
const saveList=(store,key,value)=>{store.set(key,value);return value;};
const stamp=(store,item)=>({...item,id:item.id||randomUUID(),updated:store.now(),created:item.created||store.now()});
const activeWindow=(item,now=Date.now())=>item.active!==false&&(!item.startsAt||Date.parse(item.startsAt)<=now)&&(!item.endsAt||Date.parse(item.endsAt)>now);

export function commerceAdminState(store){
  return{
    bundles:list(store,'portfolio:bundles'),
    collections:list(store,'portfolio:collections'),
    missions:list(store,'portfolio:missions'),
    banners:list(store,'portfolio:banners'),
    roleBenefits:list(store,'portfolio:role-benefits'),
    schedules:list(store,'portfolio:schedules'),
    gallery:list(store,'portfolio:gallery'),
    lookbooks:list(store,'portfolio:lookbooks'),
    leaderboard:store.get('portfolio:leaderboard-config',{enabled:false})
  };
}

export function commercePublicState(store){
  const now=Date.now();
  return{
    bundles:list(store,'portfolio:bundles').filter(x=>x.active!==false),
    collections:list(store,'portfolio:collections').filter(x=>activeWindow(x,now)),
    missions:list(store,'portfolio:missions').filter(x=>activeWindow(x,now)),
    banners:list(store,'portfolio:banners').filter(x=>activeWindow(x,now)),
    gallery:list(store,'portfolio:gallery').filter(x=>x.status==='approved'),
    lookbooks:list(store,'portfolio:lookbooks').filter(x=>x.active!==false),
    leaderboard:store.get('portfolio:leaderboard-config',{enabled:false})
  };
}

export function upsertCommerce(store,kind,raw){
  const defs={
    bundles:['portfolio:bundles',bundleSchema],
    collections:['portfolio:collections',collectionSchema],
    missions:['portfolio:missions',missionSchema],
    banners:['portfolio:banners',bannerSchema],
    roleBenefits:['portfolio:role-benefits',roleBenefitSchema],
    schedules:['portfolio:schedules',scheduleSchema],
    gallery:['portfolio:gallery',gallerySchema],
    lookbooks:['portfolio:lookbooks',lookbookSchema]
  };
  const def=defs[kind];if(!def)throw new AppError('Tipo de configuração comercial inválido.');
  const [key,schema]=def,data=stamp(store,schema.parse(raw)),items=list(store,key);
  const index=items.findIndex(x=>x.id===data.id);
  if(index>=0)items[index]={...items[index],...data};else items.unshift(data);
  saveList(store,key,items.slice(0,1000));
  return data;
}

export function deleteCommerce(store,kind,id){
  const keys={bundles:'portfolio:bundles',collections:'portfolio:collections',missions:'portfolio:missions',banners:'portfolio:banners',roleBenefits:'portfolio:role-benefits',schedules:'portfolio:schedules',gallery:'portfolio:gallery',lookbooks:'portfolio:lookbooks'};
  const key=keys[kind];if(!key)throw new AppError('Tipo de configuração comercial inválido.');
  saveList(store,key,list(store,key).filter(x=>x.id!==id));return{ok:true};
}

export function setLeaderboardConfig(store,value){
  const next={enabled:value?.enabled===true};
  store.set('portfolio:leaderboard-config',next);return next;
}

export function cartFor(store,userId){
  const raw=store.get(`portfolio:cart:${userId}`,[])||[];
  return (Array.isArray(raw)?raw:[]).map(x=>({productId:String(x.productId||''),quantity:Math.max(1,Math.min(20,Number(x.quantity)||1))})).filter(x=>x.productId);
}
export function setCart(store,userId,items){
  const next=(Array.isArray(items)?items:[]).map(x=>({productId:String(x.productId||''),quantity:Math.max(1,Math.min(20,Number(x.quantity)||1))})).filter(x=>x.productId).slice(0,50);
  store.set(`portfolio:cart:${userId}`,next);return next;
}

export function notificationsFor(store,userId){
  return (store.get(`portfolio:notifications:${userId}`,[])||[]).slice(0,200);
}
export function addNotification(store,userId,{type='info',title,text='',href=''}){
  if(!userId)return null;
  const item={id:randomUUID(),type:String(type).slice(0,30),title:String(title).slice(0,140),text:String(text).slice(0,600),href:String(href).slice(0,1000),read:false,created:store.now()};
  const items=notificationsFor(store,userId);items.unshift(item);store.set(`portfolio:notifications:${userId}`,items.slice(0,200));return item;
}
export function markNotification(store,userId,id,read=true){
  const items=notificationsFor(store,userId).map(item=>item.id===id?{...item,read:!!read}:item);store.set(`portfolio:notifications:${userId}`,items);return items;
}

function discountForBundle(subtotal,bundle,count){
  if(count<Math.max(2,Number(bundle.minItems||2)))return 0;
  if(bundle.discountType==='fixed')return Math.min(subtotal,Math.max(0,Number(bundle.discountValue||0)));
  return Math.floor(subtotal*Math.min(100,Math.max(0,Number(bundle.discountValue||0)))/100);
}
function productCollections(store,productId){
  return list(store,'portfolio:collections').filter(c=>(c.productIds||[]).includes(productId)).map(c=>c.id);
}
export function productAvailability(store,product){
  const mode=String(product?.stockMode||'unlimited');
  const botId=String(product?.botProductId||'');
  const reservedOrSold=botId?Number(store.one("SELECT COUNT(*) AS n FROM orders WHERE product_id=? AND status IN ('pending','paid','delivered')",botId)?.n||0):0;
  let remaining=null;
  if(mode==='digital'&&botId){
    remaining=Number(store.one('SELECT COUNT(*) AS n FROM stock WHERE product_id=? AND order_id IS NULL',botId)?.n||0);
  }else if(['limited','slots','numbered'].includes(mode)){
    remaining=Math.max(0,Number(product?.stockLimit||0)-reservedOrSold);
  }
  return{soldCount:reservedOrSold,remaining,available:remaining===null||remaining>0};
}

export function roleBenefitFor(store,member,productId,collections=[]){
  const roleIds=new Set((member?.roles||[]).map(r=>r.id));
  const candidates=list(store,'portfolio:role-benefits').filter(b=>b.active!==false&&roleIds.has(b.roleId)).filter(b=>{
    const p=b.productIds||[],c=b.collectionIds||[];
    return(!p.length&&!c.length)||p.includes(productId)||c.some(id=>collections.includes(id));
  }).sort((a,b)=>Number(b.discountPercent||0)-Number(a.discountPercent||0));
  return candidates[0]||null;
}

export function quoteCart(store,userId,member,products,couponCode='',memberDiscountPercent=0){
  const cart=cartFor(store,userId),byId=new Map(products.map(p=>[p.id,p])),lines=[];
  for(const row of cart){
    const p=byId.get(row.productId);if(!p||p.published===false)continue;
    const qty=Math.max(1,row.quantity),base=Math.max(0,Number(p.priceCents||0)),collections=productCollections(store,p.id),roleBenefit=roleBenefitFor(store,member,p.id,collections);
    const globalPercent=Math.max(0,Math.min(100,Number(memberDiscountPercent||0)));
    const rolePercent=Math.max(0,Math.min(100,Number(roleBenefit?.discountPercent||0)));
    const effectivePercent=Math.max(globalPercent,rolePercent);
    const effectiveBenefit=rolePercent>=globalPercent&&roleBenefit
      ? roleBenefit
      : globalPercent>0
        ? {id:'studio-k-id',label:'Studio K ID',discountPercent:globalPercent,stackWithCoupon:true}
        : null;
    const roleDiscount=Math.floor(base*effectivePercent/100);
    const unit=Math.max(0,base-roleDiscount);
    lines.push({productId:p.id,name:p.name,quantity:qty,basePrice:base,unitPrice:unit,roleDiscount,roleBenefit:effectiveBenefit?{id:effectiveBenefit.id,label:effectiveBenefit.label,discountPercent:effectiveBenefit.discountPercent,stackWithCoupon:effectiveBenefit.stackWithCoupon===true}:null,subtotal:unit*qty});
  }
  let subtotal=lines.reduce((s,l)=>s+l.subtotal,0),bundleDiscount=0,appliedBundles=[];
  for(const bundle of list(store,'portfolio:bundles').filter(x=>x.active!==false)){
    const matched=lines.filter(line=>(bundle.productIds||[]).includes(line.productId));
    const count=matched.reduce((s,line)=>s+line.quantity,0),base=matched.reduce((s,line)=>s+line.subtotal,0),discount=discountForBundle(base,bundle,count);
    if(discount>0){bundleDiscount+=discount;appliedBundles.push({id:bundle.id,name:bundle.name,discount});}
  }
  bundleDiscount=Math.min(subtotal,bundleDiscount);
  let couponDiscount=0,coupon=null;
  const normalized=String(couponCode||'').trim().toUpperCase();
  if(normalized&&lines.length){
    const cp=store.one('SELECT * FROM coupons WHERE code=?',normalized);
    if(cp&&cp.active&&(!cp.expires||Date.parse(cp.expires)>Date.now())&&(!cp.max_uses||cp.uses<cp.max_uses)){
      const baseEligible=lines.filter(l=>!l.roleBenefit||l.roleBenefit.stackWithCoupon===true);
      const eligible=cp.product_id?baseEligible.filter(l=>l.productId===cp.product_id):baseEligible;
      const eligibleValue=eligible.reduce((s,l)=>s+l.subtotal,0);
      couponDiscount=cp.type==='percent'?Math.floor(eligibleValue*Math.min(100,cp.value)/100):Math.min(eligibleValue,cp.value);
      coupon={code:normalized,discount:couponDiscount};
    }
  }
  const total=Math.max(0,subtotal-bundleDiscount-couponDiscount);
  return{items:lines,subtotal,bundleDiscount,couponDiscount,total,appliedBundles,coupon};
}

export function missionProgress(store,userId,member,mission){
  const now=Date.now();if(!activeWindow(mission,now))return{progress:0,target:mission.target,complete:false};
  let progress=0;
  if(mission.type==='favorite_products'){
    const fav=store.get(`portfolio:favorites:${userId}`,{items:[],products:[]})||{};progress=(fav.products||[]).length;
  }else if(mission.type==='purchases'){
    progress=Number(store.one("SELECT COUNT(*) AS n FROM orders WHERE user_id=? AND status IN ('paid','delivered')",userId)?.n||0);
  }else if(mission.type==='feedbacks'){
    progress=Number(store.one("SELECT COUNT(*) AS n FROM feedback_requests WHERE user_id=? AND status='submitted'",userId)?.n||0);
  }else if(mission.type==='join_discord'){
    progress=member?.inGuild?1:0;
  }else if(mission.type==='view_product'){
    if(mission.targetId)progress=Number(store.one("SELECT COUNT(*) AS n FROM portfolio_events WHERE user_id=? AND event='product_view' AND item_id=?",userId,mission.targetId)?.n||0);
    else progress=Number(store.one("SELECT COUNT(*) AS n FROM portfolio_events WHERE user_id=? AND event='product_view'",userId)?.n||0);
  }else if(mission.type==='visit_path'){
    progress=Number(store.one("SELECT COUNT(*) AS n FROM portfolio_events WHERE user_id=? AND event='page_view' AND path=?",userId,mission.targetId)?.n||0);
  }
  const claimed=(store.get(`portfolio:mission-claims:${userId}`,[])||[]).includes(mission.id);
  return{progress:Math.min(progress,mission.target),target:mission.target,complete:progress>=mission.target,claimed};
}

export function claimMission(store,userId,member,missionId){
  const mission=list(store,'portfolio:missions').find(x=>x.id===missionId&&activeWindow(x));
  if(!mission)throw new AppError('Missão não encontrada ou encerrada.',404);
  const status=missionProgress(store,userId,member,mission);
  if(!status.complete)throw new AppError('Essa missão ainda não foi concluída.');
  const claims=store.get(`portfolio:mission-claims:${userId}`,[])||[];
  if(claims.includes(missionId))throw new AppError('Essa recompensa já foi resgatada.');
  claims.push(missionId);store.set(`portfolio:mission-claims:${userId}`,claims);
  const current=Number(store.get(`portfolio:xp-bonus:${userId}`,0)||0),xp=Math.max(0,Number(mission.xp||0));
  store.set(`portfolio:xp-bonus:${userId}`,current+xp);
  addNotification(store,userId,{type:'mission',title:'Missão concluída ✨',text:`${mission.title}: +${xp} XP`,href:'/account'});
  return{...status,claimed:true,xp};
}

export function recommendationsFor(store,userId,products,currentProductId='',limit=6){
  const fav=store.get(`portfolio:favorites:${userId}`,{products:[]})||{},favorites=new Set(fav.products||[]);
  const purchased=new Set(store.all("SELECT product_id FROM orders WHERE user_id=? AND status IN ('paid','delivered')",userId).map(r=>r.product_id));
  const current=products.find(p=>p.id===currentProductId),views=store.all("SELECT item_id,COUNT(*) AS n FROM portfolio_events WHERE event='product_view' AND item_kind='product' GROUP BY item_id");
  const viewMap=new Map(views.map(r=>[r.item_id,Number(r.n||0)]));
  return products.filter(p=>p.published!==false&&p.id!==currentProductId).map(p=>{
    let score=Math.min(30,viewMap.get(p.id)||0);
    if(favorites.has(p.id))score+=35;
    if(purchased.has(p.id))score-=80;
    if(current){
      if(p.category&&p.category===current.category)score+=35;
      const overlap=(p.tags||[]).filter(t=>(current.tags||[]).includes(t)).length;score+=overlap*18;
      const together=store.one("SELECT COUNT(*) AS n FROM orders a JOIN orders b ON a.user_id=b.user_id WHERE a.product_id=? AND b.product_id=? AND a.status IN ('paid','delivered') AND b.status IN ('paid','delivered')",current.id,p.id)?.n||0;
      score+=Math.min(50,Number(together)*15);
    }
    return{productId:p.id,score,reason:current&&p.category===current.category?'Mesma categoria':favorites.has(p.id)?'Você favoritou':'Em alta'};
  }).sort((a,b)=>b.score-a.score).slice(0,limit);
}

export function globalSearch(store,products,items,query){
  const q=String(query||'').trim().toLowerCase();if(q.length<2)return[];
  const collections=list(store,'portfolio:collections').filter(x=>activeWindow(x));
  const score=(text)=>{const t=text.toLowerCase();return t===q?100:t.startsWith(q)?75:t.includes(q)?45:0;};
  const results=[];
  for(const p of products){const s=score([p.name,p.category,...(p.tags||[])].join(' '));if(s)results.push({kind:'product',id:p.id,title:p.name,subtitle:p.category,href:`/products/${p.id}`,score:s});}
  for(const p of items){const s=score([p.name,p.category,...(p.tags||[])].join(' '));if(s)results.push({kind:'portfolio',id:p.id,title:p.name,subtitle:p.category,href:`/portfolio/${p.id}`,score:s});}
  for(const x of collections){const s=score([x.name,x.description].join(' '));if(s)results.push({kind:'collection',id:x.id,title:x.name,subtitle:'Coleção',href:`/collections/${x.slug}`,score:s});}
  return results.sort((a,b)=>b.score-a.score).slice(0,20);
}

export function leaderboard(store,limit=20){
  if(store.get('portfolio:leaderboard-config',{enabled:false})?.enabled!==true)return[];
  const opted=store.all("SELECT key,value FROM kv WHERE key LIKE 'portfolio:leaderboard-optin:%'");
  return opted.map(row=>{
    const userId=row.key.split(':').pop(),optin=JSON.parse(row.value||'false');if(!optin)return null;
    const purchases=Number(store.one("SELECT COUNT(*) AS n FROM orders WHERE user_id=? AND status IN ('paid','delivered')",userId)?.n||0);
    const feedbacks=Number(store.one("SELECT COUNT(*) AS n FROM feedback_requests WHERE user_id=? AND status='submitted'",userId)?.n||0);
    const favorites=(store.get(`portfolio:favorites:${userId}`,{products:[],items:[]})?.products||[]).length;
    return{userId,score:purchases*250+feedbacks*75+favorites*15+Number(store.get(`portfolio:xp-bonus:${userId}`,0)||0)};
  }).filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,limit);
}

export function activityFeed(store,products,drops,limit=20){
  const feed=[];
  for(const p of products.filter(x=>x.published!==false).slice(0,12))feed.push({id:`product:${p.id}`,type:'product',title:'Novo produto publicado',text:p.name,href:`/products/${p.id}`,created:p.created||p.updated||store.now()});
  for(const d of drops.filter(x=>x.published!==false).slice(0,8))feed.push({id:`drop:${d.id}`,type:'drop',title:'Drop disponível',text:d.title,href:d.productId?`/products/${d.productId}`:'/products',created:d.startsAt||d.created||store.now()});
  for(const f of store.all("SELECT id,rating,submitted_at FROM feedback_requests WHERE status='submitted' ORDER BY submitted_at DESC LIMIT 10"))feed.push({id:`feedback:${f.id}`,type:'feedback',title:`Novo feedback ${'★'.repeat(Math.max(1,Math.min(5,Number(f.rating)||5)))}`,text:'Avaliação verificada da comunidade',href:'/feedbacks',created:f.submitted_at||store.now()});
  return feed.sort((a,b)=>Date.parse(b.created)-Date.parse(a.created)).slice(0,limit);
}

export function recordVersion(store,{entityType,entityId,before=null,after=null,actor='portfolio-control',action='update'}){
  const versions=store.get('portfolio:versions',[])||[];
  const item={id:randomUUID(),entityType,entityId:String(entityId||''),before,after,actor,action,created:store.now()};
  versions.unshift(item);store.set('portfolio:versions',versions.slice(0,1000));
  store.log('auditoria',`${action} ${entityType} ${entityId}`,actor,{entityType,entityId,before,after});
  return item;
}
export const versionsFor=(store)=>store.get('portfolio:versions',[])||[];

export function runSchedules(store,{products,setProducts}){
  const schedules=list(store,'portfolio:schedules');let changed=false;
  const collections=list(store,'portfolio:collections'),banners=list(store,'portfolio:banners');
  for(const job of schedules){
    if(job.status!=='scheduled'||Date.parse(job.runAt)>Date.now())continue;
    try{
      if(job.kind==='product_publish'||job.kind==='product_unpublish'){
        const all=products(),index=all.findIndex(x=>x.id===job.targetId);if(index<0)throw new Error('Produto não encontrado.');
        all[index]={...all[index],published:job.kind==='product_publish',updated:store.now()};setProducts(all);
      }else if(job.kind==='collection_activate'||job.kind==='collection_deactivate'){
        const item=collections.find(x=>x.id===job.targetId);if(!item)throw new Error('Coleção não encontrada.');item.active=job.kind==='collection_activate';saveList(store,'portfolio:collections',collections);
      }else if(job.kind==='banner_activate'||job.kind==='banner_deactivate'){
        const item=banners.find(x=>x.id===job.targetId);if(!item)throw new Error('Banner não encontrado.');item.active=job.kind==='banner_activate';saveList(store,'portfolio:banners',banners);
      }
      job.status='done';job.error='';changed=true;
    }catch(e){job.status='failed';job.error=String(e.message||e).slice(0,400);changed=true;}
  }
  if(changed)saveList(store,'portfolio:schedules',schedules);return changed;
}
