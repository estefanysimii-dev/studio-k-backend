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
import { installClothTool } from './clothtool.js';
import { createBot } from './discord.js';
import { defaultRadio, radioSchema, normalizeRadio, radioSnapshot } from './radio.js';
import { settingsSchema, productSchema, messageSchema, templateSchema, giveawaySchema, eventSchema, id } from './schema.js';
import { studioIdConfig, saveStudioIdConfig, studioIdConfigSchema, studioIdentityFor, studioFavoritesFor, studioProfilePrefsFor, studioIdProfile } from './studio-id.js';
import {
  commerceAdminState,commercePublicState,upsertCommerce,deleteCommerce,setLeaderboardConfig,setFeedbackAutomationConfig,
  cartFor,setCart,notificationsFor,addNotification,markNotification,quoteCart,missionProgress,claimMission,
  recommendationsFor,globalSearch,leaderboard,activityFeed,recordVersion,versionsFor,runSchedules,productAvailability,roleBenefitFor
} from './commerce.js';
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
        body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:portfolioRedirect})
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
const portfolioBackendOrigin=new URL(process.env.PORTFOLIO_BACKEND_URL||base.origin);
const portfolioRedirect=new URL('/api/oauth/discord/callback',portfolioBackendOrigin).toString();
const portfolioPublicOrigin=new URL(process.env.PORTFOLIO_PUBLIC_URL||base.origin);
const portfolioCookieOptions={httpOnly:true,sameSite:'lax',secure:process.env.COOKIE_SECURE==='true',path:'/',maxAge:30*86400000};
const portfolioOauthCookieOptions={httpOnly:true,sameSite:'lax',secure:process.env.COOKIE_SECURE==='true',path:'/api/oauth/discord',maxAge:10*60000};
const defaultPortfolioAssistant={
  enabled:true,
  intervalSeconds:5,
  imageUrl:'/studio-assets/studio-k-mascot.webp',
  campaigns:[
    {id:'welcome',type:'cute',title:'Oi, eu sou a Kiki 💜',text:'Vou ficar por aqui te mostrando coisinhas legais do Studio K.',ctaLabel:'',href:'',priceCents:0,oldPriceCents:0,active:true},
    {id:'motivation',type:'motivation',title:'Um lembrete fofo ✨',text:'Seu projeto não precisa ficar perfeito de primeira. O importante é continuar criando.',ctaLabel:'',href:'',priceCents:0,oldPriceCents:0,active:true}
  ]
};
const defaultPortfolioSite={
  brandName:'Studio K',
  brandTagline:'SUA IDENTIDADE. SUA CIDADE.',
  logoUrl:'/studio-assets/studio-k-logo.webp',
  homeBackgroundUrl:'/media/studio-k-home.webp',
  homeBannerSlides:[],
  controlBackgroundUrl:'/media/studio-k-control.webp',
  heroEyebrow:'DESIGN 3D · FIVEM · MODA DIGITAL',
  heroTitle:'DESIGN ALÉM',
  heroAccent:'DA TEXTURA.',
  heroSubtitle:'Roupas, texturas e experiências visuais criadas para transformar personagens e projetos no GTA V / FiveM.',
  primaryCtaLabel:'Explorar Portfólio',
  secondaryCtaLabel:'Entrar no Discord',
  discordInviteUrl:'https://discord.gg/YPShX4FQCE',
  defaultAnnouncementChannelId:'',
  autoAnnounceProducts:false,
  adminRoleIds:[],
  memberDiscountPercent:0,
  memberBenefitTitle:'Benefícios exclusivos para membros',
  memberBenefitDescription:'Conecte sua conta do Discord para acessar vantagens, novidades e condições especiais do Studio K.',
  assistant:defaultPortfolioAssistant
};
const portfolioSite=()=>{
  const site={...defaultPortfolioSite,...store.get('portfolio:site',{})};
  site.radio={...defaultRadio,...site.radio};
  site.assistant={...defaultPortfolioAssistant,...(site.assistant||{})};
  site.assistant.campaigns=Array.isArray(site.assistant.campaigns)?site.assistant.campaigns:defaultPortfolioAssistant.campaigns;
  site.homeBannerSlides=Array.isArray(site.homeBannerSlides)?site.homeBannerSlides:[];
  if(!site.brandTagline||site.brandTagline==='KINETIC LOOM')site.brandTagline=defaultPortfolioSite.brandTagline;
  if(!site.logoUrl||site.logoUrl==='/media/studio-k-logo.webp')site.logoUrl=defaultPortfolioSite.logoUrl;
  if(!site.discordInviteUrl)site.discordInviteUrl=defaultPortfolioSite.discordInviteUrl;
  return site;
};
const portfolioItems=()=>{const v=store.get('portfolio:items',[]);return Array.isArray(v)?v:[]};
const storedPortfolioProducts=()=>{const v=store.get('portfolio:products',[]);return Array.isArray(v)?v:[]};
const portfolioProducts=()=>{
  const stored=storedPortfolioProducts();
  const baseProducts=stored.length?stored:store.products().map(p=>({id:p.id,name:p.name,description:p.description||'',priceCents:p.priceCents||0,category:p.category||'Studio K',tags:[],coverUrl:p.image||'',modelUrl:'',featured:false,published:true,botProductId:p.id,created:p.created||'',gender:'unisex',neon:false,stockMode:p.type==='digital'?'digital':'unlimited',stockLimit:0,limitedLabel:''}));
  const since24=new Date(Date.now()-24*3600000).toISOString();
  return baseProducts.map(product=>{
    const viewsToday=Number(store.one("SELECT COUNT(*) AS n FROM portfolio_events WHERE event='product_view' AND item_kind='product' AND item_id=? AND created>=?",product.id,since24)?.n||0);
    const favoritesTotal=Number(store.one("SELECT COUNT(*) AS n FROM portfolio_events WHERE event='favorite_add' AND item_kind='product' AND item_id=?",product.id)?.n||0);
    return{...product,...productAvailability(store,product),viewsToday,favoritesTotal};
  });
};
const portfolioAssets=()=>{const v=store.get('portfolio:assets',[]);return Array.isArray(v)?v:[]};
const portfolioDrops=()=>{const v=store.get('portfolio:drops',[]);return Array.isArray(v)?v:[]};
const portfolioDropStatus=(drop,at=Date.now())=>{
  const start=Date.parse(drop.startsAt||''),end=Date.parse(drop.endsAt||'');
  if(drop.published===false)return 'draft';
  if(Number.isFinite(end)&&end<=at)return 'ended';
  if(Number.isFinite(start)&&start>at)return 'scheduled';
  return 'active';
};
const publicPortfolioDrops=()=>portfolioDrops()
  .map(drop=>({...drop,status:portfolioDropStatus(drop)}))
  .filter(drop=>drop.status!=='draft')
  .sort((a,b)=>Date.parse(a.startsAt||'')-Date.parse(b.startsAt||''));
const activeDropForProduct=(productId,at=Date.now())=>portfolioDrops().find(drop=>
  drop.published!==false&&drop.productId===productId&&Date.parse(drop.startsAt||'')<=at&&Date.parse(drop.endsAt||'')>at
)||null;
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
    type:portfolioProduct.stockMode==='digital'?'digital':'service',
    roleId:portfolioProduct.postPurchaseRoleId||'',
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
const maybeAutoAnnouncePortfolioProduct=async(portfolioProduct,reason='publish')=>{
  const cfg=portfolioSite();
  if(!cfg.autoAnnounceProducts||!cfg.defaultAnnouncementChannelId)return{attempted:false,ok:false};
  if(!portfolioProduct?.published)return{attempted:false,ok:false};
  if(!bot.status().connected){
    const error='O bot está offline; o produto foi salvo, mas o anúncio automático não pôde ser enviado.';
    store.log('aviso',error,'portfolio-control');
    return{attempted:true,ok:false,error};
  }
  try{
    const linked=syncPortfolioProductToBot(portfolioProduct);
    const result=await bot.publishProduct(linked.botProductId,cfg.defaultAnnouncementChannelId);
    store.log('portfólio',`Produto anunciado automaticamente no Discord (${reason}): ${linked.name}`,'portfolio-control');
    return{attempted:true,ok:true,messageId:result.id,botProductId:linked.botProductId,channelId:cfg.defaultAnnouncementChannelId};
  }catch(error){
    const message=String(error?.message||error||'Falha desconhecida').slice(0,500);
    store.log('aviso',`Anúncio automático falhou para ${portfolioProduct?.name||'produto'}: ${message}`,'portfolio-control');
    return{attempted:true,ok:false,error:message,channelId:cfg.defaultAnnouncementChannelId};
  }
};

let portfolioDropProcessing=false;
const processPortfolioDrops=async()=>{
  if(portfolioDropProcessing)return;
  portfolioDropProcessing=true;
  try{
    const now=Date.now(),drops=portfolioDrops();
    let changed=false;
    for(let index=0;index<drops.length;index++){
      const drop=drops[index];
      if(portfolioDropStatus(drop,now)!=='active')continue;
      const product=portfolioProducts().find(item=>item.id===drop.productId);
      const notifyKey=`portfolio:drop-notified:${drop.id}`;
      if(!store.get(notifyKey)){
        for(const row of store.all("SELECT key FROM kv WHERE key LIKE 'portfolio:member:%'")){
          const userId=String(row.key).split(':').pop();
          addNotification(store,userId,{type:'drop',title:`Drop no ar · ${drop.title} 🔥`,text:drop.discountPercent?`${drop.discountPercent}% OFF · ${product?.name||'Studio K'}`:(product?.name||'Novo drop Studio K'),href:product?`/products/${product.id}`:'/products'});
        }
        store.set(notifyKey,{at:store.now()});
      }
      if(!bot.status().connected||!drop.announceDiscord||!drop.channelId||drop.announcedAt)continue;
      const lastAttempt=Date.parse(drop.announceAttemptAt||'');
      if(Number.isFinite(lastAttempt)&&now-lastAttempt<5*60000)continue;
      drop.announceAttemptAt=store.now();changed=true;
      if(!product){
        store.log('aviso',`Drop ${drop.title}: produto não encontrado para anúncio.`,'portfolio-scheduler',{dropId:drop.id});
        continue;
      }
      try{
        const endUnix=Math.floor(Date.parse(drop.endsAt)/1000);
        const productUrl=new URL(`/products/${encodeURIComponent(product.id)}`,portfolioPublicOrigin).toString();
        const description=[drop.description||product.description||'',drop.discountPercent?`**${drop.discountPercent}% OFF** durante o drop.`:'',Number.isFinite(endUnix)?`Termina <t:${endUnix}:R>.`:'' ].filter(Boolean).join('\n\n');
        const result=await bot.sendMessage({
          target:'channel',
          targetId:drop.channelId,
          content:'',
          embed:{
            title:`✨ DROP STUDIO K · ${drop.title}`,
            description,
            color:'#8B2CFF',
            image:portfolioAbsoluteUrl(product.coverUrl||product.gifUrl||'')
          },
          buttons:[{label:'Ver produto',type:'url',url:productUrl}]
        });
        drop.announcedAt=store.now();
        drop.announcementMessageId=result.id||'';
        store.log('portfólio',`Drop anunciado automaticamente no Discord: ${drop.title}`,'portfolio-scheduler',{dropId:drop.id,messageId:result.id||'',channelId:drop.channelId});
      }catch(error){
        store.log('aviso',`Falha ao anunciar drop ${drop.title}: ${String(error?.message||error).slice(0,400)}`,'portfolio-scheduler',{dropId:drop.id});
      }
    }
    if(changed)store.set('portfolio:drops',drops);
  }finally{
    portfolioDropProcessing=false;
  }
};
const recordPortfolioEvent=(event,{sessionId='server',userId='',itemKind='',itemId='',path='',meta={}}={})=>{
  const safeSession=String(sessionId||'server').replace(/[^A-Za-z0-9._:-]/g,'').slice(0,96)||'server';
  const safeUser=/^\d{17,20}$/.test(String(userId||''))?String(userId):null;
  const safeKind=['product','portfolio','page'].includes(String(itemKind||''))?String(itemKind):null;
  const safeId=String(itemId||'').slice(0,160)||null;
  const safePath=String(path||'').slice(0,500);
  const safeMeta=JSON.stringify(meta&&typeof meta==='object'?meta:{}).slice(0,2000);
  store.run('INSERT INTO portfolio_events(session_id,user_id,event,item_kind,item_id,path,meta,created) VALUES(?,?,?,?,?,?,?,?)',safeSession,safeUser,String(event).slice(0,40),safeKind,safeId,safePath,safeMeta,store.now());
};
const portfolioAnalyticsSummary=(days=30)=>{
  const windowDays=Math.max(1,Math.min(365,Number(days)||30));
  const since=new Date(Date.now()-windowDays*86400000).toISOString();
  const count=event=>Number(store.one('SELECT COUNT(*) AS n FROM portfolio_events WHERE event=? AND created>=?',event,since)?.n||0);
  const pageViews=count('page_view'),productViews=count('product_view'),portfolioViews=count('portfolio_view'),favoriteAdds=count('favorite_add'),checkoutStarts=count('checkout_start'),ordersCreated=count('order_created');
  const clicks=count('click'),searches=count('search'),filters=count('filter'),checkoutErrors=count('checkout_error'),cartUpdates=count('cart_update'),cartCheckouts=count('cart_checkout');
  const cartSessions=Number(store.one("SELECT COUNT(DISTINCT session_id) AS n FROM portfolio_events WHERE event='cart_update' AND created>=?",since)?.n||0);
  const cartCheckoutSessions=Number(store.one("SELECT COUNT(DISTINCT session_id) AS n FROM portfolio_events WHERE event='cart_checkout' AND created>=?",since)?.n||0);
  const uniqueVisitors=Number(store.one("SELECT COUNT(DISTINCT session_id) AS n FROM portfolio_events WHERE event='page_view' AND created>=?",since)?.n||0);
  const returningVisitors=Number(store.one("SELECT COUNT(*) AS n FROM (SELECT session_id FROM portfolio_events WHERE event='page_view' AND created>=? GROUP BY session_id HAVING COUNT(DISTINCT substr(created,1,10))>1)",since)?.n||0);
  const paid=store.one("SELECT COUNT(*) AS n,COALESCE(SUM(price),0) AS revenue FROM orders WHERE status IN ('paid','delivered') AND created>=?",since)||{};
  const paidOrders=Number(paid.n||0),revenue=Number(paid.revenue||0),avgTicket=paidOrders?Math.round(revenue/paidOrders):0;
  const topCoupons=store.all("SELECT coupon_code AS label,COUNT(*) AS value FROM orders WHERE status IN ('paid','delivered') AND created>=? AND coupon_code IS NOT NULL AND coupon_code<>'' GROUP BY coupon_code ORDER BY value DESC LIMIT 10",since).map(row=>({label:String(row.label||''),value:Number(row.value||0)}));
  const topRows=store.all("SELECT item_id, SUM(CASE WHEN event='product_view' THEN 1 ELSE 0 END) AS views, SUM(CASE WHEN event='favorite_add' THEN 1 ELSE 0 END) AS favorites, SUM(CASE WHEN event='checkout_start' THEN 1 ELSE 0 END) AS checkouts, SUM(CASE WHEN event='order_created' THEN 1 ELSE 0 END) AS orders FROM portfolio_events WHERE item_kind='product' AND item_id IS NOT NULL AND created>=? GROUP BY item_id ORDER BY views DESC,favorites DESC LIMIT 20",since);
  const rawEvents=store.all("SELECT session_id,event,item_kind,item_id,path,meta,created FROM portfolio_events WHERE created>=? ORDER BY id DESC LIMIT 10000",since);
  const productDwell=new Map(),sourceCounts=new Map(),clickCounts=new Map(),searchCounts=new Map(),exitCounts=new Map(),clickPoints=[];
  let pageDurationTotal=0,pageDurationCount=0,scrollTotal=0,scrollCount=0;
  for(const row of rawEvents){
    let meta={};try{meta=JSON.parse(row.meta||'{}')}catch{}
    if(row.event==='page_view'){
      const source=String(meta.source||meta.referrerHost||'Direto').trim().slice(0,80)||'Direto';
      sourceCounts.set(source,(sourceCounts.get(source)||0)+1);
    }else if(row.event==='page_leave'){
      const duration=Math.max(0,Math.min(3600,Number(meta.durationSec)||0));
      const scroll=Math.max(0,Math.min(100,Number(meta.scrollDepth)||0));
      if(duration){pageDurationTotal+=duration;pageDurationCount++;}
      if(Number.isFinite(scroll)){scrollTotal+=scroll;scrollCount++;}
      const path=String(row.path||'/').slice(0,160);
      exitCounts.set(path,(exitCounts.get(path)||0)+1);
    }else if(row.event==='product_dwell'&&row.item_id){
      const duration=Math.max(0,Math.min(3600,Number(meta.durationSec)||0));
      const current=productDwell.get(row.item_id)||{seconds:0,count:0};
      current.seconds+=duration;current.count+=1;productDwell.set(row.item_id,current);
    }else if(row.event==='click'){
      const label=String(meta.label||meta.href||'Clique').trim().slice(0,100);
      if(label)clickCounts.set(label,(clickCounts.get(label)||0)+1);
      const x=Number(meta.xPct),y=Number(meta.yPct);
      if(Number.isFinite(x)&&Number.isFinite(y))clickPoints.push({path:String(row.path||'/').slice(0,160),label,x:Math.max(0,Math.min(100,x)),y:Math.max(0,Math.min(100,y)),created:row.created});
    }else if(row.event==='search'){
      const query=String(meta.query||'').trim().toLowerCase().slice(0,80);
      if(query)searchCounts.set(query,(searchCounts.get(query)||0)+1);
    }
  }
  const products=portfolioProducts();
  const topProducts=topRows.map(row=>{
    const product=products.find(item=>item.id===row.item_id),dwell=productDwell.get(row.item_id)||{seconds:0,count:0};
    return{id:row.item_id,name:product?.name||'Produto removido',views:Number(row.views||0),favorites:Number(row.favorites||0),checkouts:Number(row.checkouts||0),orders:Number(row.orders||0),dwellSeconds:Math.round(dwell.seconds),avgDwellSeconds:dwell.count?Math.round(dwell.seconds/dwell.count):0};
  });
  const sortMap=(map,limit=8)=>[...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,limit).map(([label,value])=>({label,value}));
  const daily=store.all("SELECT substr(created,1,10) AS day, SUM(CASE WHEN event='page_view' THEN 1 ELSE 0 END) AS pageViews, SUM(CASE WHEN event='product_view' THEN 1 ELSE 0 END) AS productViews, SUM(CASE WHEN event='checkout_start' THEN 1 ELSE 0 END) AS checkouts, SUM(CASE WHEN event='order_created' THEN 1 ELSE 0 END) AS orders FROM portfolio_events WHERE created>=? GROUP BY substr(created,1,10) ORDER BY day",since).map(row=>({day:row.day,pageViews:Number(row.pageViews||0),productViews:Number(row.productViews||0),checkouts:Number(row.checkouts||0),orders:Number(row.orders||0)}));
  return{
    days:windowDays,pageViews,uniqueVisitors,returningVisitors,productViews,portfolioViews,favoriteAdds,checkoutStarts,ordersCreated,paidOrders,revenue,avgTicket,topCoupons,clicks,searches,filters,checkoutErrors,cartUpdates,cartCheckouts,cartSessions,cartCheckoutSessions,
    cartAbandonment:cartSessions?Math.max(0,Math.min(100,Math.round((cartSessions-cartCheckoutSessions)/cartSessions*100))):0,
    avgPageSeconds:pageDurationCount?Math.round(pageDurationTotal/pageDurationCount):0,
    avgScrollDepth:scrollCount?Math.round(scrollTotal/scrollCount):0,
    checkoutAbandonment:checkoutStarts?Math.max(0,Math.min(100,Math.round((checkoutStarts-ordersCreated)/checkoutStarts*100))):0,
    checkoutConversion:checkoutStarts?Math.max(0,Math.min(100,Math.round(paidOrders/checkoutStarts*100))):0,
    viewToOrder:productViews?Math.max(0,Math.min(100,Math.round(ordersCreated/productViews*100))):0,
    topProducts,
    topSources:sortMap(sourceCounts),
    topClicks:sortMap(clickCounts),
    topSearches:sortMap(searchCounts),
    exitPages:sortMap(exitCounts),
    clickPoints:clickPoints.slice(0,800),
    daily
  };
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
const portfolioCurrentMember=async(web,options={})=>{
  if(!web?.user?.id)return{inGuild:false,roles:[]};
  if(!bot.status().connected)return web.member||{inGuild:false,roles:[]};
  const member=await portfolioMember(web.user.id,options);
  web.member=member;
  if(web.key){
    const stored=store.get(web.key,null);
    if(stored)store.set(web.key,{...stored,member});
  }
  return member;
};
const portfolioCanControl=async(req,web=portfolioSession(req),force=false)=>{
  if(!web?.user?.id)return false;
  const member=await portfolioCurrentMember(web,{force});
  const allowed=portfolioStaffRoleIds();
  if(!allowed.length)return false;
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
  compareModelUrl:z.string().max(2000).default(''),
  viewerHotspots:z.array(z.object({
    id:z.string().trim().min(1).max(80),
    label:z.string().trim().min(1).max(120),
    position:z.string().trim().min(3).max(80),
    normal:z.string().trim().min(3).max(80).default('0 1 0')
  })).max(20).default([]),
  viewerVariants:z.array(z.object({
    id:z.string().trim().min(1).max(80),
    label:z.string().trim().min(1).max(100),
    colorHex:z.union([z.literal(''),z.string().regex(/^#[0-9a-f]{6}$/i)]).default(''),
    modelUrl:z.string().trim().min(1).max(2000),
    posterUrl:z.string().max(2000).default('')
  })).max(20).default([]),
  viewerModes:z.array(z.enum(['outfit','pieces'])).max(2).default([]),
  outfitModelUrl:z.string().max(2000).default(''),
  outfitPosterUrl:z.string().max(2000).default(''),
  viewerPieces:z.array(z.object({
    id:z.string().trim().min(1).max(80),
    label:z.string().trim().min(1).max(100),
    component:z.string().trim().max(40).default(''),
    modelUrl:z.string().trim().min(1).max(2000),
    posterUrl:z.string().max(2000).default('')
  })).max(20).default([]),
  featured:z.boolean().default(false),
  published:z.boolean().default(true)
});
const portfolioProductSchema=portfolioItemSchema.extend({
  priceCents:z.number().int().min(0).max(1000000000).default(0),
  botProductId:z.string().max(80).default(''),
  gender:z.enum(['unisex','feminino','masculino']).default('unisex'),
  neon:z.boolean().default(false),
  stockMode:z.enum(['unlimited','digital','limited','slots','numbered']).default('unlimited'),
  stockLimit:z.number().int().min(0).max(100000).default(0),
  limitedLabel:z.string().trim().max(120).default(''),
  postPurchaseRoleId:z.string().trim().regex(/^$|^\d{17,20}$/).default('')
});
const portfolioDropSchema=z.object({
  title:z.string().trim().min(2).max(140),
  description:z.string().trim().max(1200).default(''),
  productId:z.string().trim().min(1).max(160),
  discountPercent:z.number().int().min(0).max(100).default(0),
  startsAt:z.string().datetime(),
  endsAt:z.string().datetime(),
  channelId:z.union([z.literal(''),z.string().regex(/^\d{17,20}$/)]).default(''),
  announceDiscord:z.boolean().default(true),
  published:z.boolean().default(true)
}).refine(drop=>Date.parse(drop.endsAt)>Date.parse(drop.startsAt),'O fim do drop precisa ser depois do início.');
const portfolioAssistantCampaignSchema=z.object({
  id:z.string().trim().min(1).max(80),
  type:z.enum(['promotion','combo','news','bestseller','motivation','cute']).default('cute'),
  title:z.string().trim().max(140).default(''),
  text:z.string().trim().max(600).default(''),
  ctaLabel:z.string().trim().max(60).default(''),
  href:z.string().trim().max(2000).default(''),
  priceCents:z.number().int().min(0).max(1000000000).default(0),
  oldPriceCents:z.number().int().min(0).max(1000000000).default(0),
  active:z.boolean().default(true),
  priority:z.number().int().min(0).max(1000).default(100),
  startsAt:z.union([z.literal(''),z.string().datetime()]).default(''),
  endsAt:z.union([z.literal(''),z.string().datetime()]).default(''),
  pages:z.array(z.string().trim().min(1).max(240)).max(30).default([]),
  audience:z.enum(['all','guest','member']).default('all'),
  maxViews:z.number().int().min(0).max(100000).default(0)
});
const portfolioAssistantSchema=z.object({
  enabled:z.boolean().default(true),
  intervalSeconds:z.number().int().min(5).max(120).default(5),
  imageUrl:z.string().max(2000).default(defaultPortfolioAssistant.imageUrl),
  campaigns:z.array(portfolioAssistantCampaignSchema).max(50).default(defaultPortfolioAssistant.campaigns)
});
const portfolioSiteSchema=z.object({
  radio:radioSchema.default(defaultRadio),
  assistant:portfolioAssistantSchema.default(defaultPortfolioAssistant),
  brandName:z.string().trim().min(1).max(80).default(defaultPortfolioSite.brandName),
  brandTagline:z.string().trim().max(80).default(defaultPortfolioSite.brandTagline),
  logoUrl:z.string().max(2000).default(defaultPortfolioSite.logoUrl),
  homeBackgroundUrl:z.string().max(2000).default(defaultPortfolioSite.homeBackgroundUrl),
  homeBannerSlides:z.array(z.object({
    id:z.string().trim().min(1).max(80),
    imageUrl:z.string().trim().min(1).max(2000),
    alt:z.string().trim().max(180).default('')
  })).max(12).default([]),
  controlBackgroundUrl:z.string().max(2000).default(defaultPortfolioSite.controlBackgroundUrl),
  heroEyebrow:z.string().max(140).default(defaultPortfolioSite.heroEyebrow),
  heroTitle:z.string().max(160).default(defaultPortfolioSite.heroTitle),
  heroAccent:z.string().max(160).default(defaultPortfolioSite.heroAccent),
  heroSubtitle:z.string().max(900).default(defaultPortfolioSite.heroSubtitle),
  primaryCtaLabel:z.string().max(80).default(defaultPortfolioSite.primaryCtaLabel),
  secondaryCtaLabel:z.string().max(80).default(defaultPortfolioSite.secondaryCtaLabel),
  discordInviteUrl:z.string().max(2000).default(''),
  defaultAnnouncementChannelId:z.union([z.literal(''),z.string().regex(/^\d{17,20}$/)]).default(''),
  autoAnnounceProducts:z.boolean().default(false),
  adminRoleIds:z.array(z.string().regex(/^\d{17,20}$/)).max(30).default([]),
  memberDiscountPercent:z.number().int().min(0).max(100).default(defaultPortfolioSite.memberDiscountPercent),
  memberBenefitTitle:z.string().trim().max(120).default(defaultPortfolioSite.memberBenefitTitle),
  memberBenefitDescription:z.string().trim().max(500).default(defaultPortfolioSite.memberBenefitDescription)
}).superRefine((value,ctx)=>{
  if(value.autoAnnounceProducts&&!value.defaultAnnouncementChannelId){
    ctx.addIssue({code:'custom',path:['defaultAnnouncementChannelId'],message:'Selecione um canal padrão antes de ativar o anúncio automático.'});
  }
});
async function portfolioMember(userId,options={}){try{const m=bot.status().connected?await bot.memberProfile(userId,options):null;return m?{...m,inGuild:true}:{inGuild:false,roles:[]}}catch{return{inGuild:false,roles:[]}}}
const portfolioFavoritesFor=(userId)=>studioFavoritesFor(store,userId);
const portfolioIdentityFor=(userId)=>studioIdentityFor(store,userId);
const portfolioProfilePrefsFor=(userId)=>studioProfilePrefsFor(store,userId);
const portfolioMemberProfile=(userId,member={})=>studioIdProfile(store,userId,member,{
  discountPercent:Math.max(0,Number(portfolioSite().memberDiscountPercent||0))
});
const portfolioFeedbackModeration=()=>{
  const saved=store.get('portfolio:feedback-moderation',{})||{};
  const normalize=list=>[...new Set((Array.isArray(list)?list:[]).map(value=>String(value||'').trim()).filter(Boolean))].slice(0,1000);
  return{order:normalize(saved.order),hidden:normalize(saved.hidden)};
};
const savePortfolioFeedbackModeration=(value)=>{
  const submitted=new Set(store.all("SELECT id FROM feedback_requests WHERE status='submitted'").map(row=>String(row.id)));
  const normalize=list=>[...new Set((Array.isArray(list)?list:[]).map(value=>String(value||'').trim()).filter(id=>submitted.has(id)))].slice(0,1000);
  const next={order:normalize(value?.order),hidden:normalize(value?.hidden)};
  store.set('portfolio:feedback-moderation',next);
  return next;
};
async function portfolioFeedbacks(limit=500,{includeHidden=false}={}){
  const rows=store.all("SELECT id,type,source_id,user_id,rating,comment,meta,submitted_at FROM feedback_requests WHERE status='submitted' ORDER BY submitted_at DESC LIMIT ?",Math.max(1,Math.min(1000,Number(limit)||500)));
  const moderation=portfolioFeedbackModeration(),hidden=new Set(moderation.hidden),orderIndex=new Map(moderation.order.map((id,index)=>[id,index]));
  const sorted=[...rows].sort((a,b)=>{
    const ai=orderIndex.has(a.id)?orderIndex.get(a.id):Number.MAX_SAFE_INTEGER;
    const bi=orderIndex.has(b.id)?orderIndex.get(b.id):Number.MAX_SAFE_INTEGER;
    if(ai!==bi)return ai-bi;
    return String(b.submitted_at||'').localeCompare(String(a.submitted_at||''));
  });
  const visibleRows=includeHidden?sorted:sorted.filter(row=>!hidden.has(row.id));
  const limited=visibleRows.slice(0,Math.max(1,Math.min(1000,Number(limit)||500)));
  return Promise.all(limited.map(async(row,index)=>{let meta={};try{meta=JSON.parse(row.meta||'{}')}catch{}let profile=null;try{profile=await portfolioMember(row.user_id)}catch{}const source=row.type==='ticket'?'Atendimento':'Compra';const reference=row.type==='ticket'?(meta.ticket||`#${row.source_id.slice(0,8)}`):(meta.product||`#${row.source_id.slice(0,8)}`);return{id:row.id,rating:Number(row.rating||0),comment:String(row.comment||'').slice(0,1200),source,reference,name:profile?.name||'Cliente Studio K',avatar:profile?.avatar||'',submittedAt:row.submitted_at||'',visible:!hidden.has(row.id),order:index,meta:{service:meta.service||null,speed:meta.speed||null,resolution:meta.resolution||null}}}))
}
const publicPortfolioFeedbacks=(limit=500)=>portfolioFeedbacks(limit,{includeHidden:false});
const controlPortfolioFeedbacks=(limit=500)=>portfolioFeedbacks(limit,{includeHidden:true});
app.get('/api/portfolio/oauth/start',(req,res)=>{
  if(!process.env.DISCORD_CLIENT_ID||!process.env.DISCORD_CLIENT_SECRET)throw new AppError('OAuth do Discord ainda não está configurado no servidor.',503);
  const next=String(req.query.next||'/account'),safeNext=(next.startsWith('/')&&!next.startsWith('//'))?next:'/account';
  const bridge=new URL('/api/portfolio/oauth/bridge',portfolioBackendOrigin);bridge.searchParams.set('next',safeNext);res.redirect(bridge.toString());
});
app.get('/api/portfolio/oauth/bridge',(req,res)=>{
  if(!process.env.DISCORD_CLIENT_ID||!process.env.DISCORD_CLIENT_SECRET)throw new AppError('OAuth do Discord ainda não está configurado no servidor.',503);
  const next=String(req.query.next||'/account'),safeNext=(next.startsWith('/')&&!next.startsWith('//'))?next:'/account',state=randomBytes(32).toString('base64url');
  store.set(`portfolio-oauth:${hash(state)}`,{next:safeNext,expires:Date.now()+10*60000});
  res.cookie('studio_portfolio_oauth_state',state,portfolioOauthCookieOptions);
  const params=new URLSearchParams({response_type:'code',client_id:process.env.DISCORD_CLIENT_ID,scope:'identify',state,redirect_uri:portfolioRedirect,prompt:'consent'});
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
app.get('/api/portfolio/feedbacks',async(req,res)=>res.json(await publicPortfolioFeedbacks(500)));
app.post('/api/portfolio/analytics/event',portfolioSameOrigin,(req,res)=>{
  const body=z.object({
    sessionId:z.string().trim().min(8).max(96),
    event:z.enum(['page_view','page_leave','product_view','product_dwell','portfolio_view','search','filter','click','checkout_start','checkout_error','cart_update','cart_checkout','compare_open']),
    itemKind:z.enum(['product','portfolio','page']).default('page'),
    itemId:z.string().trim().max(160).default(''),
    path:z.string().trim().max(500).default(''),
    meta:z.record(z.string(),z.union([z.string(),z.number(),z.boolean(),z.null()])).default({})
  }).parse(req.body||{});
  const web=portfolioSession(req);
  recordPortfolioEvent(body.event,{sessionId:body.sessionId,userId:web?.user?.id||'',itemKind:body.itemKind,itemId:body.itemId,path:body.path,meta:body.meta});
  res.status(204).end();
});
app.get('/api/portfolio/public-state',async(req,res)=>{
  const web=portfolioSession(req),items=portfolioItems().filter(x=>x.published),products=portfolioProducts().filter(x=>x.published),feedbacks=await publicPortfolioFeedbacks(500),commerce=commercePublicState(store);
  const canControl=web?await portfolioCanControl(req,web):false;
  let me={authenticated:false,canControl:false},personal={cart:[],notifications:[],missions:[],recommendations:[],leaderboardOptIn:false,restockSubscriptions:[],ticketCategories:[],activityHistory:[]};
  if(web){
    const profile=portfolioMemberProfile(web.user.id,web.member||{});
    const missions=(commerce.missions||[]).map(mission=>({...mission,...missionProgress(store,web.user.id,web.member||{},mission)}));
    personal={
      cart:cartFor(store,web.user.id),
      notifications:notificationsFor(store,web.user.id),
      missions,
      recommendations:recommendationsFor(store,web.user.id,products,'',8),
      leaderboardOptIn:store.get(`portfolio:leaderboard-optin:${web.user.id}`,false)===true,
      restockSubscriptions:products.filter(product=>(store.get(`portfolio:restock:${product.id}`,[])||[]).includes(web.user.id)).map(product=>product.id),
      ticketCategories:store.settings().tickets?.categories||[],
      activityHistory:store.all("SELECT event,item_kind,item_id,path,meta,created FROM portfolio_events WHERE user_id=? AND event IN ('order_created','mission_claim') ORDER BY id DESC LIMIT 60",web.user.id).map(row=>{
        let meta={};try{meta=JSON.parse(row.meta||'{}')}catch{}
        const labels={
          order_created:'Compra realizada',
          mission_claim:'Missão concluída'
        };
        return{event:row.event,label:labels[row.event]||row.event,itemKind:row.item_kind||'',itemId:row.item_id||'',path:row.path||'',meta,created:row.created};
      })
    };
    me={authenticated:true,user:web.user,member:web.member,canControl,profile,favorites:portfolioFavoritesFor(web.user.id)};
  }
  res.json({
    site:portfolioSite(),status:portfolioStatus(),items,products,drops:publicPortfolioDrops(),feedbacks,me,
    commerce:{...commerce,activity:activityFeed(store,products,publicPortfolioDrops(),20),leaderboard:leaderboard(store,20)},
    personal
  });
});
app.get('/api/portfolio/me/profile',async(req,res)=>{
  const web=portfolioSession(req);
  if(!web?.user?.id)throw new AppError('Conecte sua conta do Discord para acessar seu perfil Studio K.',401);
  const member=await portfolioCurrentMember(web);
  res.json({profile:portfolioMemberProfile(web.user.id,member),favorites:portfolioFavoritesFor(web.user.id)});
});
app.put('/api/portfolio/me/profile/title',portfolioSameOrigin,async(req,res)=>{
  const web=portfolioSession(req);
  if(!web?.user?.id)throw new AppError('Conecte sua conta do Discord para personalizar seu Studio K ID.',401);
  const titleId=z.string().trim().min(1).max(80).parse(req.body?.titleId||'');
  const member=await portfolioCurrentMember(web,{force:true});
  const profile=portfolioMemberProfile(web.user.id,member);
  const title=(profile.titles||[]).find(item=>item.id===titleId);
  if(!title)throw new AppError('Este título não está disponível para os seus cargos atuais do Discord.',403);
  store.set(`portfolio:profile-prefs:${web.user.id}`,{...portfolioProfilePrefsFor(web.user.id),equippedTitleId:title.id});
  const next=portfolioMemberProfile(web.user.id,member);
  res.json({ok:true,equippedTitle:next.equippedTitle,profile:next});
});
app.get('/api/portfolio/me/ecosystem',async(req,res)=>{
  const web=portfolioSession(req);
  if(!web?.user?.id)throw new AppError('Autenticação Studio K obrigatória.',401);
  const member=await portfolioCurrentMember(web);
  const profile=portfolioMemberProfile(web.user.id,member);
  res.json({
    schemaVersion:1,
    subject:profile.studioId,
    issuedAt:store.now(),
    identity:{
      studioId:profile.studioId,
      discordId:web.user.id,
      username:web.user.username||'',
      displayName:web.user.name||web.user.username||profile.studioId,
      avatar:web.user.avatar||''
    },
    identityState:{
      title:profile.equippedTitle
    },
    entitlements:{
      discountPercent:profile.discountPercent
    }
  });
});
app.put('/api/portfolio/me/favorites/:kind/:id',portfolioSameOrigin,(req,res)=>{
  const web=portfolioSession(req);
  if(!web?.user?.id)throw new AppError('Conecte sua conta do Discord para salvar favoritos.',401);
  const kind=String(req.params.kind||'');
  const itemId=String(req.params.id||'').slice(0,160);
  if(!['items','products'].includes(kind))throw new AppError('Tipo de favorito inválido.',400);
  const source=kind==='products'?portfolioProducts():portfolioItems();
  if(!source.some(entry=>entry.id===itemId&&entry.published!==false))throw new AppError('Item não encontrado.',404);
  const favorites=portfolioFavoritesFor(web.user.id);
  const shouldFavorite=req.body?.favorite!==false;
  const list=new Set(favorites[kind]);
  if(shouldFavorite)list.add(itemId);else list.delete(itemId);
  favorites[kind]=[...list].slice(0,500);
  store.set(`portfolio:favorites:${web.user.id}`,favorites);
  recordPortfolioEvent(shouldFavorite?'favorite_add':'favorite_remove',{sessionId:`member:${web.user.id}`,userId:web.user.id,itemKind:kind==='products'?'product':'portfolio',itemId,path:req.get('referer')||''});
  const profile=portfolioMemberProfile(web.user.id,web.member||{});
  res.json({ok:true,favorite:shouldFavorite,favorites,profile});
});
app.get('/api/portfolio/search',(req,res)=>res.json({results:globalSearch(store,portfolioProducts().filter(x=>x.published!==false),portfolioItems().filter(x=>x.published!==false),req.query.q)}));
app.get('/api/portfolio/products/:id/recommendations',(req,res)=>{
  const web=portfolioSession(req),products=portfolioProducts().filter(x=>x.published!==false);
  res.json({recommendations:recommendationsFor(store,web?.user?.id||'',products,String(req.params.id||''),8)});
});
app.get('/api/portfolio/me/cart',(req,res)=>{
  const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta do Discord para usar o carrinho.',401);
  res.json({cart:cartFor(store,web.user.id),quote:quoteCart(store,web.user.id,web.member||{},portfolioProducts().filter(x=>x.published!==false),String(req.query.coupon||''),Math.max(0,Math.min(100,Number(portfolioSite().memberDiscountPercent||0))))});
});
app.put('/api/portfolio/me/cart',portfolioSameOrigin,(req,res)=>{
  const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta do Discord para usar o carrinho.',401);
  const items=z.array(z.object({productId:z.string().trim().min(1).max(160),quantity:z.number().int().min(1).max(20)})).max(50).parse(req.body?.items||[]);
  setCart(store,web.user.id,items);
  recordPortfolioEvent('cart_update',{sessionId:`member:${web.user.id}`,userId:web.user.id,itemKind:'page',path:'/cart',meta:{items:items.length}});
  res.json({cart:cartFor(store,web.user.id),quote:quoteCart(store,web.user.id,web.member||{},portfolioProducts().filter(x=>x.published!==false),String(req.body?.couponCode||''),Math.max(0,Math.min(100,Number(portfolioSite().memberDiscountPercent||0))))});
});
app.post('/api/portfolio/me/cart/checkout',portfolioSameOrigin,async(req,res)=>{
  const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta do Discord para finalizar o carrinho.',401);
  if(!demo)await bot.member(web.user.id);
  const products=portfolioProducts().filter(x=>x.published!==false),couponCode=String(req.body?.couponCode||'').trim().slice(0,40),quote=quoteCart(store,web.user.id,web.member||{},products,couponCode,Math.max(0,Math.min(100,Number(portfolioSite().memberDiscountPercent||0))));
  if(!quote.items.length)throw new AppError('Seu carrinho está vazio.');
  const expanded=[];for(const line of quote.items)for(let n=0;n<line.quantity;n++)expanded.push(line);
  if(expanded.length>20)throw new AppError('O carrinho pode finalizar até 20 unidades por vez.');
  const created=[];
  try{
    for(const line of expanded){
      let product=products.find(p=>p.id===line.productId);
      if(!product)throw new AppError(`${line.name} não está mais disponível.`,409);
      const availability=productAvailability(store,product);
      if(availability.available===false)throw new AppError(`${line.name} esgotou ou ficou sem vagas antes da finalização.`,409);
      product=syncPortfolioProductToBot(product);
      const order=store.createOrder(product.botProductId,web.user.id,'');
      if(product.stockMode==='numbered'){
        const editionNumber=Math.max(1,productAvailability(store,product).soldCount);
        store.set(`portfolio:numbered-order:${order.id}`,{number:editionNumber,total:Number(product.stockLimit||0),label:product.limitedLabel||'Edição limitada'});
      }
      created.push({order,product,line});
    }
    const roleSubtotal=created.reduce((sum,x)=>sum+Number(x.line.unitPrice||0),0),extra=Math.max(0,quote.bundleDiscount+quote.couponDiscount);
    let allocated=0;
    for(let i=0;i<created.length;i++){
      const row=created[i],base=Math.max(0,Number(row.line.unitPrice||0));
      const part=i===created.length-1?Math.max(0,extra-allocated):(roleSubtotal?Math.floor(extra*base/roleSubtotal):0);
      allocated+=part;
      const finalPrice=Math.max(0,base-part),discount=Math.max(0,Number(row.product.priceCents||0)-finalPrice);
      store.run('UPDATE orders SET price=?,discount=? WHERE id=?',finalPrice,discount,row.order.id);
    }
  }catch(error){
    for(const row of created){try{store.cancelOrder(row.order.id,'cart-rollback')}catch{}}
    throw error;
  }
  const groupId=randomUUID(),orderIds=created.map(x=>x.order.id);store.set(`portfolio:cart-group:${groupId}`,{userId:web.user.id,orderIds,quote,created:store.now()});
  setCart(store,web.user.id,[]);
  if(couponCode&&quote.coupon){
    const cp=store.one('SELECT * FROM coupons WHERE code=?',quote.coupon.code);
    if(cp){store.run('UPDATE coupons SET uses=uses+1 WHERE code=?',quote.coupon.code);store.run('INSERT OR IGNORE INTO coupon_uses(code,user_id,order_id,created) VALUES(?,?,?,?)',quote.coupon.code,web.user.id,orderIds[0],store.now());store.run('UPDATE orders SET coupon_code=? WHERE id=?',quote.coupon.code,orderIds[0]);}
  }
  addNotification(store,web.user.id,{type:'order',title:'Carrinho convertido em pedido 💜',text:`${orderIds.length} item(ns) · total R$ ${(quote.total/100).toFixed(2).replace('.',',')}`,href:'/account'});
  recordPortfolioEvent('cart_checkout',{sessionId:`member:${web.user.id}`,userId:web.user.id,itemKind:'page',path:'/cart',meta:{groupId,items:orderIds.length,total:quote.total}});
  const sales=store.settings().sales||{};
  res.json({groupId,orderIds,total:quote.total,quote,payment:{pixKey:sales.pixKey||'',recipient:sales.recipient||'',instructions:sales.instructions||''}});
});
app.get('/api/portfolio/me/notifications',(req,res)=>{const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta.',401);res.json({notifications:notificationsFor(store,web.user.id)});});
app.put('/api/portfolio/me/notifications/:id',portfolioSameOrigin,(req,res)=>{const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta.',401);res.json({notifications:markNotification(store,web.user.id,req.params.id,req.body?.read!==false)});});
app.post('/api/portfolio/me/notifications/read-all',portfolioSameOrigin,(req,res)=>{const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta.',401);const items=notificationsFor(store,web.user.id).map(x=>({...x,read:true}));store.set(`portfolio:notifications:${web.user.id}`,items);res.json({notifications:items});});
app.post('/api/portfolio/me/missions/:id/claim',portfolioSameOrigin,(req,res)=>{
  const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta.',401);
  const mission=(store.get('portfolio:missions',[])||[]).find(item=>item.id===req.params.id)||null;
  const result=claimMission(store,web.user.id,web.member||{},req.params.id);
  recordPortfolioEvent('mission_claim',{sessionId:`member:${web.user.id}`,userId:web.user.id,itemKind:'page',itemId:req.params.id,path:'/account',meta:{title:mission?.title||'Missão Studio K'}});
  res.json({result,profile:portfolioMemberProfile(web.user.id,web.member||{})});
});
app.put('/api/portfolio/me/leaderboard',portfolioSameOrigin,(req,res)=>{const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta.',401);store.set(`portfolio:leaderboard-optin:${web.user.id}`,req.body?.enabled===true);res.json({enabled:req.body?.enabled===true});});
app.put('/api/portfolio/me/restock/:productId',portfolioSameOrigin,(req,res)=>{
  const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta para receber aviso de reposição.',401);
  const product=portfolioProducts().find(item=>item.id===req.params.productId&&item.published!==false);
  if(!product)throw new AppError('Produto não encontrado.',404);
  const key=`portfolio:restock:${product.id}`,current=[...new Set(store.get(key,[])||[])],enabled=req.body?.enabled!==false;
  const next=enabled?[...new Set([...current,web.user.id])]:current.filter(id=>id!==web.user.id);
  store.set(key,next);
  res.json({enabled,productId:product.id});
});
app.post('/api/portfolio/me/upload-ticket',portfolioSameOrigin,(req,res)=>{
  const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta para enviar mídia.',401);
  const name=z.string().trim().min(1).max(180).parse(req.body?.name||'arquivo');
  const ext=(name.toLowerCase().match(/\.([a-z0-9]{2,8})$/)?.[1]||'');
  if(!['png','jpg','jpeg','webp','gif','mp4'].includes(ext))throw new AppError('Formato não suportado. Use PNG, WebP, JPEG, JPG, GIF ou MP4.',400);
  const token=randomBytes(32).toString('base64url');
  store.set(`portfolio-upload:${hash(token)}`,{userId:web.user.id,name,public:true,expires:Date.now()+5*60000});
  const uploadUrl=new URL(`/api/portfolio/upload/${encodeURIComponent(token)}`,portfolioBackendOrigin);
  res.json({token,uploadUrl:uploadUrl.toString(),expiresIn:300});
});

app.post('/api/portfolio/me/gallery',portfolioSameOrigin,(req,res)=>{
  const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta para enviar uma imagem.',401);
  const body=z.object({name:z.string().trim().min(1).max(100),caption:z.string().trim().max(600).default(''),imageUrl:z.string().trim().min(1).max(2000),productIds:z.array(z.string().trim().min(1).max(160)).max(20).default([])}).parse(req.body||{});
  const item=upsertCommerce(store,'gallery',{...body,userId:web.user.id,status:'pending'});
  addNotification(store,web.user.id,{type:'gallery',title:'Imagem enviada para aprovação ✨',text:'A equipe Studio K vai revisar sua publicação antes dela aparecer na comunidade.',href:'/community'});
  res.json(item);
});
app.post('/api/portfolio/me/tickets',portfolioSameOrigin,async(req,res)=>{
  const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta para abrir um atendimento.',401);
  if(!bot.status().connected)throw new AppError('O bot está offline. Tente novamente quando o atendimento estiver disponível.',503);
  const categories=store.settings().tickets?.categories||['Suporte'];
  const category=z.string().trim().min(1).max(80).parse(req.body?.category||categories[0]||'Suporte');
  if(!categories.includes(category))throw new AppError('Categoria de atendimento inválida.',400);
  const ticket=await bot.openTicket(web.user.id,category);
  addNotification(store,web.user.id,{type:'ticket',title:'Atendimento aberto',text:`${category} já está disponível na sua conta e no Discord.`,href:'/account'});
  res.json({ok:true,ticket});
});
app.get('/api/portfolio/me/tickets',async(req,res)=>{
  const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta para ver seus atendimentos.',401);
  const tickets=store.all('SELECT id,channel_id,category,status,state,priority,created,updated,claimed_by,closed_reason,transcript FROM tickets WHERE user_id=? ORDER BY created DESC LIMIT 100',web.user.id);
  const mapped=[];
  for(const t of tickets){
    let claimedName='';
    if(t.claimed_by&&bot.status().connected){
      try{claimedName=(await bot.memberProfile(t.claimed_by))?.name||'';}catch{}
    }
    mapped.push({...t,claimedName,notes:store.all("SELECT actor,note,private,created FROM ticket_notes WHERE ticket_id=? AND private=0 ORDER BY created",t.id),transcriptAvailable:!!t.transcript});
  }
  res.json({tickets:mapped});
});
app.get('/api/portfolio/me/tickets/:id/transcript',(req,res)=>{
  const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta para ver o transcript.',401);
  const ticket=store.one('SELECT id,transcript,status FROM tickets WHERE id=? AND user_id=?',req.params.id,web.user.id);
  if(!ticket)throw new AppError('Atendimento não encontrado.',404);
  if(!ticket.transcript)throw new AppError('O transcript estará disponível após o encerramento.',409);
  res.json({id:ticket.id,transcript:ticket.transcript});
});
app.get('/api/portfolio/me/tickets/:id/messages',async(req,res)=>{
  const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta para ver o atendimento.',401);
  if(!bot.status().connected)throw new AppError('O bot está offline. O histórico salvo continua disponível, mas as mensagens ao vivo precisam do bot conectado.',503);
  res.json({messages:await bot.webTicketMessages(req.params.id,web.user.id)});
});
app.post('/api/portfolio/me/tickets/:id/reply',portfolioSameOrigin,async(req,res)=>{
  const web=portfolioSession(req);if(!web?.user?.id)throw new AppError('Conecte sua conta para responder.',401);
  if(!bot.status().connected)throw new AppError('O bot está offline.',503);
  const text=z.string().trim().min(1).max(1800).parse(req.body?.text||'');
  const result=await bot.webTicketReply(req.params.id,web.user.id,text);
  addNotification(store,web.user.id,{type:'ticket',title:'Mensagem enviada ao atendimento',text:'Sua resposta foi enviada para a equipe Studio K.',href:'/account'});
  res.json({ok:true,...result});
});
app.get('/api/portfolio/me/orders',(req,res)=>{
  const web=portfolioSession(req);
  if(!web?.user?.id)throw new AppError('Conecte sua conta do Discord para ver seus pedidos.',401);
  const orders=store.all('SELECT id,product_id,product,price,status,created,expires,approved_at,delivered_at,coupon_code,discount,error FROM orders WHERE user_id=? ORDER BY created DESC LIMIT 100',web.user.id).map(order=>{
    let product={};try{product=JSON.parse(order.product||'{}')}catch{}
    const edition=store.get(`portfolio:numbered-order:${order.id}`,null);
    return{
      id:order.id,
      productId:order.product_id,
      productName:product.name||'Produto Studio K',
      edition:edition||null,
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
  let product=portfolioProducts().find(item=>item.id===req.params.id&&item.published!==false);
  if(!product)throw new AppError('Produto não encontrado.',404);
  if(product.available===false)throw new AppError('Este produto está esgotado ou sem vagas disponíveis.',409);
  product=syncPortfolioProductToBot(product);
  if(!demo)await bot.member(web.user.id);
  const couponCode=String(req.body?.couponCode||'').trim().slice(0,40);
  let order=store.createOrder(product.botProductId,web.user.id,couponCode);
  if(product.stockMode==='numbered'){
    const editionNumber=Math.max(1,productAvailability(store,product).soldCount);
    store.set(`portfolio:numbered-order:${order.id}`,{number:editionNumber,total:Number(product.stockLimit||0),label:product.limitedLabel||'Edição limitada'});
  }
  const activeDrop=activeDropForProduct(product.id);
  const dropDiscountPercent=Math.max(0,Math.min(100,Number(activeDrop?.discountPercent||0)));
  if(dropDiscountPercent>0&&Number(order.price||0)>0){
    const dropDiscount=Math.floor(Number(order.price||0)*dropDiscountPercent/100);
    if(dropDiscount>0){
      store.run('UPDATE orders SET price=?,discount=COALESCE(discount,0)+? WHERE id=?',Math.max(0,Number(order.price||0)-dropDiscount),dropDiscount,order.id);
      order=store.one('SELECT * FROM orders WHERE id=?',order.id);
    }
  }
  const memberDiscountPercent=Math.max(0,Math.min(100,Number(portfolioSite().memberDiscountPercent||0)));
  const collectionIds=(commercePublicState(store).collections||[]).filter(collection=>(collection.productIds||[]).includes(product.id)).map(collection=>collection.id);
  const discordBenefit=roleBenefitFor(store,web.member||{},product.id,collectionIds);
  const discordBenefitAllowed=!order.coupon_code||discordBenefit?.stackWithCoupon===true;
  const rolePercent=discordBenefitAllowed?Math.max(0,Math.min(100,Number(discordBenefit?.discountPercent||0))):0;
  const effectiveBenefitPercent=Math.max(memberDiscountPercent,rolePercent);
  if(effectiveBenefitPercent>0&&Number(order.price||0)>0){
    const memberDiscount=Math.floor(Number(order.price||0)*effectiveBenefitPercent/100);
    if(memberDiscount>0){
      store.run('UPDATE orders SET price=?,discount=COALESCE(discount,0)+? WHERE id=?',Math.max(0,Number(order.price||0)-memberDiscount),memberDiscount,order.id);
      order=store.one('SELECT * FROM orders WHERE id=?',order.id);
    }
  }
  recordPortfolioEvent('order_created',{sessionId:`member:${web.user.id}`,userId:web.user.id,itemKind:'product',itemId:product.id,path:`/products/${product.id}`,meta:{orderId:order.id,price:Number(order.price||0)}});
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
installClothTool(app,{store,control:portfolioControl,sameOrigin:portfolioSameOrigin,
  canControl:userId=>portfolioCanControl(null,{user:{id:userId}},true),publicOrigin:portfolioPublicOrigin});
app.get('/api/portfolio/control/state',portfolioControl,async(req,res)=>{
  let channels=[],roles=[];
  const cartGroups=store.all("SELECT key,value FROM kv WHERE key LIKE 'portfolio:cart-group:%'").map(row=>{
    let value={};try{value=JSON.parse(row.value||'{}')}catch{}
    const id=String(row.key).split(':').pop(),orderIds=Array.isArray(value.orderIds)?value.orderIds:[];
    const orders=orderIds.map(orderId=>store.one('SELECT id,status,price,product,user_id,approved_by,created FROM orders WHERE id=?',orderId)).filter(Boolean);
    return{id,userId:value.userId||orders[0]?.user_id||'',created:value.created||orders[0]?.created||'',quote:value.quote||null,orders,total:orders.reduce((sum,order)=>sum+Number(order.price||0),0)};
  }).sort((a,b)=>String(b.created||'').localeCompare(String(a.created||''))).slice(0,200);
  if(bot.status().connected){
    try{
      const meta=await bot.metadata();
      channels=(meta.announcementChannels||[])
        .map(channel=>({id:channel.id,name:channel.name,type:channel.type}))
        .sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'pt-BR'))
        .slice(0,250);
      roles=(meta.roles||[])
        .map(role=>({id:role.id,name:role.name}))
        .sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'pt-BR'))
        .slice(0,250);
    }catch{}
  }
  res.json({
    authorized:true,
    user:req.portfolioWeb?.user||{name:'Administrador Studio K'},
    site:portfolioSite(),
    studioIdConfig:studioIdConfig(store),
    status:portfolioStatus(),
    items:portfolioItems(),
    products:portfolioProducts(),
    drops:portfolioDrops().map(drop=>({...drop,status:portfolioDropStatus(drop)})),
    analytics:portfolioAnalyticsSummary(30),
    assets:portfolioAssets(),
    feedbacks:await controlPortfolioFeedbacks(500),
    commerce:commerceAdminState(store),
    versions:versionsFor(store).slice(0,300),
    cartGroups,
    discord:{
      oauthConfigured:!!(process.env.DISCORD_CLIENT_ID&&process.env.DISCORD_CLIENT_SECRET),
      redirectUri:portfolioRedirect,
      publicOrigin:portfolioPublicOrigin.origin,
      botConnected:!!bot.status().connected,
      channels,
      roles
    }
  });
});
app.get('/api/portfolio/radio',(req,res)=>{res.set('Cache-Control','no-store');res.json(radioSnapshot(portfolioSite().radio));});
app.put('/api/portfolio/control/site',portfolioControl,portfolioSameOrigin,(req,res)=>{const current=portfolioSite(),next=portfolioSiteSchema.parse({...current,...req.body});next.radio=normalizeRadio(next.radio,current.radio);store.set('portfolio:site',next);recordVersion(store,{entityType:'site',entityId:'main',before:current,after:next,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'update'});store.log('portfólio','Configurações do site atualizadas.','portfolio-control');res.json(next)});
app.put('/api/portfolio/control/studio-id',portfolioControl,portfolioSameOrigin,(req,res)=>{
  const previous=studioIdConfig(store),next=saveStudioIdConfig(store,req.body||{});
  recordVersion(store,{entityType:'studioId',entityId:'main',before:previous,after:next,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'update'});
  store.log('portfólio','Configurações do Studio K ID atualizadas.','portfolio-control');
  res.json(next);
});
app.put('/api/portfolio/control/feedbacks',portfolioControl,portfolioSameOrigin,async(req,res)=>{
  const body=z.object({
    order:z.array(z.string().trim().min(1).max(120)).max(1000).default([]),
    hidden:z.array(z.string().trim().min(1).max(120)).max(1000).default([])
  }).parse(req.body||{});
  const previous=portfolioFeedbackModeration(),moderation=savePortfolioFeedbackModeration(body);
  recordVersion(store,{entityType:'feedbackModeration',entityId:'main',before:previous,after:moderation,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'update'});
  store.log('portfólio',`Organização de feedbacks atualizada: ${moderation.order.length} ordenados · ${moderation.hidden.length} ocultos`,'portfolio-control');
  res.json({ok:true,moderation,feedbacks:await controlPortfolioFeedbacks(500)});
});
app.put('/api/portfolio/control/commerce/:kind',portfolioControl,portfolioSameOrigin,(req,res)=>{
  const kind=String(req.params.kind||''),incomingId=String(req.body?.id||''),adminState=commerceAdminState(store);
  const before=incomingId&&Array.isArray(adminState[kind])?adminState[kind].find(item=>item.id===incomingId)||null:null;
  const item=upsertCommerce(store,kind,req.body||{});
  recordVersion(store,{entityType:kind,entityId:item.id,before,after:item,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:before?'update':'create'});
  res.json(item);
});
app.delete('/api/portfolio/control/commerce/:kind/:id',portfolioControl,portfolioSameOrigin,(req,res)=>{
  const kind=String(req.params.kind||''),idValue=String(req.params.id||''),before=(commerceAdminState(store)[kind]||[]).find(x=>x.id===idValue)||null;
  const result=deleteCommerce(store,kind,idValue);
  recordVersion(store,{entityType:kind,entityId:idValue,before,after:null,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'delete'});
  res.json(result);
});
app.put('/api/portfolio/control/leaderboard',portfolioControl,portfolioSameOrigin,(req,res)=>res.json(setLeaderboardConfig(store,req.body||{})));
app.post('/api/portfolio/control/cart-groups/:id/approve',portfolioControl,portfolioSameOrigin,async(req,res)=>{
  const key=`portfolio:cart-group:${req.params.id}`,group=store.get(key,null);
  if(!group)throw new AppError('Grupo de carrinho não encontrado.',404);
  const actor=req.portfolioWeb?.user?.id||'portfolio-control',approved=[];
  for(const orderId of group.orderIds||[]){
    const order=store.one('SELECT * FROM orders WHERE id=?',orderId);
    if(!order)continue;
    if(order.status==='pending')store.approveOrder(orderId,actor);
    approved.push(orderId);
  }
  store.log('pagamento',`Carrinho ${req.params.id.slice(0,8)} aprovado em grupo (${approved.length} itens).`,actor,{groupId:req.params.id,orderIds:approved});
  recordVersion(store,{entityType:'cartGroup',entityId:req.params.id,before:{status:'pending'},after:{status:'paid',orderIds:approved},actor,action:'approve'});
  if(bot.status().connected)await bot.tick().catch(()=>{});
  addNotification(store,group.userId,{type:'order',title:'Pagamento do carrinho aprovado 💜',text:`${approved.length} item(ns) foram aprovados e seguiram para entrega.`,href:'/account'});
  res.json({ok:true,approved});
});
app.put('/api/portfolio/control/feedback-automation',portfolioControl,portfolioSameOrigin,(req,res)=>{
  const previous=commerceAdminState(store).feedbackAutomation||{enabled:true,delayHours:24};
  const next=setFeedbackAutomationConfig(store,req.body||{});
  recordVersion(store,{entityType:'feedbackAutomation',entityId:'main',before:previous,after:next,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'update'});
  res.json(next);
});
app.get('/api/portfolio/control/versions',portfolioControl,(req,res)=>res.json(versionsFor(store).slice(0,500)));
app.post('/api/portfolio/control/versions/:id/restore',portfolioControl,portfolioSameOrigin,(req,res)=>{
  const version=versionsFor(store).find(x=>x.id===req.params.id);if(!version)throw new AppError('Versão não encontrada.',404);
  if(!version.before)throw new AppError('Esta versão não possui estado anterior para restaurar.',409);
  if(['bundles','collections','missions','banners','roleBenefits','schedules','gallery','lookbooks'].includes(version.entityType)){
    const restored=upsertCommerce(store,version.entityType,version.before);
    recordVersion(store,{entityType:version.entityType,entityId:version.entityId,before:version.after,after:restored,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'restore'});
    return res.json(restored);
  }
  if(version.entityType==='site'){
    const current=portfolioSite();store.set('portfolio:site',portfolioSiteSchema.parse(version.before));
    recordVersion(store,{entityType:'site',entityId:'main',before:current,after:version.before,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'restore'});
    return res.json(version.before);
  }
  if(version.entityType==='studioId'){
    const current=studioIdConfig(store),restored=saveStudioIdConfig(store,version.before);
    recordVersion(store,{entityType:'studioId',entityId:'main',before:current,after:restored,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'restore'});
    return res.json(restored);
  }
  if(version.entityType==='feedbackModeration'){
    const current=portfolioFeedbackModeration(),restored=savePortfolioFeedbackModeration(version.before);
    recordVersion(store,{entityType:'feedbackModeration',entityId:'main',before:current,after:restored,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'restore'});
    return res.json(restored);
  }
  if(version.entityType==='feedbackAutomation'){
    const current=commerceAdminState(store).feedbackAutomation||{enabled:true,delayHours:24},restored=setFeedbackAutomationConfig(store,version.before);
    recordVersion(store,{entityType:'feedbackAutomation',entityId:'main',before:current,after:restored,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'restore'});
    return res.json(restored);
  }
  if(version.entityType==='drop'){
    const drops=portfolioDrops(),index=drops.findIndex(item=>item.id===version.entityId);
    if(index>=0)drops[index]=version.before;else drops.unshift(version.before);store.set('portfolio:drops',drops);
    recordVersion(store,{entityType:'drop',entityId:version.entityId,before:version.after,after:version.before,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'restore'});
    return res.json(version.before);
  }
  if(version.entityType==='product'||version.entityType==='item'){
    const key=version.entityType==='product'?'portfolio:products':'portfolio:items',current=version.entityType==='product'?storedPortfolioProducts():portfolioItems(),index=current.findIndex(x=>x.id===version.entityId);
    if(index>=0)current[index]=version.before;else current.unshift(version.before);store.set(key,current);
    recordVersion(store,{entityType:version.entityType,entityId:version.entityId,before:version.after,after:version.before,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'restore'});
    return res.json(version.before);
  }
  throw new AppError('Restauração automática ainda não é suportada para este tipo.',409);
});
app.post('/api/portfolio/control/items',portfolioControl,portfolioSameOrigin,(req,res)=>{const item={id:randomUUID(),...portfolioItemSchema.parse(req.body),created:store.now(),updated:store.now()};const items=portfolioItems();if(item.featured)for(const x of items)x.featured=false;items.unshift(item);store.set('portfolio:items',items);recordVersion(store,{entityType:'item',entityId:item.id,before:null,after:item,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'create'});res.json(item)});
app.put('/api/portfolio/control/items/:id',portfolioControl,portfolioSameOrigin,(req,res)=>{const items=portfolioItems(),index=items.findIndex(x=>x.id===req.params.id);if(index<0)throw new AppError('Projeto não encontrado.',404);const previous=items[index],next={...previous,...portfolioItemSchema.parse(req.body),updated:store.now()};if(next.featured)for(const x of items)x.featured=false;items[index]=next;store.set('portfolio:items',items);recordVersion(store,{entityType:'item',entityId:next.id,before:previous,after:next,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'update'});res.json(next)});
app.delete('/api/portfolio/control/items/:id',portfolioControl,portfolioSameOrigin,(req,res)=>{const items=portfolioItems(),previous=items.find(x=>x.id===req.params.id)||null;store.set('portfolio:items',items.filter(x=>x.id!==req.params.id));if(previous)recordVersion(store,{entityType:'item',entityId:req.params.id,before:previous,after:null,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'delete'});res.json({ok:true})});
app.post('/api/portfolio/control/products',portfolioControl,portfolioSameOrigin,async(req,res)=>{
  const item={id:randomUUID(),...portfolioProductSchema.parse(req.body),created:store.now(),updated:store.now()};
  const products=storedPortfolioProducts();
  if(item.featured)for(const x of products)x.featured=false;
  products.unshift(item);
  store.set('portfolio:products',products);
  recordVersion(store,{entityType:'product',entityId:item.id,before:null,after:item,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'create'});
  if(item.published){
    for(const row of store.all("SELECT key FROM kv WHERE key LIKE 'portfolio:member:%'")){
      const userId=String(row.key).split(':').pop();addNotification(store,userId,{type:'product',title:'Novo produto no Studio K ✨',text:item.name,href:`/products/${item.id}`});
    }
  }
  const announcement=item.published?await maybeAutoAnnouncePortfolioProduct(item,'novo produto'):{attempted:false,ok:false};
  const saved=portfolioProducts().find(product=>product.id===item.id)||item;
  res.json({...saved,_announcement:announcement});
});
app.put('/api/portfolio/control/products/:id',portfolioControl,portfolioSameOrigin,async(req,res)=>{
  let products=storedPortfolioProducts();
  if(!products.length)products=portfolioProducts();
  const productIndex=products.findIndex(x=>x.id===req.params.id);
  if(productIndex<0)throw new AppError('Produto não encontrado.',404);
  const previous=products[productIndex],previousAvailability=productAvailability(store,previous);
  const next={...previous,...portfolioProductSchema.parse(req.body),updated:store.now()};
  if(next.featured)for(const x of products)x.featured=false;
  products[productIndex]=next;
  store.set('portfolio:products',products);
  recordVersion(store,{entityType:'product',entityId:next.id,before:previous,after:next,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'update'});
  const nextAvailability=productAvailability(store,next);
  if(previousAvailability.available===false&&nextAvailability.available===true){
    const restockKey=`portfolio:restock:${next.id}`,subscribers=[...new Set(store.get(restockKey,[])||[])];
    for(const userId of subscribers)addNotification(store,userId,{type:'restock',title:'Disponível novamente ✨',text:next.name,href:`/products/${next.id}`});
    if(subscribers.length)store.set(restockKey,[]);
  }
  const becamePublished=previous.published===false&&next.published===true;
  if(becamePublished){
    for(const row of store.all("SELECT key FROM kv WHERE key LIKE 'portfolio:member:%'")){
      const userId=String(row.key).split(':').pop();addNotification(store,userId,{type:'product',title:'Novo produto disponível ✨',text:next.name,href:`/products/${next.id}`});
    }
  }
  const announcement=becamePublished?await maybeAutoAnnouncePortfolioProduct(next,'produto publicado'):{attempted:false,ok:false};
  const saved=portfolioProducts().find(product=>product.id===next.id)||next;
  res.json({...saved,_announcement:announcement});
});
app.delete('/api/portfolio/control/products/:id',portfolioControl,portfolioSameOrigin,(req,res)=>{const products=storedPortfolioProducts(),previous=products.find(x=>x.id===req.params.id)||null;store.set('portfolio:products',products.filter(x=>x.id!==req.params.id));if(previous)recordVersion(store,{entityType:'product',entityId:req.params.id,before:previous,after:null,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'delete'});res.json({ok:true})});
app.post('/api/portfolio/control/products/:id/sync-bot',portfolioControl,portfolioSameOrigin,(req,res)=>{
  const product=portfolioProducts().find(item=>item.id===req.params.id);
  if(!product)throw new AppError('Produto não encontrado.',404);
  const linked=syncPortfolioProductToBot(product);
  store.log('portfólio',`Produto sincronizado com o bot: ${linked.name}`,'portfolio-control');
  res.json({ok:true,product:linked,botProductId:linked.botProductId});
});
app.post('/api/portfolio/control/products/:id/stock',portfolioControl,portfolioSameOrigin,(req,res)=>{
  let product=portfolioProducts().find(item=>item.id===req.params.id);
  if(!product)throw new AppError('Produto não encontrado.',404);
  if(product.stockMode!=='digital')throw new AppError('Este produto não usa estoque digital.',409);
  if(!product.botProductId)product=syncPortfolioProductToBot(product);
  const items=z.array(z.string().trim().min(1).max(1200)).min(1).max(1000).parse(req.body?.items||[]);
  store.transaction(()=>{for(const item of items)store.run('INSERT INTO stock(id,product_id,secret) VALUES(?,?,?)',randomUUID(),product.botProductId,store.encrypt(item));});
  const availability=productAvailability(store,product);
  if(availability.available){
    const restockKey=`portfolio:restock:${product.id}`,subscribers=[...new Set(store.get(restockKey,[])||[])];
    for(const userId of subscribers)addNotification(store,userId,{type:'restock',title:'Voltou ao estoque ✨',text:product.name,href:`/products/${product.id}`});
    if(subscribers.length)store.set(restockKey,[]);
  }
  recordVersion(store,{entityType:'digitalStock',entityId:product.id,before:null,after:{added:items.length,remaining:availability.remaining},actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'stock-add'});
  store.log('estoque',`${items.length} unidade(s) digitais adicionadas a ${product.name}.`,req.portfolioWeb?.user?.id||'portfolio-control');
  res.json({ok:true,added:items.length,...availability});
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

app.post('/api/portfolio/control/drops',portfolioControl,portfolioSameOrigin,(req,res)=>{
  const data=portfolioDropSchema.parse(req.body);
  const product=portfolioProducts().find(item=>item.id===data.productId);
  if(!product)throw new AppError('Produto do drop não encontrado.',404);
  const drop={id:randomUUID(),...data,created:store.now(),updated:store.now(),announcedAt:'',announcementMessageId:'',announceAttemptAt:''};
  const drops=portfolioDrops();drops.unshift(drop);store.set('portfolio:drops',drops.slice(0,300));
  recordVersion(store,{entityType:'drop',entityId:drop.id,before:null,after:drop,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'create'});
  store.log('portfólio',`Drop agendado: ${drop.title}`,'portfolio-control',{dropId:drop.id,productId:drop.productId});
  res.json({...drop,status:portfolioDropStatus(drop)});
});
app.put('/api/portfolio/control/drops/:id',portfolioControl,portfolioSameOrigin,(req,res)=>{
  const drops=portfolioDrops(),index=drops.findIndex(drop=>drop.id===req.params.id);
  if(index<0)throw new AppError('Drop não encontrado.',404);
  const data=portfolioDropSchema.parse(req.body);
  if(!portfolioProducts().some(item=>item.id===data.productId))throw new AppError('Produto do drop não encontrado.',404);
  const previous=drops[index];
  const scheduleChanged=previous.startsAt!==data.startsAt||previous.productId!==data.productId||previous.channelId!==data.channelId||previous.announceDiscord!==data.announceDiscord;
  const next={...previous,...data,updated:store.now(),...(scheduleChanged?{announcedAt:'',announcementMessageId:'',announceAttemptAt:''}:{})};
  drops[index]=next;store.set('portfolio:drops',drops);
  recordVersion(store,{entityType:'drop',entityId:next.id,before:previous,after:next,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'update'});
  store.log('portfólio',`Drop atualizado: ${next.title}`,'portfolio-control',{dropId:next.id,productId:next.productId});
  res.json({...next,status:portfolioDropStatus(next)});
});
app.delete('/api/portfolio/control/drops/:id',portfolioControl,portfolioSameOrigin,(req,res)=>{
  const drops=portfolioDrops(),previous=drops.find(drop=>drop.id===req.params.id)||null;
  if(!previous)throw new AppError('Drop não encontrado.',404);
  store.set('portfolio:drops',drops.filter(drop=>drop.id!==req.params.id));
  recordVersion(store,{entityType:'drop',entityId:req.params.id,before:previous,after:null,actor:req.portfolioWeb?.user?.id||'portfolio-control',action:'delete'});
  store.log('portfólio',`Drop removido: ${req.params.id}`,'portfolio-control',{dropId:req.params.id});
  res.json({ok:true});
});

app.post('/api/portfolio/control/upload-ticket',portfolioControl,portfolioSameOrigin,(req,res)=>{
  const name=String(req.body?.name||'arquivo').slice(0,180),requestedPublic=req.body?.public===true,token=randomBytes(32).toString('base64url');
  store.set(`portfolio-upload:${hash(token)}`,{userId:req.portfolioWeb?.user?.id||'',name,public:requestedPublic,expires:Date.now()+5*60000});
  const uploadUrl=new URL(`/api/portfolio/upload/${encodeURIComponent(token)}`,portfolioBackendOrigin);
  res.json({token,uploadUrl:uploadUrl.toString(),expiresIn:300});
});
app.post('/api/portfolio/control/assets/:id/process',portfolioControl,portfolioSameOrigin,async(req,res)=>{
  const result=await processPortfolioAsset(req.params.id);
  store.log('portfólio',`Arquivo processado automaticamente: ${result.source.originalName}`,'portfolio-control');
  res.json(result);
});
app.post('/api/portfolio/control/fivem-preview',portfolioControl,portfolioSameOrigin,async(req,res)=>{
  const yddAssetId=String(req.body?.yddAssetId||''),ytdAssetId=String(req.body?.ytdAssetId||'');
  if(!yddAssetId||!ytdAssetId)throw new AppError('Envie o YDD e o YTD da peça.',400);
  const assets=portfolioAssets();
  const ydd=assets.find(asset=>asset.id===yddAssetId&&String(asset.ext||'').toLowerCase()==='ydd');
  const ytd=assets.find(asset=>asset.id===ytdAssetId&&String(asset.ext||'').toLowerCase()==='ytd');
  if(!ydd)throw new AppError('Arquivo YDD não encontrado ou inválido.',404);
  if(!ytd)throw new AppError('Arquivo YTD não encontrado ou inválido.',404);

  const assetPath=asset=>join(asset.visibility==='public'?portfolioPublicDir:portfolioPrivateDir,asset.filename);
  const outputId=randomUUID(),filename=`${outputId}.glb`,output=join(portfolioPublicDir,filename);
  const processed=await runPortfolioProcess('studio-k-fivem-preview',[assetPath(ydd),assetPath(ytd),output],300000);
  if(!statSync(output).size)throw new AppError('O processador FiveM gerou uma prévia vazia.',422);

  let stats={drawables:0,drawableName:'',lod:'high',meshes:0,vertices:0,triangles:0,textures:0,materials:0};
  const lines=String(processed.stdout||'').trim().split(/\r?\n/).filter(Boolean);
  if(lines.length){
    try{stats={...stats,...JSON.parse(lines.at(-1))}}catch{}
  }

  const preview=registerPortfolioAsset({
    id:outputId,
    originalName:String(ydd.originalName||'modelo.ydd').replace(/\.ydd$/i,'-preview.glb'),
    filename,
    ext:'glb',
    visibility:'public',
    size:statSync(output).size,
    created:store.now(),
    publicUrl:`/portfolio-assets/${filename}`,
    sourceAssetId:ydd.id,
    relatedSourceAssetIds:[ydd.id,ytd.id],
    generated:true,
    generatedKind:'fivem-preview'
  });
  store.log('portfólio',`Prévia FiveM gerada: ${ydd.originalName} + ${ytd.originalName}`,'portfolio-control',{
    yddAssetId:ydd.id,ytdAssetId:ytd.id,previewAssetId:preview.id
  });
  res.json({kind:'model',source:ydd,textureSource:ytd,asset:preview,publicUrl:preview.publicUrl,stats});
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
  const publicExts=new Set(['png','jpg','jpeg','webp','gif','mp4','webm','glb','gltf']),sourceExts=new Set(['blend','psd','fbx','ydd','ytd']);
  if(!publicExts.has(ext)&&!sourceExts.has(ext))throw new AppError('Formato não suportado. Use GLB/GLTF, PNG/JPEG/WebP/GIF, MP4/WebM ou fontes YDD/YTD/BLEND/FBX/PSD.',400);
  if(!Buffer.isBuffer(req.body)||!req.body.length)throw new AppError('Arquivo vazio.',400);
  const visibility=ticket.public&&publicExts.has(ext)?'public':'private',id=randomUUID(),filename=`${id}.${ext}`,dir=visibility==='public'?portfolioPublicDir:portfolioPrivateDir;
  writeFileSync(join(dir,filename),req.body);
  const asset={id,originalName:original,filename,ext,visibility,size:req.body.length,created:store.now(),publicUrl:visibility==='public'?`/portfolio-assets/${filename}`:''};
  const assets=portfolioAssets();assets.unshift(asset);store.set('portfolio:assets',assets.slice(0,500));
  res.json(asset);
});

const portfolioAssetUpload=express.raw({type:()=>true,limit:'80mb'});
app.post('/api/portfolio/control/assets',portfolioControl,sameOrigin,portfolioAssetUpload,(req,res)=>{const original=String(req.query.name||'arquivo').slice(0,180),ext=(original.toLowerCase().match(/\.([a-z0-9]{2,8})$/)?.[1]||'bin');const publicExts=new Set(['png','jpg','jpeg','webp','gif','mp4','webm','glb','gltf']),sourceExts=new Set(['blend','psd','fbx','ydd','ytd']);if(!publicExts.has(ext)&&!sourceExts.has(ext))throw new AppError('Formato não suportado. Use GLB/GLTF, PNG/JPEG/WebP/GIF, MP4/WebM ou fontes YDD/YTD/BLEND/FBX/PSD.',400);if(!Buffer.isBuffer(req.body)||!req.body.length)throw new AppError('Arquivo vazio.',400);const requestedPublic=String(req.query.public||'0')==='1',visibility=requestedPublic&&publicExts.has(ext)?'public':'private',id=randomUUID(),filename=`${id}.${ext}`,dir=visibility==='public'?portfolioPublicDir:portfolioPrivateDir;writeFileSync(join(dir,filename),req.body);const asset={id,originalName:original,filename,ext,visibility,size:req.body.length,created:store.now(),publicUrl:visibility==='public'?`/portfolio-assets/${filename}`:''};const assets=portfolioAssets();assets.unshift(asset);store.set('portfolio:assets',assets.slice(0,500));res.json(asset)});
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
const portfolioDropTimer=setInterval(()=>void processPortfolioDrops(),30000);
portfolioDropTimer.unref();
const processRestockSubscriptions=()=>{
  try{
    for(const row of store.all("SELECT key,value FROM kv WHERE key LIKE 'portfolio:restock:%'")){
      let subscribers=[];try{subscribers=JSON.parse(row.value||'[]')}catch{}
      if(!Array.isArray(subscribers)||!subscribers.length)continue;
      const productId=String(row.key).split(':').pop(),product=portfolioProducts().find(item=>item.id===productId);
      if(!product||product.available===false)continue;
      for(const userId of [...new Set(subscribers)])addNotification(store,userId,{type:'restock',title:'Disponível novamente ✨',text:product.name,href:`/products/${product.id}`});
      store.set(row.key,[]);
    }
  }catch(error){store.log('erro',`Reposição Studio K: ${String(error.message||error).slice(0,400)}`);}
};
const processPortfolioSchedules=async()=>{
  try{
    runSchedules(store,{products:storedPortfolioProducts,setProducts:value=>store.set('portfolio:products',value)});
    for(const job of (commerceAdminState(store).schedules||[]).filter(item=>item.status==='done'&&item.kind==='product_publish')){
      const key=`portfolio:schedule-published:${job.id}`;
      if(store.get(key))continue;
      const product=portfolioProducts().find(item=>item.id===job.targetId);
      if(product?.published){
        await maybeAutoAnnouncePortfolioProduct(product,'publicação agendada');
        for(const row of store.all("SELECT key FROM kv WHERE key LIKE 'portfolio:member:%'")){
          const userId=String(row.key).split(':').pop();
          addNotification(store,userId,{type:'product',title:'Publicação agendada no ar ✨',text:product.name,href:`/products/${product.id}`});
        }
      }
      store.set(key,{at:store.now()});
    }
  }catch(error){store.log('erro',`Agendador Studio K: ${String(error.message||error).slice(0,400)}`);}
};
const portfolioScheduleTimer=setInterval(()=>{void processPortfolioSchedules();processRestockSubscriptions();},30000);
portfolioScheduleTimer.unref();
setTimeout(()=>{void processPortfolioDrops();void processPortfolioSchedules();processRestockSubscriptions();},5000).unref();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{clearInterval(portfolioDropTimer);clearInterval(portfolioScheduleTimer);await bot.stop();server.close(()=>{store.db.close();process.exit(0);});});
