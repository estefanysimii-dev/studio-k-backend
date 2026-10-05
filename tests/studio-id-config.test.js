import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/store.js';
import { studioIdConfig, saveStudioIdConfig, studioIdProfile } from '../server/studio-id.js';

test('Studio K ID keeps account identity without XP, levels or ranks', (t) => {
  const dir=mkdtempSync(join(tmpdir(),'studio-id-config-'));
  const store=openStore(dir);
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});

  const initial=studioIdConfig(store);
  assert.equal('xp' in initial,false);
  assert.equal('levelStep' in initial,false);
  assert.equal('ranks' in initial,false);
  assert.equal('discordRankSync' in initial,false);

  const next=saveStudioIdConfig(store,{
    ...initial,
    earlyMemberLimit:100,
    badges:[
      ...initial.badges,
      {id:'favorite-fan',label:'Favorite Fan',icon:'♡',rarity:'rare',description:'Salvou dois favoritos.',condition:'favorites',value:2,enabled:true}
    ]
  });

  assert.equal(next.earlyMemberLimit,100);
  assert.equal('ranks' in next,false);
  assert.equal('discordRankSync' in next,false);
  assert.equal(next.badges.at(-1).id,'favorite-fan');
  assert.deepEqual(studioIdConfig(store),next);

  const userId='badge-test-user';
  store.set(`portfolio:favorites:${userId}`,{items:['look-1'],products:['product-1']});
  const profile=studioIdProfile(store,userId,{inGuild:false,roles:[]});
  assert.equal('xp' in profile,false);
  assert.equal('level' in profile,false);
  assert.equal('rank' in profile,false);
  assert.equal(profile.badges.some((badge)=>badge.id==='favorite-fan'),true);
});
