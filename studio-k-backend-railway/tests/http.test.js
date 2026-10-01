import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
test('HTTP access, CSRF, persistence, sales and disconnected Discord behavior',async t=>{
  const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const dir=mkdtempSync(join(tmpdir(),'studio-k-http-')),origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['server/index.js'],{cwd:resolve('.'),env:{...process.env,STUDIO_DEMO:'false',HOST:'127.0.0.1',PORT:String(port),PUBLIC_URL:origin,COOKIE_SECURE:'false',DATA_DIR:dir,DISCORD_TOKEN:'',DISCORD_GUILD_ID:'',INTEGRATION_KEY:''},stdio:'pipe'});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  t.after(async()=>{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));rmSync(dir,{recursive:true,force:true});});
  let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(origin+'/api/auth');if(r.ok){ready=true;break;}}catch{}await delay(50);}assert.ok(ready,output);
  const request=(path,method='GET',body,headers={})=>fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await request('/state')).status,401);
  assert.equal((await request('/setup','POST',{password:'local-test-password'},{Origin:'https://foreign.example'})).status,403);
  const setup=await request('/setup','POST',{password:'local-test-password'},{Origin:origin});assert.equal(setup.status,200);const csrf=(await setup.json()).csrf,cookie=setup.headers.get('set-cookie').split(';')[0],headers={Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf};
  assert.equal((await request('/setup','POST',{password:'another-password'},{Origin:origin})).status,409);
  let state=await(await request('/state','GET',undefined,headers)).json();assert.equal(state.demo,false);assert.equal(state.products.length,0);assert.equal(state.settings.welcome.embed.fields.length,0);
  assert.equal((await request('/settings','PUT',state.settings,{Origin:origin,Cookie:cookie})).status,403);
  state.settings.brand.name='Studio Teste';assert.equal((await request('/settings','PUT',state.settings,headers)).status,200);
  const product=await request('/products','POST',{name:'Licença teste',priceCents:5000,type:'digital'},headers);assert.equal(product.status,200);const pid=(await product.json()).id;
  assert.equal((await request(`/products/${pid}/stock`,'POST',{items:['SECRET-HTTP-TEST']},headers)).status,200);
  state=await(await request('/state','GET',undefined,headers)).json();assert.equal(state.products[0].stock,1);assert.ok(!JSON.stringify(state).includes('SECRET-HTTP-TEST'));
  const msg=await request('/messages','POST',{target:'channel',targetId:'123456789012345678',content:'Teste'},headers);assert.equal(msg.status,503);
  assert.equal((await request('/integrations/message','POST',{})).status,401);
  const settingsSaved=(await(await request('/state','GET',undefined,headers)).json()).settings;assert.equal(settingsSaved.brand.name,'Studio Teste');
  const backup=await request('/backups','POST',{},headers);assert.equal(backup.status,200);const name=(await backup.json()).name;
  assert.equal((await request(`/backups/${name}.json`,'GET',undefined,headers)).status,200);
  assert.equal((await request('/logout','POST',{},headers)).status,200);assert.equal((await request('/state','GET',undefined,headers)).status,401);
  const badLogin=await request('/login','POST',{password:'wrong'},{Origin:origin});assert.equal(badLogin.status,401);
  const goodLogin=await request('/login','POST',{password:'local-test-password'},{Origin:origin});assert.equal(goodLogin.status,200);
});


test('remote first setup requires the hosting setup key',async t=>{
  const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const dir=mkdtempSync(join(tmpdir(),'studio-k-remote-http-')),origin=`http://127.0.0.1:${port}`,setupKey='0123456789abcdef0123456789abcdef';
  const child=spawn(process.execPath,['server/index.js'],{cwd:resolve('.'),env:{...process.env,STUDIO_DEMO:'false',HOST:'0.0.0.0',PORT:String(port),PUBLIC_URL:origin,COOKIE_SECURE:'false',DATA_DIR:dir,DISCORD_TOKEN:'',DISCORD_GUILD_ID:'',INTEGRATION_KEY:'',SETUP_KEY:setupKey},stdio:'pipe'});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  t.after(async()=>{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));rmSync(dir,{recursive:true,force:true});});
  let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(origin+'/api/auth');if(r.ok){ready=true;break;}}catch{}await delay(50);}assert.ok(ready,output);
  const post=(key)=>fetch(origin+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(key?{'X-Setup-Key':key}:{})},body:JSON.stringify({password:'remote-test-password'})});
  assert.equal((await post()).status,403);
  assert.equal((await post('wrong-key')).status,403);
  assert.equal((await post(setupKey)).status,200);
});
