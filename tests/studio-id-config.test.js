import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/store.js';
import { studioIdConfig, saveStudioIdConfig, studioIdProfile } from '../server/studio-id.js';

test('Studio K ID profile titles are granted only by Discord roles', (t) => {
  const dir=mkdtempSync(join(tmpdir(),'studio-id-title-role-'));
  const store=openStore(dir);
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});

  const initial=studioIdConfig(store);
  assert.equal(initial.defaultTitle.label,'Studio K Member');
  assert.deepEqual(initial.titles,[]);

  const vipRole='123456789012345678';
  const creatorRole='223456789012345678';
  const next=saveStudioIdConfig(store,{
    enabled:true,
    defaultTitle:{label:'Studio K Member',description:'Título padrão.'},
    titles:[
      {id:'vip',label:'VIP Studio K',description:'Título VIP.',roleId:vipRole,enabled:true},
      {id:'creator',label:'Creator Studio K',description:'Título Creator.',roleId:creatorRole,enabled:true}
    ]
  });

  assert.equal(next.titles.length,2);
  assert.equal(next.titles[0].roleId,vipRole);
  assert.deepEqual(studioIdConfig(store),next);

  const userId='identity-test-user';
  const noRoleProfile=studioIdProfile(store,userId,{inGuild:true,roles:[]});
  assert.deepEqual(noRoleProfile.titles.map((item)=>item.id),['member']);
  assert.equal(noRoleProfile.equippedTitle.id,'member');

  const vipProfile=studioIdProfile(store,userId,{
    inGuild:true,
    roles:[{id:vipRole,name:'Clientes VIP'}]
  });
  assert.deepEqual(vipProfile.titles.map((item)=>item.id),['member','vip']);
  assert.equal(vipProfile.titles[1].roleName,'Clientes VIP');

  store.set(`portfolio:profile-prefs:${userId}`,{equippedTitleId:'vip'});
  const equipped=studioIdProfile(store,userId,{
    inGuild:true,
    roles:[{id:vipRole,name:'Clientes VIP'}]
  });
  assert.equal(equipped.equippedTitle.id,'vip');

  const roleRemoved=studioIdProfile(store,userId,{inGuild:true,roles:[]});
  assert.equal(roleRemoved.equippedTitle.id,'member');
  assert.equal(store.get(`portfolio:profile-prefs:${userId}`).equippedTitleId,'member');
});

test('Studio K ID rejects duplicate Discord role mappings', (t) => {
  const dir=mkdtempSync(join(tmpdir(),'studio-id-title-duplicate-'));
  const store=openStore(dir);
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});

  const roleId='323456789012345678';
  assert.throws(()=>saveStudioIdConfig(store,{
    enabled:true,
    defaultTitle:{label:'Studio K Member',description:''},
    titles:[
      {id:'one',label:'Título 1',description:'',roleId,enabled:true},
      {id:'two',label:'Título 2',description:'',roleId,enabled:true}
    ]
  }));
});
