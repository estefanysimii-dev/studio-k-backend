import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { radioSchema, defaultRadio, normalizeRadio, radioSnapshot } from '../server/radio.js';
import { openStore } from '../server/store.js';

const tracks=[{title:'A',url:'https://audio.example/a.mp3',duration:100},{title:'B',url:'https://audio.example/b.mp3',duration:200}];
test('scheduled listeners share an epoch and resume at live position across loop boundaries',()=>{
  const radio=normalizeRadio({...defaultRadio,enabled:true,source:'schedule',tracks},defaultRadio,100000);
  assert.deepEqual(radioSnapshot(radio,250000).live,{index:1,positionSeconds:50});
  assert.deepEqual(radioSnapshot(radio,400000).live,{index:0,positionSeconds:0});
  assert.deepEqual(radioSnapshot(radio,401250).live,{index:0,positionSeconds:1.25});
  assert.deepEqual(radioSnapshot(radio,200000).live,{index:1,positionSeconds:0});
  assert.deepEqual(radioSnapshot(radio,250000).live,radioSnapshot(radio,250000).live);
});
test('cosmetic edits and enable toggles preserve epoch; source changes reset it server-side',()=>{
  const radio=normalizeRadio({...defaultRadio,source:'schedule',tracks},defaultRadio,100000);
  assert.equal(normalizeRadio({...radio,name:'Outro nome',epochMs:4,enabled:true},radio,500000).epochMs,100000);
  assert.equal(normalizeRadio({...radio,tracks:tracks.slice(0,1)},radio,500000).epochMs,500000);
});
test('schema rejects malformed sources, invalid durations and active empty programming',()=>{
  for(const patch of [{enabled:true},{source:'schedule',enabled:true},{streamUrl:'javascript:alert(1)'},{spotifyUrl:'https://evil.example/playlist/x'},{tracks:[{...tracks[0],duration:0}]},{tracks:[{...tracks[0],duration:Infinity}]},{analyze:'true'},{defaultVolume:2}]) {
    assert.equal(radioSchema.safeParse({...defaultRadio,...patch}).success,false);
  }
  assert.equal(radioSchema.safeParse({...defaultRadio,enabled:true,spotifyUrl:'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x'}).success,true);
  assert.equal(radioSnapshot({...defaultRadio,source:'spotify',analyze:true}).capabilities.spectrum,false);
  assert.equal(radioSnapshot(defaultRadio).capabilities.synchronized,false);
});
test('radio settings and common epoch survive SQLite reopen',()=>{
  const dir=mkdtempSync(join(tmpdir(),'studio-radio-'));
  try {
    let store=openStore(dir);
    const radio=normalizeRadio({...defaultRadio,source:'schedule',enabled:true,tracks},defaultRadio,100000);
    store.set('portfolio:site',{brandName:'Studio K',radio}); store.db.close();
    store=openStore(dir);
    assert.deepEqual(store.get('portfolio:site').radio,radio);
    assert.equal(radioSnapshot(store.get('portfolio:site').radio,250000).live.index,1);
    store.db.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
