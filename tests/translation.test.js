import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator,detectTranslationLanguage } from '../server/translation.js';

const account='a'.repeat(32),token='fixture-token-not-a-real-credential';
const cloudflare={TRANSLATION_PROVIDER:'cloudflare',CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:token};
function store(enabled=true){const data=new Map();return{settings:()=>({translator:{enabled}}),get:key=>data.get(key),set:(key,value)=>data.set(key,value),data};}
function cloudResponse(text){return Response.json({success:true,result:{translated_text:text},errors:[],messages:[]});}

test('translation readiness requires an enabled setting and complete explicit provider config',()=>{
  for(const env of [{},{TRANSLATION_PROVIDER:'cloudflare'},{...cloudflare,CLOUDFLARE_API_TOKEN:''},{...cloudflare,CLOUDFLARE_ACCOUNT_ID:'wrong'},{LIBRETRANSLATE_URL:'http://libretranslate.railway.internal:5000'},{TRANSLATION_PROVIDER:'libretranslate'}])assert.equal(createTranslator({store:store(),env}).ready(),false);
  assert.equal(createTranslator({store:store(false),env:cloudflare}).ready(),false);
  assert.equal(createTranslator({store:store(),env:cloudflare}).ready(),true);
  const report=createTranslator({store:store(false),env:cloudflare}).status();assert.deepEqual(report,{configured:true,enabled:false,ready:false,provider:'Cloudflare Workers AI'});assert.ok(!JSON.stringify(report).includes(token));
  assert.equal(createTranslator({store:store(),env:{LIBRETRANSLATE_URL:'http://libretranslate:5000'}}).ready(),true);
});

test('Cloudflare uses the official model endpoint and preserves URLs, mentions, code, IDs and whitespace',async()=>{
  const calls=[],s=store(),translator=createTranslator({store:s,env:cloudflare,fetchImpl:async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return cloudResponse(JSON.parse(options.body).text.toUpperCase());}});
  const original='Olá <@123456789012345678> veja https://example.com/private e `SECRET-CODE` ```js\nconst x=1;\n``` <t:1792900000:R> cliente@example.com abcdefghijklmnop.';
  const [translated]=await translator.translateTexts([original],'en',{sourceLanguage:'pt'});
  assert.equal(translated,'OLÁ <@123456789012345678> VEJA https://example.com/private E `SECRET-CODE` ```js\nconst x=1;\n``` <t:1792900000:R> cliente@example.com abcdefghijklmnop.');
  assert.ok(calls.length>0);
  for(const call of calls){assert.equal(call.url,`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/meta/m2m100-1.2b`);assert.equal(call.options.headers.Authorization,`Bearer ${token}`);assert.equal(call.body.source_lang,'pt');assert.equal(call.body.target_lang,'en');assert.ok(!JSON.stringify(call.body).includes('SECRET-CODE'));assert.ok(!JSON.stringify(call.body).includes('example.com'));}
  assert.ok(!JSON.stringify([...s.data]).includes(token));
});

test('generated Portuguese text can be short and same-language text makes no inference call',async()=>{
  let calls=0;const t=createTranslator({store:store(),env:cloudflare,fetchImpl:async()=>{calls++;return cloudResponse('Hello');}});
  assert.deepEqual(await t.translateTexts(['Olá'],'en',{sourceLanguage:'pt'}),['Hello']);
  assert.deepEqual(await t.translateTexts(['Olá'],'pt',{sourceLanguage:'pt'}),['Olá']);assert.equal(calls,1);
});

test('arbitrary English is detected locally and can translate back to Portuguese',async()=>{
  let body;const t=createTranslator({store:store(),env:cloudflare,fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return cloudResponse('Esta mensagem foi traduzida.');}});
  const [result]=await t.translateTexts(['This message was written in English and should be translated into Portuguese.'],'pt');
  assert.equal(body.source_lang,'en');assert.equal(body.target_lang,'pt');assert.equal(result,'Esta mensagem foi traduzida.');
  assert.equal(detectTranslationLanguage('Este texto foi escrito em português para falar com todos os clientes.'),'pt');
  assert.equal(detectTranslationLanguage('Este mensaje está escrito en español y debe traducirse para todos los clientes.'),'es');
});

test('short or indeterminate arbitrary text is rejected before any third-party request',async()=>{
  let calls=0;const t=createTranslator({store:store(),env:cloudflare,fetchImpl:async()=>{calls++;return cloudResponse('wrong');}});
  await assert.rejects(t.translateTexts(['Olá'],'en'),error=>error.status===422);
  assert.throws(()=>detectTranslationLanguage('12345678901234567890'),error=>error.status===422);assert.equal(calls,0);
});

test('seven-day cache and in-flight reuse avoid repeated inference; provider/source changes do not share cache',async()=>{
  const s=store();let cloudCalls=0,libreCalls=0;
  const t=createTranslator({store:s,env:cloudflare,fetchImpl:async()=>{cloudCalls++;return cloudResponse('Hello');}});
  const results=await Promise.all([t.translateTexts(['Olá'],'en',{sourceLanguage:'pt'}),t.translateTexts(['Olá'],'en',{sourceLanguage:'pt'})]);assert.deepEqual(results,[['Hello'],['Hello']]);assert.equal(cloudCalls,1);
  await t.translateTexts(['Olá'],'en',{sourceLanguage:'pt'});assert.equal(cloudCalls,1);
  const libre=createTranslator({store:s,env:{TRANSLATION_PROVIDER:'libretranslate',LIBRETRANSLATE_URL:'http://translator:5000'},fetchImpl:async()=>{libreCalls++;return Response.json({translatedText:['Hello from Libre']});}});
  assert.deepEqual(await libre.translateTexts(['Olá'],'en'),['Hello from Libre']);assert.equal(libreCalls,1);
  for(const value of s.data.values())value.created=Date.now()-8*86400000;
  await t.translateTexts(['Olá'],'en',{sourceLanguage:'pt'});assert.equal(cloudCalls,2);
});

test('Cloudflare quota, network and malformed results do not poison cache or leak provider errors',async()=>{
  for(const mock of [async()=>new Response(JSON.stringify({error:token}),{status:429}),async()=>{throw new Error(token);},async()=>Response.json({success:true,result:{}})]){
    const s=store(),t=createTranslator({store:s,env:cloudflare,fetchImpl:mock});
    await assert.rejects(t.translateTexts(['Olá'],'en',{sourceLanguage:'pt'}),error=>!error.message.includes(token));assert.equal(s.data.size,0);
  }
});

test('long text is chunked with bounded concurrency and Chinese maps to the model language code',async()=>{
  let active=0,maxActive=0;const calls=[],t=createTranslator({store:store(),env:cloudflare,fetchImpl:async(url,options)=>{active++;maxActive=Math.max(maxActive,active);const body=JSON.parse(options.body);calls.push(body);await new Promise(r=>setTimeout(r,2));active--;return cloudResponse(body.text);}});
  const original='Mensagem de teste para os nossos clientes. '.repeat(18);
  assert.deepEqual(await t.translateTexts([original,original],'zh-CN',{sourceLanguage:'pt'}),[original,original]);
  assert.ok(calls.length>2);assert.ok(calls.every(body=>Array.from(body.text).length<=240&&body.target_lang==='zh'));assert.ok(maxActive<=2);
});

test('explicit LibreTranslate retains batch/auto support without any Railway fallback',async()=>{
  const calls=[],t=createTranslator({store:store(),env:{TRANSLATION_PROVIDER:'libretranslate',LIBRETRANSLATE_URL:'http://translator:5000',LIBRETRANSLATE_API_KEY:'fixture-libre'},fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json({translatedText:['Hello','See']});}});
  assert.deepEqual(await t.translateTexts(['Olá <@123456789012345678>','Veja'],'zh-CN'),['Hello <@123456789012345678>','See']);assert.equal(calls.length,1);assert.equal(calls[0].url,'http://translator:5000/translate');assert.deepEqual(calls[0].body,{q:['Olá','Veja'],source:'auto',target:'zh-Hans',format:'text',api_key:'fixture-libre'});
});
