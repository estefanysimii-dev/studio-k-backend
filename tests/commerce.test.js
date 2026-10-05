import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/store.js';
import {
  upsertCommerce, quoteCart, setCart, notificationsFor, addNotification, markNotification,
  missionProgress, claimMission, recommendationsFor, productAvailability
} from '../server/commerce.js';

test('Commerce Suite applies role benefits, progressive combos and notifications', (t) => {
  const dir=mkdtempSync(join(tmpdir(),'studio-k-commerce-'));
  const store=openStore(dir);
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});

  const products=[
    {id:'polo',name:'Polo Neon',priceCents:5000,published:true,category:'Neon',tags:['neon'],stockMode:'unlimited'},
    {id:'manguito',name:'Manguito Neon',priceCents:3000,published:true,category:'Neon',tags:['neon'],stockMode:'unlimited'},
    {id:'calca',name:'Calça',priceCents:4000,published:true,category:'Street',tags:['street'],stockMode:'limited',stockLimit:2,botProductId:'bot-calca'}
  ];

  upsertCommerce(store,'bundles',{
    name:'Combo Neon',description:'',productIds:['polo','manguito'],minItems:2,
    discountType:'percent',discountValue:5,
    tiers:[
      {minItems:2,discountType:'percent',discountValue:10},
      {minItems:3,discountType:'percent',discountValue:15}
    ],
    active:true
  });
  upsertCommerce(store,'roleBenefits',{
    roleId:'111111111111111111',label:'Supporter',discountPercent:20,stackWithCoupon:false,
    productIds:[],collectionIds:[],active:true
  });

  const userId='222222222222222222';
  setCart(store,userId,[{productId:'polo',quantity:1},{productId:'manguito',quantity:1}]);
  const member={roles:[{id:'111111111111111111',name:'Supporter'}]};
  const quote=quoteCart(store,userId,member,products,'',5);

  assert.equal(quote.items.length,2);
  assert.equal(quote.items.every(item=>item.roleBenefit?.label==='Supporter'),true);
  assert.equal(quote.subtotal,6400);
  assert.equal(quote.bundleDiscount,640);
  assert.equal(quote.total,5760);
  assert.equal(quote.appliedBundles[0].name,'Combo Neon');

  // A faixa progressiva de 3 itens deve substituir a faixa de 2 itens.
  setCart(store,userId,[{productId:'polo',quantity:2},{productId:'manguito',quantity:1}]);
  const tierQuote=quoteCart(store,userId,member,products,'',5);
  assert.equal(tierQuote.bundleDiscount,1560);

  addNotification(store,userId,{type:'test',title:'Olá',text:'Teste',href:'/account'});
  let notifications=notificationsFor(store,userId);
  assert.equal(notifications.length,1);
  assert.equal(notifications[0].read,false);
  notifications=markNotification(store,userId,notifications[0].id,true);
  assert.equal(notifications[0].read,true);
});

test('Commerce Suite missions can be completed without XP rewards', (t) => {
  const dir=mkdtempSync(join(tmpdir(),'studio-k-mission-'));
  const store=openStore(dir);
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
  const userId='333333333333333333';
  store.set(`portfolio:favorites:${userId}`,{items:[],products:['a','b','c']});
  const mission=upsertCommerce(store,'missions',{
    title:'Favoritos',description:'Salve três peças',type:'favorite_products',target:3,targetId:'',active:true,startsAt:'',endsAt:''
  });
  const progress=missionProgress(store,userId,{inGuild:true},mission);
  assert.equal(progress.complete,true);
  const claimed=claimMission(store,userId,{inGuild:true},mission.id);
  assert.equal(claimed.claimed,true);
  assert.equal('xp' in claimed,false);
  assert.equal(store.get(`portfolio:xp-bonus:${userId}`,0),0);
  assert.throws(()=>claimMission(store,userId,{inGuild:true},mission.id));
});

test('Recommendations rank related products and limited stock reaches zero', (t) => {
  const dir=mkdtempSync(join(tmpdir(),'studio-k-reco-'));
  const store=openStore(dir);
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
  const userId='444444444444444444';
  const products=[
    {id:'a',name:'A',published:true,category:'Neon',tags:['glow'],stockMode:'unlimited'},
    {id:'b',name:'B',published:true,category:'Neon',tags:['glow'],stockMode:'unlimited'},
    {id:'c',name:'C',published:true,category:'Street',tags:['black'],stockMode:'unlimited'}
  ];
  store.set(`portfolio:favorites:${userId}`,{items:[],products:['b']});
  const recommendations=recommendationsFor(store,userId,products,'a',3);
  assert.equal(recommendations[0].productId,'b');

  const now=store.now();
  store.run('INSERT INTO products(id,data,created) VALUES(?,?,?)','bot-limit',JSON.stringify({name:'Limitado',description:'',priceCents:1000,type:'service',roleId:'',active:true,image:'',delivery:'',category:'Geral'}),now);
  store.run('INSERT INTO orders(id,user_id,product_id,product,price,status,created,expires) VALUES(?,?,?,?,?,?,?,?)','o1',userId,'bot-limit',JSON.stringify({name:'Limitado'}),1000,'paid',now,new Date(Date.now()+3600000).toISOString());
  store.run('INSERT INTO orders(id,user_id,product_id,product,price,status,created,expires) VALUES(?,?,?,?,?,?,?,?)','o2',userId,'bot-limit',JSON.stringify({name:'Limitado'}),1000,'delivered',now,new Date(Date.now()+3600000).toISOString());
  const availability=productAvailability(store,{botProductId:'bot-limit',stockMode:'limited',stockLimit:2});
  assert.equal(availability.remaining,0);
  assert.equal(availability.available,false);
});


test('Cart quote applies active drops and automatic combo gifts', (t) => {
  const dir=mkdtempSync(join(tmpdir(),'studio-k-drop-gift-'));
  const store=openStore(dir);
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});

  const products=[
    {id:'a',name:'Produto A',priceCents:5000,published:true,category:'Neon',tags:[],stockMode:'unlimited'},
    {id:'b',name:'Produto B',priceCents:3000,published:true,category:'Neon',tags:[],stockMode:'unlimited'},
    {id:'gift',name:'Brinde',priceCents:2000,published:true,category:'Extra',tags:[],stockMode:'unlimited'}
  ];
  const now=Date.now();
  store.set('portfolio:drops',[{
    id:'drop-a',title:'Drop A',productId:'a',discountPercent:20,
    startsAt:new Date(now-60000).toISOString(),endsAt:new Date(now+3600000).toISOString(),published:true
  }]);
  upsertCommerce(store,'bundles',{
    name:'A+B com brinde',description:'',productIds:['a','b'],minItems:2,
    discountType:'percent',discountValue:10,tiers:[],giftProductId:'gift',active:true
  });
  const userId='555555555555555555';
  setCart(store,userId,[{productId:'a',quantity:1},{productId:'b',quantity:1}]);
  const quote=quoteCart(store,userId,{roles:[]},products,'',0);

  const productA=quote.items.find(item=>item.productId==='a');
  const gift=quote.items.find(item=>item.productId==='gift');
  assert.equal(productA?.dropPercent,20);
  assert.equal(productA?.unitPrice,4000);
  assert.equal(gift?.gift,true);
  assert.equal(gift?.unitPrice,0);
  assert.equal(quote.appliedBundles[0].giftProductId,'gift');
  assert.equal(quote.bundleDiscount,700);
  assert.equal(quote.total,6300);
});
