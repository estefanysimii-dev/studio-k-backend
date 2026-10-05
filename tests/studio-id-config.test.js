import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/store.js';
import { studioIdConfig, saveStudioIdConfig, studioIdProfile } from '../server/studio-id.js';

test('Studio K ID keeps account identity without gamification systems', (t) => {
  const dir=mkdtempSync(join(tmpdir(),'studio-id-config-'));
  const store=openStore(dir);
  t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});

  const initial=studioIdConfig(store);
  for(const key of ['xp','levelStep','ranks','discordRankSync','badges','features']){
    assert.equal(key in initial,false);
  }

  const next=saveStudioIdConfig(store,{
    ...initial,
    earlyMemberLimit:100,
    thresholds:{collectorPurchases:4},
    supporterRolePattern:'supporter|vip'
  });

  assert.equal(next.earlyMemberLimit,100);
  assert.equal(next.thresholds.collectorPurchases,4);
  assert.equal(next.supporterRolePattern,'supporter|vip');
  assert.deepEqual(studioIdConfig(store),next);

  const userId='identity-test-user';
  store.set(`portfolio:favorites:${userId}`,{items:['look-1'],products:['product-1']});
  const profile=studioIdProfile(store,userId,{inGuild:false,roles:[]});
  for(const key of ['xp','level','rank','badges','achievements','perks']){
    assert.equal(key in profile,false);
  }
  assert.equal(profile.studioId.startsWith('SK-'),true);
  assert.equal(profile.equippedTitle.id,'member');
  assert.equal(Array.isArray(profile.titles),true);
  assert.equal(profile.favorites.items.includes('look-1'),true);
});
