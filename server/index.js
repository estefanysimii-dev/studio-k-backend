import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { openStore, AppError } from './store.js';
import { createBot } from './discord.js';
import { settingsSchema, productSchema, messageSchema, templateSchema, giveawaySchema, eventSchema, id } from './schema.js';
const demo=process.env.STUDIO_DEMO==='true',port=Number(process.env.PORT||3210),host=demo?'127.0.0.1':process.env.HOST||'127.0.0.1';
const base=new URL(process.env.PUBLIC_URL||`http://localhost:${port}`);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const store=openStore(process.env.DATA_DIR||join(root,'data')),bot=createBot(store);
const app=express(); app.disable('x-powered-by');
if(process.env.TRUST_PROXY){const value=Number(process.env.TRUST_PROXY);app.set('trust proxy',Number.isFinite(value)?value:process.env.TRUST_PROXY==='true');}
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","https://unpkg.com"],styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com"],fontSrc:["'self'","https://fonts.gstatic.com",'data:'],imgSrc:["'self'",'data:','https:','blob:'],mediaSrc:["'self'","https:",'blob:'],workerSrc:["'self'",'blob:'],connectSrc:["'self'"],upgradeInsecureRequests:process.env.COOKIE_SECURE==='true'?[]:null}},strictTransportSecurity:process.env.COOKIE_SECURE==='true'?undefined:false}));
app.use(express.json({limit:'10mb'}));
app.use('/api',(req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
app.use('/api',rateLimit({windowMs:60000,limit:200,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Muitas solicitações. Aguarde um minuto.'}}));
const loginLimit=rateLimit({windowMs:15*60000,limit:12,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Muitas tentativas. Aguarde 15 minutos.'}});
const hash=value=>createHash('sha256').update(value).digest('hex');
const setupKey=process.env.SETUP_KEY||'',setupKeyRequired=!demo&&host!=='127.0.0.1';
const cookieOptions={httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='true',path:'/',maxAge:12*3600000};
const oauthRedirect=new URL('/api/oauth/discord/callback',base).toString();
const googleRedirect=new URL('/api/oauth/google/callback',base).toString();
const oauthCookieOptions={httpOnly:true,sameSite:'lax',secure:process.env.COOKIE_SECURE==='true',path:'/api/oauth/discord',maxAge:10*60000};
const cookieValue=(req,name)=>(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith(name+'='))?.slice(name.length+1)||'';
const oauthPage=(title,message,ok=false,targetUrl='')=>{
  const fallback=`https://discord.com/channels/${encodeURIComponent(process.env.DISCORD_GUILD_ID||'')}`,href=targetUrl||fallback;
  const refresh=ok&&targetUrl?`<meta http-equiv="refresh" content="1.5;url=${htmlEscape(href)}">`:'';
  const buttonLabel=ok&&targetUrl?'Ir para o canal agora':'Voltar ao Discord';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>Studio K · ${title}</title><style>body{margin:0;background:#0d0c13;color:#f5f1ff;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;min-height:100vh;place-items:center}.card{width:min(620px,calc(100% - 36px));box-sizing:border-box;background:#17141f;border:1px solid #30283d;border-radius:18px;padding:28px;box-shadow:0 24px 70px #0006}.mark{width:54px;height:54px;border-radius:14px;background:#995cff;display:grid;place-items:center;font-weight:900;font-size:26px;margin-bottom:18px}.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#ad7cff;font-weight:800}h1{font-size:27px;margin:5px 0 10px}.ok{color:#75e6a4}.bad{color:#ff9aa9}p{color:#bdb5c9;margin:0}.button{display:inline-block;margin-top:22px;padding:11px 15px;border-radius:10px;background:#995cff;color:white;text-decoration:none;font-weight:800}.hint{margin-top:12px;font-size:12px;color:#8f879f}</style></head><body><main class="card"><div class="mark">K</div><div class="eyebrow">Studio K · Verificação</div><h1 class="${ok?'ok':'bad'}">${title}</h1><p>${message}</p><a class="button" href="${htmlEscape(href)}">${buttonLabel}</a>${ok&&targetUrl?'<p class="hint">Redirecionando para o canal liberado…</p>':''}</main></body></html>`;
};

function session(req){const raw=(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('studio_session='))?.slice(15);if(!raw)return null;return store.one('SELECT * FROM sessions WHERE id=? AND expires>?',hash(raw),Date.now());}
function newSession(res){const raw=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');store.run('DELETE FROM sessions WHERE expires<?',Date.now());store.run('INSERT INTO sessions VALUES(?,?,?)',hash(raw),csrf,Date.now()+12*3600000);res.cookie('studio_session',raw,cookieOptions);return csrf;}
function sameOrigin(req,res,next){
  const allowed=new Set([base.origin]);if(host==='127.0.0.1'){allowed.add(`http://127.0.0.1:${port}`);allowed.add(`http://localhost:${port}`);}
  if(!allowed.has(req.headers.origin))return res.status(403).json({error:'Origem não autorizada.'});next();
}
function portfolioSameOrigin(req,res,next){
  const allowed=new Set([base.origin,portfolioPublicOrigin.origin]);
  if(host==='127.0.0.1'){allowed.add(`http://127.0.0.1:${port}`);allowed.add(`http://localhost:${port}`);}
  if(!allowed.has(req.headers.origin))return res.status(403).json({error:'Origem não autorizada.'});
  next();
}
app.get('/healthz',(req,res)=>res.json({ok:true}));
app.get('/api/auth', (req,res)=>{const s=session(req);res.json({authenticated:!!s,csrf:s?.csrf||null,setup:!store.get('password'),setupKeyRequired,demo});});
app.get('/api/oauth/discord/start',(req,res)=>{
  const v=store.settings().verification,roles=[...(v.roleIds||[]),...(v.roleId?[v.roleId]:[])].filter(Boolean);
  if(!v.oauthEnabled)throw new AppError('A verificação OAuth ainda não está ativada.',400);
  if(!roles.length)throw new AppError('Configure ao menos um cargo da verificação antes de publicar o painel.',400);
  if(!process.env.DISCORD_CLIENT_ID||!process.env.DISCORD_CLIENT_SECRET)throw new AppError('OAuth do Discord ainda não está configurado no servidor.',503);
  const lang=String(req.query.lang||'pt').slice(0,10),state=randomBytes(32).toString('base64url');
  res.cookie('studio_oauth_state',state,oauthCookieOptions);
  res.cookie('studio_oauth_lang',lang,oauthCookieOptions);
  const params=new URLSearchParams({response_type:'code',client_id:process.env.DISCORD_CLIENT_ID,scope:'identify guilds.join',state,redirect_uri:oauthRedirect,prompt:'consent'});
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});
app.get('/api/oauth/discord/callback',async(req,res)=>{
  let accessToken='',portfolioFlow=false;
  try{
    const given=String(req.query.state||''),code=String(req.query.code||'');
    const portfolioState=given?store.get(`portfolio-oauth:${hash(given)}`):null;
    if(portfolioState){
      portfolioFlow=true;
      const expected=cookieValue(req,'studio_portfolio_oauth_state');
      res.clearCookie('studio_portfolio_oauth_state',{path:'/api/oauth/discord'});
      store.run('DELETE FROM kv WHERE key=?',`portfolio-oauth:${hash(given)}`);
      if(req.query.error)throw new AppError('A autorização do Discord foi cancelada.',400);
      if(!expected||!timingSafeEqual(Buffer.from(hash(expected)),Buffer.from(hash(given))))throw new AppError('A autorização expirou ou não corresponde a esta solicitação.',403);
      if(Number(portfolioState.expires||0)<Date.now())throw new AppError('A autorização expirou. Tente novamente.',403);
      if(!code)throw new AppError('O Discord não retornou o código de autorização.',400);
      if(!process.env.DISCORD_CLIENT_ID||!process.env.DISCORD_CLIENT_SECRET)throw new AppError('OAuth do Discord ainda não está configurado.',503);
      const tokenResponse=await fetch('https://discord.com/api/v10/oauth2/token',{
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:`Basic ${Buffer.from(`${process.env.DISCORD_CLIENT_ID}:${process.env.DISCORD_CLIENT_SECRET}`).toString('base64')}`},
        body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:oauthRedirect})
      });
      const token=await tokenResponse.json().catch(()=>({}));
      if(!tokenResponse.ok||!token.access_token)throw new AppError('Não foi possível concluir a autenticação com o Discord.',502);
      accessToken=token.access_token;
      const userResponse=await fetch('https://discord.com/api/v10/users/@me',{headers:{Authorization:`Bearer ${accessToken}`}});
      const user=await userResponse.json().catch(()=>({}));
      if(!userResponse.ok||!user.id)throw new AppError('Não foi possível identificar sua conta do Discord.',502);
      const member=await portfolioMember(user.id),avatar=user.avatar?`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`:(member.avatar||'');
      const sessionData={user:{id:user.id,username:user.username||'',name:user.global_name||member.name||user.username||user.id,avatar},member,created:Date.now(),expires:Date.now()+30*86400000};
      const handoffRaw=randomBytes(32).toString('base64url');
      store.set(`portfolio-handoff:${hash(handoffRaw)}`,{session:sessionData,next:portfolioState.next||'/portfolio/#account',expires:Date.now()+2*60000});
      const complete=new URL('/api/portfolio/oauth/complete',portfolioPublicOrigin);complete.searchParams.set('t',handoffRaw);
      res.redirect(complete.toString());
      return;
    }

    const expected=cookieValue(req,'studio_oauth_state'),language=String(cookieValue(req,'studio_oauth_lang')||'pt');
    res.clearCookie('studio_oauth_state',{path:'/api/oauth/discord'});
    res.clearCookie('studio_oauth_lang',{path:'/api/oauth/discord'});
    if(req.query.error)throw new AppError('A autorização foi cancelada ou recusada.',400);
    if(!expected||!given||!timingSafeEqual(Buffer.from(hash(expected)),Buffer.from(hash(given))))throw new AppError('A verificação expirou ou não corresponde a esta solicitação.',403);
    if(!code)throw new AppError('O Discord não retornou o código de autorização.',400);
    if(!process.env.DISCORD_CLIENT_ID||!process.env.DISCORD_CLIENT_SECRET)throw new AppError('OAuth do Discord ainda não está configurado.',503);

    const tokenResponse=await fetch('https://discord.com/api/v10/oauth2/token',{
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:`Basic ${Buffer.from(`${process.env.DISCORD_CLIENT_ID}:${process.env.DISCORD_CLIENT_SECRET}`).toString('base64')}`},
      body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:oauthRedirect})
    });
    const token=await tokenResponse.json().catch(()=>({}));
    if(!tokenResponse.ok||!token.access_token)throw new AppError('Não foi possível concluir a autorização com o Discord.',502);
    accessToken=token.access_token;

    const userResponse=await fetch('https://discord.com/api/v10/users/@me',{headers:{Authorization:`Bearer ${accessToken}`}});
    const user=await userResponse.json().catch(()=>({}));
    if(!userResponse.ok||!user.id)throw new AppError('Não foi possível identificar sua conta do Discord.',502);

    const recoveryScopes=String(token.scope||'').split(/\s+/).filter(Boolean);
    if(recoveryScopes.includes('guilds.join')&&token.refresh_token){
      const now=store.now(),username=String(user.global_name||user.username||user.id).slice(0,120);
      store.run('INSERT INTO member_recovery(user_id,username,refresh_secret,scopes,authorized_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,refresh_secret=excluded.refresh_secret,scopes=excluded.scopes,updated_at=excluded.updated_at',user.id,username,store.encrypt(token.refresh_token),recoveryScopes.join(' '),now,now);
    }
    const result=await bot.verifyOAuthUser(user,language);
    const settings=store.settings(),targetChannelId=settings.verification.redirectChannelId||settings.welcome.channelId||'';
    const targetUrl=targetChannelId?`https://discord.com/channels/${encodeURIComponent(process.env.DISCORD_GUILD_ID||'')}/${encodeURIComponent(targetChannelId)}`:'';
    res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
    res.type('html').send(oauthPage('Acesso liberado',`Conta <strong>${htmlEscape(result.username)}</strong> verificada com sucesso. Seu cargo de acesso já foi aplicado.${result.dmSent?' Também enviamos uma confirmação no seu privado.':''}`,true,targetUrl));
  }catch(e){
    res.status(e instanceof AppError?e.status:500);
    res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
    if(portfolioFlow){
      res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Studio K · Discord</title><style>body{margin:0;background:#06030b;color:#fff;font:15px/1.6 system-ui;display:grid;place-items:center;min-height:100vh}.c{width:min(560px,calc(100% - 36px));padding:28px;border:1px solid #7e39bd;border-radius:18px;background:#11091d}.c a{display:inline-block;margin-top:14px;padding:10px 14px;border-radius:10px;background:#8b2cff;color:#fff;text-decoration:none;font-weight:700}</style><div class="c"><h1>Não foi possível conectar</h1><p>${htmlEscape(e instanceof AppError?e.message:'Tente novamente.')}</p><a href="/portfolio/#account">Voltar ao Studio K</a></div>`);
    }else{
      res.type('html').send(oauthPage('Não foi possível verificar',htmlEscape(e instanceof AppError?e.message:'Tente novamente pelo botão de verificação no Discord.')));
    }
  }
});


const youtubePage=(title,message,ok=false,targetUrl='')=>{
  const href=targetUrl||`https://discord.com/channels/${encodeURIComponent(process.env.DISCORD_GUILD_ID||'')}`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio K · YouTube</title><style>body{margin:0;background:#0d0c13;color:#f5f1ff;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;min-height:100vh;place-items:center}.card{width:min(650px,calc(100% - 36px));box-sizing:border-box;background:#17141f;border:1px solid #30283d;border-radius:18px;padding:28px;box-shadow:0 24px 70px #0006}.mark{width:54px;height:54px;border-radius:14px;background:#995cff;display:grid;place-items:center;font-weight:900;font-size:26px;margin-bottom:18px}.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#ad7cff;font-weight:800}h1{font-size:27px;margin:5px 0 10px}.ok{color:#75e6a4}.bad{color:#ff9aa9}p{color:#bdb5c9}.button{display:inline-block;margin-top:18px;padding:11px 15px;border-radius:10px;background:#995cff;color:white;text-decoration:none;font-weight:800}</style></head><body><main class="card"><div class="mark">K</div><div class="eyebrow">Studio K · YouTube</div><h1 class="${ok?'ok':'bad'}">${title}</h1><p>${message}</p><a class="button" href="${htmlEscape(href)}">Voltar ao sorteio</a></main></body></html>`;
};
app.get('/api/oauth/google/start',(req,res)=>{
  if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)throw new AppError('A integração Google/YouTube ainda não foi configurada.',503);
  const raw=String(req.query.t||''),link=store.get(`google-link:${hash(raw)}`);
  if(!raw||!link||Number(link.expires)<Date.now())throw new AppError('Este link de conexão expirou. Volte ao Discord e clique em Verificar novamente.',403);
  store.run('DELETE FROM kv WHERE key=?',`google-link:${hash(raw)}`);
  const state=randomBytes(32).toString('base64url');
  store.set(`google-oauth:${hash(state)}`,{...link,expires:Date.now()+10*60000});
  const params=new URLSearchParams({
    client_id:process.env.GOOGLE_CLIENT_ID,
    redirect_uri:googleRedirect,
    response_type:'code',
    scope:'https://www.googleapis.com/auth/youtube.readonly',
    access_type:'offline',
    prompt:'consent',
    include_granted_scopes:'true',
    state
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});
app.get('/api/oauth/google/callback',async(req,res)=>{
  try{
    const state=String(req.query.state||''),link=store.get(`google-oauth:${hash(state)}`);
    store.run('DELETE FROM kv WHERE key=?',`google-oauth:${hash(state)}`);
    if(req.query.error)throw new AppError('A autorização do YouTube foi cancelada ou recusada.',400);
    if(!state||!link||Number(link.expires)<Date.now())throw new AppError('A conexão com o YouTube expirou. Volte ao sorteio e tente novamente.',403);
    const code=String(req.query.code||'');if(!code)throw new AppError('O Google não retornou o código de autorização.',400);
    const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,code,grant_type:'authorization_code',redirect_uri:googleRedirect})});
    const token=await tokenResponse.json().catch(()=>({}));
    if(!tokenResponse.ok||!token.access_token)throw new AppError('Não foi possível concluir a autorização do YouTube.',502);
    const existing=store.one('SELECT * FROM youtube_accounts WHERE user_id=?',link.userId);
    const refreshToken=token.refresh_token||(existing?store.decrypt(existing.refresh_secret):'');
    if(!refreshToken)throw new AppError('O Google não forneceu acesso renovável. Tente conectar novamente e confirme todas as permissões.',502);
    const channelResponse=await fetch('https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true',{headers:{Authorization:`Bearer ${token.access_token}`}});
    const channelData=await channelResponse.json().catch(()=>({})),yt=channelData.items?.[0];
    if(!channelResponse.ok||!yt?.id)throw new AppError('Não foi possível identificar o canal do YouTube desta conta.',502);
    const now=store.now();
    store.run('INSERT INTO youtube_accounts(user_id,channel_id,channel_title,refresh_secret,connected_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET channel_id=excluded.channel_id,channel_title=excluded.channel_title,refresh_secret=excluded.refresh_secret,updated_at=excluded.updated_at',link.userId,yt.id,String(yt.snippet?.title||yt.id).slice(0,200),store.encrypt(refreshToken),existing?.connected_at||now,now);
    const checked=await bot.evaluateGiveaway(link.giveawayId,link.userId,{enter:true,record:true});
    const giveaway=store.one('SELECT data FROM giveaways WHERE id=?',link.giveawayId),data=giveaway?JSON.parse(giveaway.data):null;
    const target=data?.channelId?`https://discord.com/channels/${encodeURIComponent(process.env.DISCORD_GUILD_ID||'')}/${encodeURIComponent(data.channelId)}`:'';
    res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
    res.type('html').send(youtubePage(checked.ok?'Participação confirmada':'YouTube conectado',checked.ok?'Sua conta do YouTube foi validada e todos os requisitos do sorteio estão concluídos.':'Sua conta do YouTube foi conectada. Volte ao Discord e veja quais requisitos ainda faltam.',true,target));
  }catch(e){
    res.status(e instanceof AppError?e.status:500);res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
    res.type('html').send(youtubePage('Não foi possível conectar',htmlEscape(e instanceof AppError?e.message:'Tente novamente pelo botão do sorteio.')));
  }
});

app.post('/api/setup',loginLimit,sameOrigin,(req,res)=>{
  if(demo)throw new AppError('Use a entrada de demonstração.');
  if(store.get('password'))throw new AppError('A senha já foi definida.',409);
  if(setupKeyRequired){
    const given=String(req.headers['x-setup-key']||'');
    if(setupKey.length<32||!timingSafeEqual(Buffer.from(hash(setupKey)),Buffer.from(hash(given))))throw new AppError('Chave de instalação inválida.',403);
  }else if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)){
    throw new AppError('Faça a primeira configuração no computador onde o bot está instalado.',403);
  }
  const password=z.string().min(12,'Use pelo menos 12 caracteres.').max(200).parse(req.body.password),salt=randomBytes(16).toString('hex');store.set('password',{salt,hash:scryptSync(password,salt,64).toString('hex')});res.json({csrf:newSession(res)});
});
app.post('/api/login',loginLimit,sameOrigin,(req,res)=>{
  if(demo){res.json({csrf:newSession(res)});return;}
  const saved=store.get('password');if(!saved)throw new AppError('Configure a senha primeiro.');
  const password=z.string().max(200).parse(req.body.password||'');const actual=scryptSync(password,saved.salt,64);
  if(!timingSafeEqual(actual,Buffer.from(saved.hash,'hex')))throw new AppError('Senha incorreta.',401);res.json({csrf:newSession(res)});
});
// Automation endpoint accepts a server-side bearer key, not browser sessions.
const integrationPending=new Set();
app.post('/api/integrations/message',async(req,res)=>{
  const secret=process.env.INTEGRATION_KEY||'',given=req.headers.authorization?.replace(/^Bearer /,'')||'';
  if(secret.length<32||!timingSafeEqual(Buffer.from(hash(secret)),Buffer.from(hash(given))))throw new AppError('Integração não autorizada.',401);
  const key=z.string().min(8).max(100).parse(req.headers['idempotency-key']);const old=store.one('SELECT result FROM requests WHERE key=?',key);if(old){res.json(JSON.parse(old.result));return;}
  if(integrationPending.has(key))throw new AppError('A solicitação já está em andamento.',409);
  integrationPending.add(key);try{const result=await bot.sendMessage(messageSchema.parse(req.body));store.run('INSERT INTO requests VALUES(?,?,?)',key,JSON.stringify(result),store.now());res.json(result);}finally{integrationPending.delete(key);}
});
const htmlEscape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function publicTranscript(req){
  const share=store.get(`transcript-share:${req.params.id}`);
  const token=String(req.params.token||'');
  if(!share?.hash||token.length<20||token.length>200)throw new AppError('Transcript indisponível ou link inválido.',404);
  const expected=Buffer.from(share.hash,'hex'),actual=Buffer.from(hash(token),'hex');
  if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new AppError('Transcript indisponível ou link inválido.',404);
  const ticket=store.one('SELECT id,user_id,category,status,created,updated,transcript FROM tickets WHERE id=?',req.params.id);
  if(!ticket?.transcript||ticket.status!=='closed')throw new AppError('O transcript ainda não está disponível.',404);
  return ticket;
}
app.get('/api/public/tickets/:id/transcript/:token',(req,res)=>{
  const ticket=publicTranscript(req);
  res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
  if(req.query.download==='1'){
    res.attachment(`ticket-${ticket.id}.txt`).type('text/plain; charset=utf-8').send(ticket.transcript);return;
  }
  const download=`/api/public/tickets/${encodeURIComponent(ticket.id)}/transcript/${encodeURIComponent(req.params.token)}?download=1`;
  res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio K · Transcript</title><style>body{margin:0;background:#0d0c13;color:#f4f1ff;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:980px;margin:0 auto;padding:32px 18px 56px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}.eyebrow{color:#ad7cff;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1{margin:4px 0 0;font-size:28px}.meta{color:#a9a2b8;margin:6px 0 0}.btn{display:inline-block;background:#995cff;color:white;text-decoration:none;font-weight:800;padding:11px 16px;border-radius:10px}.card{background:#17141f;border:1px solid #2d2739;border-radius:14px;padding:18px;box-shadow:0 18px 50px #0004}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;color:#eee8ff;font:13px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.note{color:#8f879f;font-size:12px;margin-top:14px}</style></head><body><main class="wrap"><div class="top"><div><div class="eyebrow">Studio K · histórico de atendimento</div><h1>${htmlEscape(ticket.category)}</h1><p class="meta">Ticket ${htmlEscape(ticket.id.slice(0,8))} · encerrado em ${htmlEscape(ticket.updated)}</p></div><a class="btn" href="${download}">Baixar transcript .txt</a></div><section class="card"><pre>${htmlEscape(ticket.transcript)}</pre></section><p class="note">Este link é privado. Não compartilhe se o atendimento contiver informações pessoais.</p></main></body></html>`);
});


// --- Studio K Portfolio / Control integration ---
const portfolioPublicDir=join(store.dir,'portfolio-public'),portfolioPrivateDir=join(store.dir,'portfolio-private');
mkdirSync(portfolioPublicDir,{recursive:true});mkdirSync(portfolioPrivateDir,{recursive:true});
const portfolioRedirect=oauthRedirect;
const portfolioPublicOrigin=new URL(process.env.PORTFOLIO_PUBLIC_URL||base.origin);
const portfolioCookieOptions={httpOnly:true,sameSite:'lax',secure:process.env.COOKIE_SECURE==='true',path:'/',maxAge:30*86400000};
const portfolioOauthCookieOptions={httpOnly:true,sameSite:'lax',secure:process.env.COOKIE_SECURE==='true',path:'/api/oauth/discord',maxAge:10*60000};
const defaultPortfolioSite={
  brandName:'Studio K',
  brandTagline:'SUA IDENTIDADE. SUA CIDADE.',
  logoUrl:'/studio-assets/studio-k-logo.webp',
  homeBackgroundUrl:'/media/studio-k-home.webp',
  controlBackgroundUrl:'/media/studio-k-control.webp',
  heroEyebrow:'DESIGN 3D · FIVEM · MODA DIGITAL',
  heroTitle:'DESIGN ALÉM',
  heroAccent:'DA TEXTURA.',
  heroSubtitle:'Roupas, texturas e experiências visuais criadas para transformar personagens e projetos no GTA V / FiveM.',
  primaryCtaLabel:'Explorar Portfólio',
  secondaryCtaLabel:'Entrar no Discord',
  discordInviteUrl:'',
  adminRoleIds:[]
};
const portfolioSite=()=>{
  const site={...defaultPortfolioSite,...store.get('portfolio:site',{})};
  if(!site.brandTagline||site.brandTagline==='KINETIC LOOM')site.brandTagline=defaultPortfolioSite.brandTagline;
  if(!site.logoUrl||site.logoUrl==='/media/studio-k-logo.webp')site.logoUrl=defaultPortfolioSite.logoUrl;
  return site;
};
const portfolioItems=()=>{const v=store.get('portfolio:items',[]);return Array.isArray(v)?v:[]};
const storedPortfolioProducts=()=>{const v=store.get('portfolio:products',[]);return Array.isArray(v)?v:[]};
const portfolioProducts=()=>{const stored=storedPortfolioProducts();if(stored.length)return stored;return store.products().map(p=>({id:p.id,name:p.name,description:p.description||'',priceCents:p.priceCents||0,category:p.category||'Studio K',tags:[],coverUrl:p.image||'',modelUrl:'',featured:false,published:true,botProductId:p.id,created:p.created||''}))};
const portfolioAssets=()=>{const v=store.get('portfolio:assets',[]);return Array.isArray(v)?v:[]};
const portfolioAbsoluteUrl=value=>{
  const raw=String(value||'').trim();
  if(!raw)return '';
  try{return new URL(raw,portfolioPublicOrigin).toString()}catch{return raw}
};
const runPortfolioProcess=(command,args,timeoutMs=240000)=>new Promise((resolveProcess,rejectProcess)=>{
  const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',settled=false;
  const append=(current,chunk)=>{const next=current+String(chunk||'');return next.length>12000?next.slice(-12000):next};
  child.stdout?.on('data',chunk=>{stdout=append(stdout,chunk)});
  child.stderr?.on('data',chunk=>{stderr=append(stderr,chunk)});
  const timer=setTimeout(()=>{
    if(settled)return;
    settled=true;
    child.kill('SIGKILL');
    rejectProcess(new AppError('O processamento do arquivo excedeu o tempo limite.',504));
  },timeoutMs);
  child.on('error',error=>{
    if(settled)return;
    settled=true;clearTimeout(timer);
    rejectProcess(new AppError(`Não foi possível iniciar o processador: ${error.message}`,503));
  });
  child.on('close',code=>{
    if(settled)return;
    settled=true;clearTimeout(timer);
    if(code===0)return resolveProcess({stdout,stderr});
    rejectProcess(new AppError((stderr||stdout||`Processador finalizou com código ${code}`).slice(-1500),422));
  });
});
const registerPortfolioAsset=(asset)=>{
  const assets=portfolioAssets();
  assets.unshift(asset);
  store.set('portfolio:assets',assets.slice(0,500));
  return asset;
};
const processPortfolioAsset=async(sourceId)=>{
  const source=portfolioAssets().find(asset=>asset.id===sourceId);
  if(!source)throw new AppError('Arquivo-fonte não encontrado.',404);
  const ext=String(source.ext||'').toLowerCase();
  if(!['blend','obj','fbx','psd'].includes(ext))throw new AppError('Este formato não precisa de conversão automática.',400);
  const sourceDir=source.visibility==='public'?portfolioPublicDir:portfolioPrivateDir;
  const input=join(sourceDir,source.filename);
  const outputId=randomUUID();
  const now=store.now();
  if(ext==='psd'){
    const filename=`${outputId}.png`,output=join(portfolioPublicDir,filename);
    await runPortfolioProcess('convert',[`${input}[0]`,'-background','none','-flatten','-resize','2400x2400>','-strip',output],120000);
    const preview=registerPortfolioAsset({
      id:outputId,
      originalName:String(source.originalName||'arquivo.psd').replace(/\.psd$/i,'-preview.png'),
      filename,
      ext:'png',
      visibility:'public',
      size:statSync(output).size,
      created:now,
      publicUrl:`/portfolio-assets/${filename}`,
      sourceAssetId:source.id,
      generated:true
    });
    return{kind:'preview',source,asset:preview,publicUrl:preview.publicUrl};
  }
  const filename=`${outputId}.glb`,output=join(portfolioPublicDir,filename);
  await runPortfolioProcess('blender',[
    '-b','--factory-startup','--disable-autoexec',
    '--python',join(root,'server','convert3d.py'),
    '--',input,output,ext
  ],300000);
  const converted=registerPortfolioAsset({
    id:outputId,
    originalName:String(source.originalName||`modelo.${ext}`).replace(/\.(blend|obj|fbx)$/i,'.glb'),
    filename,
    ext:'glb',
    visibility:'public',
    size:statSync(output).size,
    created:now,
    publicUrl:`/portfolio-assets/${filename}`,
    sourceAssetId:source.id,
    generated:true
  });
  return{kind:'model',source,asset:converted,publicUrl:converted.publicUrl};
};
const syncPortfolioProductToBot=(portfolioProduct)=>{
  if(!portfolioProduct)throw new AppError('Produto não encontrado.',404);
  if(Number(portfolioProduct.priceCents||0)<1)throw new AppError('Defina um preço maior que zero antes de sincronizar este produto com o bot.',400);
  const image=portfolioAbsoluteUrl(portfolioProduct.coverUrl||portfolioProduct.gifUrl||'');
  const data=productSchema.parse({
    name:portfolioProduct.name,
    description:portfolioProduct.description||'',
    priceCents:Number(portfolioProduct.priceCents||0),
    type:'service',
    roleId:'',
    active:portfolioProduct.published!==false,
    image:image&&image.startsWith('https://')?image:'',
    delivery:'',
    category:portfolioProduct.category||'Studio K'
  });
  let botProductId=String(portfolioProduct.botProductId||'');
  const exists=botProductId&&store.one('SELECT id FROM products WHERE id=?',botProductId);
  if(exists)store.run('UPDATE products SET data=? WHERE id=?',JSON.stringify(data),botProductId);
  else{
    botProductId=randomUUID();
    store.run('INSERT INTO products VALUES(?,?,?)',botProductId,JSON.stringify(data),store.now());
  }
  const products=storedPortfolioProducts();
  const pos=products.findIndex(item=>item.id===portfolioProduct.id);
  const linked={...portfolioProduct,botProductId,updated:store.now()};
  if(pos>=0){products[pos]=linked;store.set('portfolio:products',products)}
  return linked;
};
const portfolioStatus=()=>{
  const cfg=store.settings().operationsLive||{};
  const openTickets=Number(store.one("SELECT COUNT(*) AS n FROM tickets WHERE status='open'")?.n||0);
  const pendingOrders=Number(store.one("SELECT COUNT(*) AS n FROM orders WHERE status='pending'")?.n||0);
  return{
    botOnline:!!bot.status().connected,
    storeOpen:cfg.storeOpen!==false,
    ticketsOpen:cfg.ticketsOpen!==false,
    openTickets,
    pendingOrders,
    updatedAt:store.now()
  };
};
const portfolioSession=req=>{
  const bearer=String(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i)?.[1]||'';
  const raw=cookieValue(req,'studio_web_session')||bearer;
  if(!raw)return null;
  const key=`portfolio-session:${hash(raw)}`,data=store.get(key);
  if(!data||Number(data.expires||0)<Date.now()){
    if(data)store.run('DELETE FROM kv WHERE key=?',key);
    return null;
  }
  return{...data,key,raw};
};
const portfolioStaffRoleIds=()=>{
  const groups=store.settings().roleGroups||{};
  return [...new Set([...(groups.staff||[]),...(groups.highStaff||[])].filter(Boolean))];
};
const portfolioCanControl=async(req,web=portfolioSession(req))=>{
  if(!web?.user?.id)return false;
  const allowed=portfolioStaffRoleIds();
  if(!allowed.length)return false;
  const member=await portfolioMember(web.user.id);
  web.member=member;
  return !!member?.inGuild&&(member.roles||[]).some(role=>allowed.includes(role.id));
};
const portfolioItemSchema=z.object({
  name:z.string().trim().min(1).max(140),
  description:z.string().max(3000).default(''),
  category:z.string().trim().max(80).default('Studio K'),
  tags:z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  coverUrl:z.string().max(2000).default(''),
  modelUrl:z.string().max(2000).default(''),
  videoUrl:z.string().max(2000).default(''),
  gifUrl:z.string().max(2000).default(''),
  galleryUrls:z.array(z.string().max(2000)).max(20).default([]),
  featured:z.boolean().default(false),
  published:z.boolean().default(true)
});
const portfolioProductSchema=portfolioItemSchema.extend({priceCents:z.number().int().min(0).max(1000000000).default(0),botProductId:z.string().max(80).default('')});
const portfolioSiteSchema=z.object({
  brandName:z.string().trim().min(1).max(80).default(defaultPortfolioSite.brandName),
  brandTagline:z.string().trim().max(80).default(defaultPortfolioSite.brandTagline),
  logoUrl:z.string().max(2000).default(defaultPortfolioSite.logoUrl),
  homeBackgroundUrl:z.string().max(2000).default(defaultPortfolioSite.homeBackgroundUrl),
  controlBackgroundUrl:z.string().max(2000).default(defaultPortfolioSite.controlBackgroundUrl),
  heroEyebrow:z.string().max(140).default(defaultPortfolioSite.heroEyebrow),
  heroTitle:z.string().max(160).default(defaultPortfolioSite.heroTitle),
  heroAccent:z.string().max(160).default(defaultPortfolioSite.heroAccent),
  heroSubtitle:z.string().max(900).default(defaultPortfolioSite.heroSubtitle),
  primaryCtaLabel:z.string().max(80).default(defaultPortfolioSite.primaryCtaLabel),
  secondaryCtaLabel:z.string().max(80).default(defaultPortfolioSite.secondaryCtaLabel),
  discordInviteUrl:z.string().max(2000).default(''),
  adminRoleIds:z.array(z.string().regex(/^\d{17,20}$/)).max(30).default([])
});
async function portfolioMember(userId){try{const m=bot.status().connected?await bot.memberProfile(userId):null;return m?{...m,inGuild:true}:{inGuild:false,roles:[]}}catch{return{inGuild:false,roles:[]}}}
async function publicPortfolioFeedbacks(limit=18){const rows=store.all("SELECT id,type,source_id,user_id,rating,comment,meta,submitted_at FROM feedback_requests WHERE status='submitted' ORDER BY submitted_at DESC LIMIT ?",Math.max(1,Math.min(50,Number(limit)||18)));return Promise.all(rows.map(async row=>{let meta={};try{meta=JSON.parse(row.meta||'{}')}catch{}let profile=null;try{profile=await portfolioMember(row.user_id)}catch{}const source=row.type==='ticket'?'Atendimento':'Compra';const reference=row.type==='ticket'?(meta.ticket||`#${row.source_id.slice(0,8)}`):(meta.product||`#${row.source_id.slice(0,8)}`);return{id:row.id,rating:Number(row.rating||0),comment:String(row.comment||'').slice(0,1200),source,reference,name:profile?.name||'Cliente Studio K',avatar:profile?.avatar||'',submittedAt:row.submitted_at||'',meta:{service:meta.service||null,speed:meta.speed||null,resolution:meta.resolution||null}}}))}
app.get('/api/portfolio/oauth/start',(req,res)=>{
  if(!process.env.DISCORD_CLIENT_ID||!process.env.DISCORD_CLIENT_SECRET)throw new AppError('OAuth do Discord ainda não está configurado no servidor.',503);
  const next=String(req.query.next||'/account'),safeNext=(next.startsWith('/')&&!next.startsWith('//'))?next:'/account';
  const bridge=new URL('/api/portfolio/oauth/bridge',base);bridge.searchParams.set('next',safeNext);res.redirect(bridge.toString());
});
app.get('/api/portfolio/oauth/bridge',(req,res)=>{
  if(!process.env.DISCORD_CLIENT_ID||!process.env.DISCORD_CLIENT_SECRET)throw new AppError('OAuth do Discord ainda não está configurado no servidor.',503);
  const next=String(req.query.next||'/account'),safeNext=(next.startsWith('/')&&!next.startsWith('//'))?next:'/account',state=randomBytes(32).toString('base64url');
  store.set(`portfolio-oauth:${hash(state)}`,{next:safeNext,expires:Date.now()+10*60000});
  res.cookie('studio_portfolio_oauth_state',state,portfolioOauthCookieOptions);
  const params=new URLSearchParams({response_type:'code',client_id:process.env.DISCORD_CLIENT_ID,scope:'identify',state,redirect_uri:oauthRedirect,prompt:'consent'});
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});
app.get('/api/portfolio/oauth/complete',(req,res)=>{
  const raw=String(req.query.t||''),key=raw?`portfolio-handoff:${hash(raw)}`:'',handoff=key?store.get(key):null;
  if(key)store.run('DELETE FROM kv WHERE key=?',key);
  if(!handoff||Number(handoff.expires||0)<Date.now())return res.status(403).type('html').send('<meta charset="utf-8"><title>Studio K</title><style>body{background:#07040c;color:#fff;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.c{padding:28px;border:1px solid #6c2ca5;border-radius:18px;background:#11091d}.c a{color:#c67aff}</style><div class="c"><h1>Conexão expirada</h1><p>Inicie novamente a conexão pelo Studio K.</p><a href="/portfolio/#account">Voltar ao portfólio</a></div>');
  const sessionRaw=randomBytes(32).toString('hex');
  store.set(`portfolio-session:${hash(sessionRaw)}`,{...handoff.session,expires:Date.now()+30*86400000});
  res.cookie('studio_web_session',sessionRaw,portfolioCookieOptions);
  res.redirect(handoff.next||'/portfolio/#account');
});
app.get('/api/portfolio/oauth/callback',async(req,res)=>{try{const expected=cookieValue(req,'studio_portfolio_oauth_state'),given=String(req.query.state||''),code=String(req.query.code||'');res.clearCookie('studio_portfolio_oauth_state',{path:'/api/portfolio/oauth'});if(req.query.error)throw new AppError('A autorização do Discord foi cancelada.',400);if(!expected||!given||!timingSafeEqual(Buffer.from(hash(expected)),Buffer.from(hash(given))))throw new AppError('A autorização expirou ou não corresponde a esta solicitação.',403);const stateData=store.get(`portfolio-oauth:${hash(given)}`);store.run('DELETE FROM kv WHERE key=?',`portfolio-oauth:${hash(given)}`);if(!stateData||Number(stateData.expires||0)<Date.now())throw new AppError('A autorização expirou. Tente novamente.',403);const tokenResponse=await fetch('https://discord.com/api/v10/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.DISCORD_CLIENT_ID,client_secret:process.env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code,redirect_uri:portfolioRedirect})});const token=await tokenResponse.json().catch(()=>({}));if(!tokenResponse.ok||!token.access_token)throw new AppError('Não foi possível concluir a autenticação com o Discord.',502);const userResponse=await fetch('https://discord.com/api/v10/users/@me',{headers:{Authorization:`Bearer ${token.access_token}`}});const discordUser=await userResponse.json().catch(()=>({}));if(!userResponse.ok||!discordUser.id)throw new AppError('Não foi possível identificar sua conta do Discord.',502);const member=await portfolioMember(discordUser.id),avatar=discordUser.avatar?`https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=128`:(member.avatar||'');const raw=randomBytes(32).toString('hex'),sessionData={user:{id:discordUser.id,username:discordUser.username||'',name:discordUser.global_name||member.name||discordUser.username||discordUser.id,avatar},member,created:Date.now(),expires:Date.now()+30*86400000};store.set(`portfolio-session:${hash(raw)}`,sessionData);res.cookie('studio_web_session',raw,portfolioCookieOptions);res.redirect(stateData.next||'/portfolio/#account')}catch(e){res.status(e instanceof AppError?e.status:500).type('html').send(`<meta charset="utf-8"><title>Studio K</title><style>body{background:#07040c;color:#fff;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.c{max-width:560px;padding:28px;border:1px solid #5c2786;border-radius:18px;background:#11091d}.c a{color:#c67aff}</style><div class="c"><h1>Não foi possível conectar</h1><p>${htmlEscape(e instanceof AppError?e.message:'Tente novamente.')}</p><a href="/portfolio/#account">Voltar ao Studio K</a></div>`)}});

app.get('/api/portfolio/oauth/exchange',(req,res)=>{
  const raw=String(req.query.t||''),key=raw?`portfolio-handoff:${hash(raw)}`:'',handoff=key?store.get(key):null;
  if(key)store.run('DELETE FROM kv WHERE key=?',key);
  if(!handoff||Number(handoff.expires||0)<Date.now())throw new AppError('Conexão expirada. Inicie novamente o login com Discord.',403);
  const sessionRaw=randomBytes(32).toString('hex');
  store.set(`portfolio-session:${hash(sessionRaw)}`,handoff.session);
  res.json({sessionToken:sessionRaw,user:handoff.session.user,member:handoff.session.member,next:handoff.next||'/account'});
});

app.post('/api/portfolio/logout',(req,res)=>{const s=portfolioSession(req);if(s?.key)store.run('DELETE FROM kv WHERE key=?',s.key);res.clearCookie('studio_web_session',{path:'/'});res.json({ok:true})});
app.get('/api/portfolio/feedbacks',async(req,res)=>res.json(await publicPortfolioFeedbacks(18)));
app.get('/api/portfolio/public-state',async(req,res)=>{const web=portfolioSession(req),items=portfolioItems().filter(x=>x.published),products=portfolioProducts().filter(x=>x.published),feedbacks=await publicPortfolioFeedbacks(18);const canControl=web?await portfolioCanControl(req,web):false;const me=web?{authenticated:true,user:web.user,member:web.member,canControl}:{authenticated:false,canControl:false};res.json({site:portfolioSite(),status:portfolioStatus(),items,products,feedbacks,me})});
app.get('/api/portfolio/me/orders',(req,res)=>{
  const web=portfolioSession(req);
  if(!web?.user?.id)throw new AppError('Conecte sua conta do Discord para ver seus pedidos.',401);
  const orders=store.all('SELECT id,product_id,product,price,status,created,expires,approved_at,delivered_at,coupon_code,discount,error FROM orders WHERE user_id=? ORDER BY created DESC LIMIT 100',web.user.id).map(order=>{
    let product={};try{product=JSON.parse(order.product||'{}')}catch{}
    return{
      id:order.id,
      productId:order.product_id,
      productName:product.name||'Produto Studio K',
      price:Number(order.price||0),
      status:order.status,
      created:order.created,
      expires:order.expires,
      approvedAt:order.approved_at,
      deliveredAt:order.delivered_at,
      couponCode:order.coupon_code||'',
      discount:Number(order.discount||0),
      error:order.error||'',
      deliveryType:product.type||'service'
    };
  });
  res.json({orders});
});
app.get('/api/portfolio/me/orders/:id/delivery',(req,res)=>{
  const web=portfolioSession(req);
  if(!web?.user?.id)throw new AppError('Conecte sua conta do Discord para recuperar a entrega.',401);
  const order=store.one('SELECT id,product,status FROM orders WHERE id=? AND user_id=?',req.params.id,web.user.id);
  if(!order)throw new AppError('Pedido não encontrado.',404);
  let product={};try{product=JSON.parse(order.product||'{}')}catch{}
  if(product.type!=='digital')throw new AppError('Este pedido é um serviço e não possui arquivo/chave digital para recuperação.',400);
  if(order.status!=='delivered'&&order.status!=='paid')throw new AppError('A entrega ainda não está disponível para este pedido.',409);
  const unit=store.one('SELECT secret FROM stock WHERE order_id=?',order.id);
  if(!unit?.secret)throw new AppError('Entrega digital não encontrada. Use o suporte do Studio K.',404);
  res.json({delivery:store.decrypt(unit.secret),instructions:product.delivery||'',productName:product.name||'Produto Studio K'});
});
app.post('/api/portfolio/products/:id/order',portfolioSameOrigin,async(req,res)=>{
  const web=portfolioSession(req);
  if(!web?.user?.id)throw new AppError('Conecte sua conta do Discord antes de iniciar uma compra.',401);
  const product=portfolioProducts().find(item=>item.id===req.params.id&&item.published!==false);
  if(!product)throw new AppError('Produto não encontrado.',404);
  if(!product.botProductId)throw new AppError('Este produto ainda não está sincronizado com o bot do Studio K.',409);
  if(!demo)await bot.member(web.user.id);
  const couponCode=String(req.body?.couponCode||'').trim().slice(0,40);
  const order=store.createOrder(product.botProductId,web.user.id,couponCode);
  const sales=store.settings().sales||{};
  res.json({
    id:order.id,
    status:order.status,
    price:Number(order.price||0),
    expires:order.expires,
    productName:product.name,
    payment:{
      pixKey:sales.pixKey||'',
      recipient:sales.recipient||'',
      instructions:sales.instructions||''
    }
  });
});
const portfolioControl=async(req,res,next)=>{const web=portfolioSession(req);if(!await portfolioCanControl(req,web))return res.status(403).json({error:'A Central de Controle é exclusiva para membros com cargo de Staff no Discord do Studio K.'});req.portfolioWeb=web;next()};
app.get('/api/portfolio/control/state',portfolioControl,async(req,res)=>{
  let channels=[];
  if(bot.status().connected){
    try{
      const meta=await bot.metadata();
      channels=(meta.channels||[]).map(channel=>({id:channel.id,name:channel.name,type:channel.type})).slice(0,250);
    }catch{}
  }
  res.json({
    authorized:true,
    user:req.portfolioWeb?.user||{name:'Administrador Studio K'},
    site:portfolioSite(),
    status:portfolioStatus(),
    items:portfolioItems(),
    products:portfolioProducts(),
    assets:portfolioAssets(),
    feedbacks:await publicPortfolioFeedbacks(50),
    discord:{
      oauthConfigured:!!(process.env.DISCORD_CLIENT_ID&&process.env.DISCORD_CLIENT_SECRET),
      redirectUri:portfolioRedirect,
      publicOrigin:portfolioPublicOrigin.origin,
      botConnected:!!bot.status().connected,
      channels
    }
  });
});
app.put('/api/portfolio/control/site',portfolioControl,portfolioSameOrigin,(req,res)=>{const current=portfolioSite(),next=portfolioSiteSchema.parse({...current,...req.body});store.set('portfolio:site',next);store.log('portfólio','Configurações do site atualizadas.','portfolio-control');res.json(next)});
app.post('/api/portfolio/control/items',portfolioControl,portfolioSameOrigin,(req,res)=>{const item={id:randomUUID(),...portfolioItemSchema.parse(req.body),created:store.now(),updated:store.now()};const items=portfolioItems();if(item.featured)for(const x of items)x.featured=false;items.unshift(item);store.set('portfolio:items',items);res.json(item)});
app.put('/api/portfolio/control/items/:id',portfolioControl,portfolioSameOrigin,(req,res)=>{const items=portfolioItems(),index=items.findIndex(x=>x.id===req.params.id);if(index<0)throw new AppError('Projeto não encontrado.',404);const next={...items[index],...portfolioItemSchema.parse(req.body),updated:store.now()};if(next.featured)for(const x of items)x.featured=false;items[index]=next;store.set('portfolio:items',items);res.json(next)});
app.delete('/api/portfolio/control/items/:id',portfolioControl,portfolioSameOrigin,(req,res)=>{store.set('portfolio:items',portfolioItems().filter(x=>x.id!==req.params.id));res.json({ok:true})});
app.post('/api/portfolio/control/products',portfolioControl,portfolioSameOrigin,(req,res)=>{const item={id:randomUUID(),...portfolioProductSchema.parse(req.body),created:store.now(),updated:store.now()};const products=storedPortfolioProducts();if(item.featured)for(const x of products)x.featured=false;products.unshift(item);store.set('portfolio:products',products);res.json(item)});
app.put('/api/portfolio/control/products/:id',portfolioControl,portfolioSameOrigin,(req,res)=>{let products=storedPortfolioProducts();if(!products.length)products=portfolioProducts();const index=products.findIndex(x=>x.id===req.params.id);if(index<0)throw new AppError('Produto não encontrado.',404);const next={...products[index],...portfolioProductSchema.parse(req.body),updated:store.now()};if(next.featured)for(const x of products)x.featured=false;products[index]=next;store.set('portfolio:products',products);res.json(next)});
app.delete('/api/portfolio/control/products/:id',portfolioControl,portfolioSameOrigin,(req,res)=>{store.set('portfolio:products',storedPortfolioProducts().filter(x=>x.id!==req.params.id));res.json({ok:true})});
app.post('/api/portfolio/control/products/:id/sync-bot',portfolioControl,portfolioSameOrigin,(req,res)=>{
  const product=portfolioProducts().find(item=>item.id===req.params.id);
  if(!product)throw new AppError('Produto não encontrado.',404);
  const linked=syncPortfolioProductToBot(product);
  store.log('portfólio',`Produto sincronizado com o bot: ${linked.name}`,'portfolio-control');
  res.json({ok:true,product:linked,botProductId:linked.botProductId});
});
app.post('/api/portfolio/control/products/:id/announce',portfolioControl,portfolioSameOrigin,async(req,res)=>{
  if(!bot.status().connected)throw new AppError('O bot precisa estar conectado para publicar no Discord.',503);
  const channelId=id.parse(req.body?.channelId);
  const product=portfolioProducts().find(item=>item.id===req.params.id);
  if(!product)throw new AppError('Produto não encontrado.',404);
  const linked=syncPortfolioProductToBot(product);
  const result=await bot.publishProduct(linked.botProductId,channelId);
  store.log('portfólio',`Produto anunciado no Discord: ${linked.name}`,'portfolio-control');
  res.json({ok:true,botProductId:linked.botProductId,messageId:result.id});
});

app.post('/api/portfolio/control/upload-ticket',portfolioControl,portfolioSameOrigin,(req,res)=>{
  const name=String(req.body?.name||'arquivo').slice(0,180),requestedPublic=req.body?.public===true,token=randomBytes(32).toString('base64url');
  store.set(`portfolio-upload:${hash(token)}`,{userId:req.portfolioWeb?.user?.id||'',name,public:requestedPublic,expires:Date.now()+5*60000});
  const uploadUrl=new URL(`/api/portfolio/upload/${encodeURIComponent(token)}`,base);
  res.json({token,uploadUrl:uploadUrl.toString(),expiresIn:300});
});
app.post('/api/portfolio/control/assets/:id/process',portfolioControl,portfolioSameOrigin,async(req,res)=>{
  const result=await processPortfolioAsset(req.params.id);
  store.log('portfólio',`Arquivo processado automaticamente: ${result.source.originalName}`,'portfolio-control');
  res.json(result);
});
const portfolioDirectAssetUpload=express.raw({type:()=>true,limit:'80mb'});
app.options('/api/portfolio/upload/:token',(req,res)=>{
  if(req.headers.origin===portfolioPublicOrigin.origin){
    res.setHeader('Access-Control-Allow-Origin',portfolioPublicOrigin.origin);
    res.setHeader('Access-Control-Allow-Methods','PUT,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    res.setHeader('Vary','Origin');
  }
  res.status(204).end();
});
app.put('/api/portfolio/upload/:token',portfolioDirectAssetUpload,(req,res)=>{
  if(req.headers.origin!==portfolioPublicOrigin.origin)throw new AppError('Origem não autorizada.',403);
  res.setHeader('Access-Control-Allow-Origin',portfolioPublicOrigin.origin);
  res.setHeader('Vary','Origin');
  const token=String(req.params.token||''),key=`portfolio-upload:${hash(token)}`,ticket=store.get(key);
  store.run('DELETE FROM kv WHERE key=?',key);
  if(!ticket||Number(ticket.expires||0)<Date.now())throw new AppError('O link de upload expirou. Gere um novo link.',403);
  const original=String(req.query.name||ticket.name||'arquivo').slice(0,180),ext=(original.toLowerCase().match(/\.([a-z0-9]{2,8})$/)?.[1]||'bin');
  const publicExts=new Set(['png','jpg','jpeg','webp','gif','mp4','webm','glb','gltf']),sourceExts=new Set(['blend','obj','psd','fbx']);
  if(!publicExts.has(ext)&&!sourceExts.has(ext))throw new AppError('Formato não suportado. Use GLB/GLTF, PNG/JPEG/WebP/GIF, MP4/WebM ou fontes BLEND/OBJ/PSD/FBX.',400);
  if(!Buffer.isBuffer(req.body)||!req.body.length)throw new AppError('Arquivo vazio.',400);
  const visibility=ticket.public&&publicExts.has(ext)?'public':'private',id=randomUUID(),filename=`${id}.${ext}`,dir=visibility==='public'?portfolioPublicDir:portfolioPrivateDir;
  writeFileSync(join(dir,filename),req.body);
  const asset={id,originalName:original,filename,ext,visibility,size:req.body.length,created:store.now(),publicUrl:visibility==='public'?`/portfolio-assets/${filename}`:''};
  const assets=portfolioAssets();assets.unshift(asset);store.set('portfolio:assets',assets.slice(0,500));
  res.json(asset);
});

const portfolioAssetUpload=express.raw({type:()=>true,limit:'80mb'});
app.post('/api/portfolio/control/assets',portfolioControl,sameOrigin,portfolioAssetUpload,(req,res)=>{const original=String(req.query.name||'arquivo').slice(0,180),ext=(original.toLowerCase().match(/\.([a-z0-9]{2,8})$/)?.[1]||'bin');const publicExts=new Set(['png','jpg','jpeg','webp','gif','mp4','webm','glb','gltf']),sourceExts=new Set(['blend','obj','psd','fbx']);if(!publicExts.has(ext)&&!sourceExts.has(ext))throw new AppError('Formato não suportado. Use GLB/GLTF, PNG/JPEG/WebP/GIF, MP4/WebM ou fontes BLEND/OBJ/PSD/FBX.',400);if(!Buffer.isBuffer(req.body)||!req.body.length)throw new AppError('Arquivo vazio.',400);const requestedPublic=String(req.query.public||'0')==='1',visibility=requestedPublic&&publicExts.has(ext)?'public':'private',id=randomUUID(),filename=`${id}.${ext}`,dir=visibility==='public'?portfolioPublicDir:portfolioPrivateDir;writeFileSync(join(dir,filename),req.body);const asset={id,originalName:original,filename,ext,visibility,size:req.body.length,created:store.now(),publicUrl:visibility==='public'?`/portfolio-assets/${filename}`:''};const assets=portfolioAssets();assets.unshift(asset);store.set('portfolio:assets',assets.slice(0,500));res.json(asset)});
app.use('/portfolio-assets',express.static(portfolioPublicDir,{index:false,maxAge:'1h',immutable:false}));
// --- /Studio K Portfolio / Control integration ---

app.use('/api',(req,res,next)=>{req.session=session(req);if(!req.session)return res.status(401).json({error:'Entre no painel para continuar.'});res.setHeader('Cache-Control','no-store');if(!['GET','HEAD'].includes(req.method)){return sameOrigin(req,res,()=>{if(req.headers['x-csrf-token']!==req.session.csrf)return res.status(403).json({error:'Sua sessão mudou. Atualize a página.'});next();});}next();});
app.post('/api/logout',(req,res)=>{store.run('DELETE FROM sessions WHERE id=?',req.session.id);res.clearCookie('studio_session',{path:'/'});res.json({ok:true});});
app.get('/api/state',(req,res)=>{
  const settings=store.settings(),products=store.products().map(p=>{const stats=store.one("SELECT COUNT(*) AS total,SUM(CASE WHEN s.order_id IS NULL THEN 1 ELSE 0 END) AS available,SUM(CASE WHEN s.order_id IS NOT NULL AND COALESCE(o.status,'') IN ('pending','paid') THEN 1 ELSE 0 END) AS reserved,SUM(CASE WHEN COALESCE(o.status,'')='delivered' THEN 1 ELSE 0 END) AS delivered FROM stock s LEFT JOIN orders o ON o.id=s.order_id WHERE s.product_id=?",p.id)||{};return{...p,stockStats:{total:Number(stats.total||0),available:Number(stats.available||0),reserved:Number(stats.reserved||0),delivered:Number(stats.delivered||0)}}});const orders=store.all('SELECT * FROM orders ORDER BY created DESC LIMIT 200').map(o=>({...o,product:JSON.parse(o.product)}));
  const summary=store.one("SELECT COUNT(*) AS orders,COALESCE(SUM(CASE WHEN status IN ('paid','delivered') THEN price ELSE 0 END),0) AS revenue,SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending FROM orders");
  const tickets=store.all("SELECT id,user_id,channel_id,category,status,state,priority,created,updated,claimed_by,closed_reason,reopened_from,tags FROM tickets ORDER BY created DESC LIMIT 300").map(t=>({...t,tags:(()=>{try{return JSON.parse(t.tags||'[]')}catch{return[]}})()}));
  const openTickets=tickets.filter(t=>t.status==='open'),now=Date.now();
  const ops={
    openTickets:openTickets.length,
    waitingStaff:openTickets.filter(t=>t.state==='waiting_staff').length,
    waitingCustomer:openTickets.filter(t=>t.state==='waiting_customer').length,
    escalated:openTickets.filter(t=>t.state==='escalated').length,
    urgent:openTickets.filter(t=>t.priority==='urgent').length,
    avgOpenMinutes:openTickets.length?Math.round(openTickets.reduce((n,t)=>n+Math.max(0,now-Date.parse(t.created)),0)/openTickets.length/60000):0,
    lowStock:products.filter(p=>p.type==='digital'&&p.stock<=settings.sales.lowStockThreshold).length,
    openAlerts:store.one("SELECT COUNT(*) AS n FROM alerts WHERE status='open'")?.n||0
  };
  const staffMetrics=store.all("SELECT staff_id,COUNT(*) AS actions,SUM(CASE WHEN action='claim' THEN 1 ELSE 0 END) AS claimed,SUM(CASE WHEN action='close' THEN 1 ELSE 0 END) AS closed,SUM(CASE WHEN action='transfer' THEN 1 ELSE 0 END) AS transferred FROM staff_actions WHERE created>=? GROUP BY staff_id ORDER BY closed DESC,actions DESC LIMIT 50",new Date(Date.now()-30*86400000).toISOString());
  res.json({demo,status:bot.status(),oauth:{configured:!!(process.env.DISCORD_CLIENT_ID&&process.env.DISCORD_CLIENT_SECRET),redirectUri:oauthRedirect},integrations:{youtube:{configured:!!(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET),redirectUri:googleRedirect},translation:{configured:!!process.env.LIBRETRANSLATE_URL,provider:'LibreTranslate'}},settings,products,orders,summary,ops,staffMetrics,tickets,coupons:store.all('SELECT * FROM coupons ORDER BY created DESC LIMIT 200'),alerts:store.all("SELECT * FROM alerts ORDER BY created DESC LIMIT 100"),giveaways:store.all('SELECT * FROM giveaways ORDER BY created DESC LIMIT 100').map(g=>({...g,data:JSON.parse(g.data),entries:store.one('SELECT COUNT(*) AS n FROM entries WHERE giveaway_id=?',g.id).n,attempts:store.one('SELECT COUNT(*) AS n FROM giveaway_attempts WHERE giveaway_id=?',g.id).n,incomplete:store.one("SELECT COUNT(*) AS n FROM giveaway_attempts WHERE giveaway_id=? AND status='incomplete'",g.id).n})),events:store.all('SELECT * FROM events ORDER BY created DESC LIMIT 100').map(e=>({...e,data:JSON.parse(e.data)})),logs:store.all('SELECT * FROM logs ORDER BY id DESC LIMIT 200').map(l=>({...l,meta:(()=>{try{return JSON.parse(l.meta||'{}')}catch{return {}}})()})),feedbacks:store.all("SELECT id,type,source_id,user_id,status,rating,comment,meta,created,submitted_at FROM feedback_requests WHERE status='submitted' ORDER BY submitted_at DESC LIMIT 100").map(f=>({...f,meta:JSON.parse(f.meta||'{}')})),templates:store.all('SELECT * FROM templates ORDER BY name').map(t=>({...t,data:JSON.parse(t.data)})),lastBackup:store.get('lastBackup'),backups:readdirSync(join(store.dir,'backups')).filter(f=>f.endsWith('.json')).sort().reverse()});
});
app.get('/api/discord/metadata',async(req,res)=>res.json(await bot.metadata()));
app.put('/api/settings',(req,res)=>{
  const settings=settingsSchema.parse(req.body);
  store.set('settings',settings);
  store.log('configuração','Configurações atualizadas.','administrador');
  res.json({ok:true});
  if(bot.status().connected){
    void Promise.allSettled([bot.updateLivePanels(true),bot.applyVoicePresence()]).then(results=>{
      for(const result of results)if(result.status==='rejected')store.log('aviso',`Sincronização após salvar configurações: ${String(result.reason?.message||result.reason).slice(0,400)}`);
    });
  }
});
app.post('/api/brand/apply',async(req,res)=>{await bot.applyBrand();res.json({ok:true});});
app.post('/api/messages',async(req,res)=>res.json(await bot.sendMessage(messageSchema.parse(req.body))));
app.post('/api/templates',(req,res)=>{const body=z.object({name:z.string().min(1).max(80),data:z.unknown()}).parse(req.body);const data=templateSchema.parse(body.data);const tid=randomUUID();store.run('INSERT INTO templates VALUES(?,?,?)',tid,body.name,JSON.stringify(data));res.json({id:tid});});
app.delete('/api/templates/:id',(req,res)=>{store.run('DELETE FROM templates WHERE id=?',req.params.id);res.json({ok:true});});
app.post('/api/products',(req,res)=>{const product=productSchema.parse(req.body),pid=randomUUID();store.run('INSERT INTO products VALUES(?,?,?)',pid,JSON.stringify(product),store.now());store.log('produto',`Produto criado: ${product.name}`,'administrador');res.json({id:pid});});
app.put('/api/products/:id',(req,res)=>{const product=productSchema.parse(req.body);if(!store.one('SELECT id FROM products WHERE id=?',req.params.id))throw new AppError('Produto não encontrado.',404);store.run('UPDATE products SET data=? WHERE id=?',JSON.stringify(product),req.params.id);store.log('produto',`Produto atualizado: ${product.name}`,'administrador');res.json({ok:true});});
app.post('/api/products/:id/stock',(req,res)=>{const items=z.array(z.string().trim().min(1).max(1200)).min(1).max(1000).parse(req.body.items);const product=store.one('SELECT data FROM products WHERE id=?',req.params.id);if(!product||JSON.parse(product.data).type!=='digital')throw new AppError('Escolha um produto digital.');store.transaction(()=>{for(const item of items)store.run('INSERT INTO stock(id,product_id,secret) VALUES(?,?,?)',randomUUID(),req.params.id,store.encrypt(item));});store.log('estoque',`${items.length} unidade(s) adicionadas.`,'administrador');res.json({ok:true});});
app.post('/api/products/:id/publish',async(req,res)=>res.json(await bot.publishProduct(req.params.id,id.parse(req.body.channelId))));
app.post('/api/orders',async(req,res)=>{const body=z.object({productId:z.string().uuid(),userId:id,couponCode:z.string().max(40).default('')}).parse(req.body);if(!demo)await bot.member(body.userId);const order=store.createOrder(body.productId,body.userId,body.couponCode);if(bot.status().connected)void bot.updateLivePanels(true);res.json(order);});
app.post('/api/orders/:id/approve',async(req,res)=>{if(req.body.confirmed!==true)throw new AppError('Confirme que o valor chegou à sua conta.');const order=store.approveOrder(req.params.id,'administrador');if(bot.status().connected)await bot.updateLivePanels(true);res.json({ok:true,deliveryPending:order.status!=='delivered'});void bot.tick();});
app.post('/api/orders/:id/cancel',async(req,res)=>{store.cancelOrder(req.params.id,'administrador');if(bot.status().connected)await bot.updateLivePanels(true);res.json({ok:true});});
app.post('/api/orders/:id/retry',async(req,res)=>{const order=store.one('SELECT * FROM orders WHERE id=?',req.params.id);if(order?.status!=='paid')throw new AppError('Este pedido não aguarda entrega.');if(!bot.status().connected)throw new AppError('Conecte o bot para tentar novamente.',503);await bot.tick();res.json({ok:true});});
app.post('/api/command-center/publish',async(req,res)=>res.json(await bot.publishPanel('commandCenter',id.parse(req.body.channelId))));
app.get('/api/members/:id/profile',async(req,res)=>{
  const userId=id.parse(req.params.id),discord=bot.status().connected?await bot.memberProfile(userId):null;
  const tickets=store.all('SELECT id,category,status,state,priority,created,updated,claimed_by,closed_reason,reopened_from,tags FROM tickets WHERE user_id=? ORDER BY created DESC LIMIT 50',userId).map(t=>({...t,tags:(()=>{try{return JSON.parse(t.tags||'[]')}catch{return[]}})()}));
  const orders=store.all('SELECT id,product_id,product,price,status,created,approved_at,delivered_at,coupon_code,discount FROM orders WHERE user_id=? ORDER BY created DESC LIMIT 50',userId).map(o=>({...o,product:JSON.parse(o.product)}));
  const feedback=store.all("SELECT rating,comment,submitted_at FROM feedback_requests WHERE user_id=? AND status='submitted' ORDER BY submitted_at DESC LIMIT 20",userId);
  const notes=store.all('SELECT * FROM member_notes WHERE user_id=? ORDER BY created DESC LIMIT 50',userId);
  res.json({userId,discord,tickets,orders,feedback,notes});
});
app.post('/api/members/:id/notes',(req,res)=>{const userId=id.parse(req.params.id),body=z.object({note:z.string().trim().min(2).max(1500)}).parse(req.body),noteId=randomUUID();store.run('INSERT INTO member_notes(id,user_id,actor,note,created) VALUES(?,?,?,?,?)',noteId,userId,'administrador',body.note,store.now());res.json({id:noteId});});
app.post('/api/coupons',(req,res)=>{
  const body=z.object({code:z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/),type:z.enum(['percent','fixed']),value:z.number().int().min(1).max(100000000),maxUses:z.number().int().min(0).max(100000).default(0),perUser:z.number().int().min(0).max(1000).default(1),productId:z.string().uuid().or(z.literal('')).default(''),roleId:z.string().regex(/^\d{17,20}$/).or(z.literal('')).default(''),expires:z.string().datetime().or(z.literal('')).default('')}).parse(req.body);
  const code=body.code.toUpperCase();if(body.type==='percent'&&body.value>100)throw new AppError('Cupom percentual não pode ultrapassar 100%.');
  store.run('INSERT INTO coupons(code,type,value,active,max_uses,uses,per_user,product_id,role_id,expires,created) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET type=excluded.type,value=excluded.value,active=excluded.active,max_uses=excluded.max_uses,per_user=excluded.per_user,product_id=excluded.product_id,role_id=excluded.role_id,expires=excluded.expires',code,body.type,body.value,1,body.maxUses,0,body.perUser,body.productId||null,body.roleId||null,body.expires||null,store.now());res.json({ok:true,code});
});
app.post('/api/coupons/:code/toggle',(req,res)=>{const code=String(req.params.code||'').toUpperCase(),row=store.one('SELECT active FROM coupons WHERE code=?',code);if(!row)throw new AppError('Cupom não encontrado.',404);store.run('UPDATE coupons SET active=? WHERE code=?',row.active?0:1,code);res.json({ok:true});});
app.delete('/api/coupons/:code',(req,res)=>{store.run('DELETE FROM coupons WHERE code=?',String(req.params.code||'').toUpperCase());res.json({ok:true});});
app.post('/api/alerts/:id/resolve',(req,res)=>{store.run("UPDATE alerts SET status='resolved',resolved=? WHERE id=?",store.now(),req.params.id);res.json({ok:true});});
app.post('/api/tickets/:id/note',(req,res)=>{const body=z.object({note:z.string().trim().min(2).max(1500)}).parse(req.body),t=store.one('SELECT id FROM tickets WHERE id=?',req.params.id);if(!t)throw new AppError('Ticket não encontrado.',404);const noteId=randomUUID();store.run('INSERT INTO ticket_notes(id,ticket_id,actor,note,private,created) VALUES(?,?,?,?,1,?)',noteId,t.id,'administrador',body.note,store.now());res.json({id:noteId});});
app.get('/api/tickets/:id/notes',(req,res)=>res.json(store.all('SELECT * FROM ticket_notes WHERE ticket_id=? ORDER BY created',req.params.id)));
app.post('/api/embeds/publish',async(req,res)=>{
  const body=z.object({
    source:z.enum(['messageStyle','template']),
    key:z.string().min(1).max(80),
    channelId:id
  }).parse(req.body);
  res.json(await bot.publishConfiguredMessage(body.source,body.key,body.channelId));
});
app.post('/api/tickets/publish',async(req,res)=>res.json(await bot.publishPanel('tickets',id.parse(req.body.channelId))));
app.post('/api/verification/publish',async(req,res)=>res.json(await bot.publishPanel('verification',id.parse(req.body.channelId))));
app.post('/api/tickets/:id/close',async(req,res)=>{const body=z.object({reason:z.string().trim().min(2).max(500)}).parse(req.body);await bot.closeTicket(req.params.id,'administrador',body.reason);res.json({ok:true});});
app.get('/api/tickets/:id/transcript',(req,res)=>{const t=store.one('SELECT transcript FROM tickets WHERE id=?',req.params.id);if(!t?.transcript)throw new AppError('O histórico estará disponível após encerrar o ticket.',404);res.attachment(`ticket-${req.params.id}.txt`).type('text/plain').send(t.transcript);});
app.post('/api/giveaways',async(req,res)=>res.json(await bot.createGiveaway(giveawaySchema.parse(req.body))));
app.get('/api/giveaways/:id/attempts',(req,res)=>{
  const giveaway=store.one('SELECT * FROM giveaways WHERE id=?',req.params.id);if(!giveaway)throw new AppError('Sorteio não encontrado.',404);
  const entries=new Set(store.all('SELECT user_id FROM entries WHERE giveaway_id=?',req.params.id).map(r=>r.user_id));
  res.json(store.all('SELECT * FROM giveaway_attempts WHERE giveaway_id=? ORDER BY updated DESC',req.params.id).map(r=>({...r,eligible:entries.has(r.user_id),detail:JSON.parse(r.detail)})));
});
app.post('/api/giveaways/:id/manual',async(req,res)=>{
  const body=z.object({userId:id,requirementId:z.string().min(1).max(80),approved:z.boolean()}).parse(req.body);
  const giveaway=store.one('SELECT * FROM giveaways WHERE id=?',req.params.id);if(!giveaway)throw new AppError('Sorteio não encontrado.',404);
  const data=JSON.parse(giveaway.data),requirement=(data.requirements||[]).find(r=>r.id===body.requirementId&&r.type==='manual');if(!requirement)throw new AppError('Requisito manual não encontrado.',404);
  if(body.approved)store.run('INSERT INTO giveaway_manual(giveaway_id,user_id,requirement_id,approved_by,approved_at) VALUES(?,?,?,?,?) ON CONFLICT(giveaway_id,user_id,requirement_id) DO UPDATE SET approved_by=excluded.approved_by,approved_at=excluded.approved_at',req.params.id,body.userId,body.requirementId,'administrador',store.now());
  else store.run('DELETE FROM giveaway_manual WHERE giveaway_id=? AND user_id=? AND requirement_id=?',req.params.id,body.userId,body.requirementId);
  const checked=await bot.evaluateGiveaway(req.params.id,body.userId,{enter:true,record:true});res.json(checked);
});
app.post('/api/events',async(req,res)=>res.json(await bot.createEvent(eventSchema.parse(req.body))));
app.post('/api/backups',async(req,res)=>res.json({name:await bot.makeBackup()}));
const backupPath=name=>{if(!/^studio-k-[0-9TZ-]+\.(json|sqlite)$/.test(name))throw new AppError('Arquivo inválido.');if(!readdirSync(join(store.dir,'backups')).includes(name))throw new AppError('Backup não encontrado.',404);return join(store.dir,'backups',name);};
app.get('/api/backups/:name',(req,res)=>res.download(backupPath(req.params.name)));
app.post('/api/backups/:name/restore',(req,res)=>{if(!req.params.name.endsWith('.json')||req.body.confirmed!==true)throw new AppError('Confirme a restauração das configurações.');const backup=JSON.parse(readFileSync(backupPath(req.params.name),'utf8'));store.set('settings',settingsSchema.parse(backup.settings));store.log('backup','Configurações do painel restauradas.','administrador');res.json({ok:true});});
app.use('/api',(req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
app.use('/api',(req,res)=>res.status(404).json({error:'Recurso não encontrado.'}));
app.use(express.static(join(root,'public'),{index:'index.html'}));
app.use((error,req,res,next)=>{if(res.headersSent)return next(error);if(error instanceof z.ZodError)return res.status(400).json({error:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('\n')});if(error instanceof AppError)return res.status(error.status).json({error:error.message});store.log('erro',`${req.method} ${req.path}: ${String(error.message).slice(0,500)}`);res.status(500).json({error:'A ação não foi concluída. Confira os registros e as permissões do bot.'});});
if(demo&&!store.get('demoSeeded')){
  const products=[{name:'Identidade visual',description:'Uma identidade pensada para a sua comunidade: logo, banner e direção visual.',priceCents:14990,type:'service',category:'Design'},{name:'Pack de overlays',description:'Elementos para deixar suas transmissões com a sua cara.',priceCents:3990,type:'digital',category:'Streaming'},{name:'Setup de servidor',description:'Organização, cargos e canais para começar do jeito certo.',priceCents:8990,type:'service',category:'Discord'}];
  for(const p of products){const pid=randomUUID();store.run('INSERT INTO products VALUES(?,?,?)',pid,JSON.stringify(productSchema.parse(p)),store.now());if(p.type==='digital')for(let i=1;i<=8;i++)store.run('INSERT INTO stock(id,product_id,secret) VALUES(?,?,?)',randomUUID(),pid,store.encrypt(`DEMONSTRAÇÃO · item ${i} · sem valor comercial`));}
  store.set('demoSeeded',true);store.log('demonstração','Catálogo de exemplo carregado. Nenhuma venda ou conexão real.');
}
const server=app.listen(port,host,()=>console.log(`Studio K ${demo?'[DEMONSTRAÇÃO]':''} · ${base.origin}`));
void bot.start();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await bot.stop();server.close(()=>{store.db.close();process.exit(0);});});
