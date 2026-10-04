import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/store.js';
import { studioIdConfig, saveStudioIdConfig, studioIdProfile } from '../server/studio-id.js';

test('Studio K ID control configuration persists validated progression rules', (t) => {
  const dir=mkdtempSync(join(tmpdir(),'studio-id-config-'));
  const store=openStore(dir);
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});

  const initial=studioIdConfig(store);
  assert.equal(initial.levelStep,300);
  assert.equal(initial.discordRankSync.enabled,false);

  const next=saveStudioIdConfig(store,{
    ...initial,
    levelStep:400,
    earlyMemberLimit:100,
    xp:{...initial.xp,purchase:350,favorite:25},
    badges:[
      ...initial.badges,
      {id:'favorite-fan',label:'Favorite Fan',icon:'♡',rarity:'rare',description:'Salvou dois favoritos.',condition:'favorites',value:2,enabled:true}
    ],
    discordRankSync:{...initial.discordRankSync,enabled:true}
  });

  assert.equal(next.levelStep,400);
  assert.equal(next.earlyMemberLimit,100);
  assert.equal(next.xp.purchase,350);
  assert.equal(next.xp.favorite,25);
  assert.equal(next.discordRankSync.enabled,true);
  assert.equal(next.badges.at(-1).id,'favorite-fan');
  assert.deepEqual(studioIdConfig(store),next);

  const userId='badge-test-user';
  store.set(`portfolio:favorites:${userId}`,{items:['look-1'],products:['product-1']});
  const profile=studioIdProfile(store,userId,{inGuild:false,roles:[]});
  assert.equal(profile.badges.some((badge)=>badge.id==='favorite-fan'),true);
});
