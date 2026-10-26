import { createHash } from 'node:crypto';
import { francAll } from 'franc-min';
import { AppError } from './store.js';
import { normalizeLanguage, splitTranslationText } from './translation-utils.js';

const MODEL='@cf/meta/m2m100-1.2b';
const iso3To1={por:'pt',eng:'en',spa:'es',fra:'fr',deu:'de',ita:'it',jpn:'ja',kor:'ko',cmn:'zh',rus:'ru'};
const m2mLanguage=value=>normalizeLanguage(value)==='zh-CN'?'zh':normalizeLanguage(value);
const decode=value=>String(value).replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');

export function detectTranslationLanguage(text){
  // Detection stays local. Short or ambiguous samples must not silently default to English.
  const sample=String(text||'').replace(/[^\p{L}\p{M}\s]/gu,' ').trim();
  if([...sample.replace(/\s/g,'')].length<20)throw new AppError('Texto curto demais para identificar o idioma. Use uma mensagem mais completa.',422);
  const candidates=francAll(sample,{only:Object.keys(iso3To1),minLength:20});
  const [best,next]=candidates;
  if(!best||!iso3To1[best[0]]||(next&&best[1]-next[1]<0.04))throw new AppError('Não foi possível identificar o idioma desta mensagem. A tradução não foi enviada.',422);
  return iso3To1[best[0]];
}

function chunks(text,max=240){
  const points=Array.from(text),result=[];
  while(points.length>max){
    let cut=max;for(let i=max;i>max/2;i--)if(/\s/.test(points[i])){cut=i+1;break;}
    result.push(points.splice(0,cut).join(''));
  }
  if(points.length)result.push(points.join(''));return result;
}

export function createTranslator({store,env=process.env,fetchImpl=fetch}){
  const provider=String(env.TRANSLATION_PROVIDER||(env.LIBRETRANSLATE_URL?'libretranslate':'')).trim().toLowerCase();
  const account=String(env.CLOUDFLARE_ACCOUNT_ID||'').trim(),token=String(env.CLOUDFLARE_API_TOKEN||'').trim();
  let libreUrl='';
  try{const u=new URL(String(env.LIBRETRANSLATE_URL||''));if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash&&!u.hostname.endsWith('.railway.internal'))libreUrl=u.href.replace(/\/$/,'');}catch{}
  const configured=provider==='cloudflare'?/^[a-f0-9]{32}$/i.test(account)&&!!token:provider==='libretranslate'&&!!libreUrl;
  const ready=()=>!!(store.settings().translator?.enabled&&configured);
  const cacheIdentity=provider==='cloudflare'?`${provider}:${MODEL}:${account}`:`${provider}:${libreUrl}`;
  const active=new Map();

  async function request(url,body,headers={}){
    let response;
    try{response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(8000),redirect:'error'});}
    catch{throw new AppError('O serviço de tradução não respondeu. A mensagem original foi preservada.',503);}
    if(response.status===429||response.status===403)throw new AppError('A tradução atingiu o limite ou o acesso não foi liberado. A mensagem original foi preservada.',503);
    if(!response.ok)throw new AppError('Não foi possível traduzir esta mensagem agora.',502);
    try{return await response.json();}catch{throw new AppError('O serviço de tradução retornou uma resposta inválida.',502);}
  }

  async function run(values,target,sourceLanguage){
    const source=values.map(v=>String(v||'')),language=m2mLanguage(target);
    if(!source.some(Boolean))return source;
    if(!ready())throw new AppError('O tradutor ainda não foi configurado no servidor.',503);
    const split=source.map(splitTranslationText),parts=[];
    for(const segments of split)for(const segment of segments)if(!segment.protected&&segment.text.trim())parts.push(segment);
    if(!parts.length)return source;
    if(source.reduce((sum,text)=>sum+text.length,0)>12000)throw new AppError('Esta mensagem é grande demais para a tradução.',413);
    const sourceCode=sourceLanguage==='auto'?'auto':m2mLanguage(sourceLanguage);
    const from=provider==='cloudflare'&&sourceCode==='auto'?detectTranslationLanguage(parts.map(p=>p.text).join('\n')):sourceCode;
    if(from===language)return source;
    const key='translate:v3:'+createHash('sha256').update(cacheIdentity+'\n'+from+'\n'+language+'\n'+JSON.stringify(source)).digest('hex');
    const cached=store.get(key);
    if(Array.isArray(cached?.values)&&cached.values.length===source.length&&cached.values.every(v=>typeof v==='string')&&Date.now()-Number(cached.created||0)<7*86400000)return cached.values;
    if(active.has(key))return active.get(key);
    const promise=(async()=>{
      const trims=parts.map(part=>{const [,before,text,after]=part.text.match(/^(\s*)([\s\S]*?)(\s*)$/);return{before,text,after};});
      let results;
      if(provider==='libretranslate'){
        const data=await request(`${libreUrl}/translate`,{q:trims.map(p=>p.text),source:from,target:language==='zh'?'zh-Hans':language,format:'text',...(env.LIBRETRANSLATE_API_KEY?{api_key:env.LIBRETRANSLATE_API_KEY}:{})});
        results=Array.isArray(data.translatedText)?data.translatedText:typeof data.translatedText==='string'?[data.translatedText]:[];
      }else{
        const deadline=Date.now()+20000;
        // Two requests at a time; no paid overflow or automatic switch to another processor.
        const jobs=trims.map(part=>async()=>{
          const output=[];
          for(const chunk of chunks(part.text)){
            if(Date.now()>deadline)throw new AppError('A tradução demorou além do esperado. Tente uma mensagem menor.',503);
            const [,before,text,after]=chunk.match(/^(\s*)([\s\S]*?)(\s*)$/);
            const data=await request(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MODEL}`,{text,source_lang:from,target_lang:language},{Authorization:`Bearer ${token}`});
            if(data.success!==true||typeof data.result?.translated_text!=='string'||!data.result.translated_text.trim())throw new AppError('O Cloudflare não retornou uma tradução válida.',502);
            output.push(before+data.result.translated_text.trim()+after);
          }
          return output.join('');
        });
        results=new Array(jobs.length);let cursor=0,failed=false;
        const worker=async()=>{while(!failed&&cursor<jobs.length){const i=cursor++;try{results[i]=await jobs[i]();}catch(error){failed=true;throw error;}}};
        const settled=await Promise.allSettled([worker(),worker()]);
        const failure=settled.find(result=>result.status==='rejected');if(failure)throw failure.reason;
      }
      if(results.length!==parts.length||results.some(text=>typeof text!=='string'||!text.trim()))throw new AppError('O serviço não traduziu todas as partes da mensagem.',502);
      parts.forEach((part,index)=>part.text=trims[index].before+decode(results[index]).trim()+trims[index].after);
      const translated=split.map(segments=>segments.map(part=>part.text).join(''));
      store.set(key,{values:translated,created:Date.now()});return translated;
    })();
    active.set(key,promise);try{return await promise;}finally{active.delete(key);}
  }

  const status=()=>({configured:!!configured,enabled:!!store.settings().translator?.enabled,ready:ready(),provider:provider==='cloudflare'?'Cloudflare Workers AI':provider==='libretranslate'?'LibreTranslate':''});
  return{provider,ready,status,translateTexts:(values,target,{sourceLanguage='auto'}={})=>run(values,target,sourceLanguage)};
}
