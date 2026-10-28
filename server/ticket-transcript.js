import {ticketMessageOrigin} from './ticket-web.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const key=id=>`ticket-transcript:${id}`;
const date=value=>{const d=new Date(value);return Number.isNaN(d.valueOf())?'':new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Cuiaba'}).format(d);};
const httpsUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'?u.href:'';}catch{return'';}};
const avatarUrl=value=>{const url=httpsUrl(value);return url&&['cdn.discordapp.com','media.discordapp.net','cdn.discord.com'].includes(new URL(url).hostname)?url:'';};

export async function buildTicketTranscript({store,ticket,messages,botId,getMember}){
  const members=new Map(),result=[];
  const member=id=>{if(!members.has(id))members.set(id,Promise.resolve().then(()=>getMember(id)).catch(()=>null));return members.get(id);};
  for(const message of messages.filter(m=>!m.system)){
    const {origin,content}=ticketMessageOrigin(store,ticket,message,botId),authorId=origin?.user_id||message.author?.id||'';
    const bot=!origin&&!!message.author?.bot,person=bot?null:await member(authorId);
    const roles=[...(person?.roles?.cache?.values?.()||[])].filter(r=>r.id!==person.guild?.id&&r.name!=='@everyone').sort((a,b)=>(b.position??b.rawPosition??0)-(a.position??a.rawPosition??0));
    const highest=person?.roles?.highest?.id!==person?.guild?.id?person?.roles?.highest:null,role=highest?.name!=='@everyone'&&highest?highest:roles[0];
    result.push({
      id:message.id,authorId,name:person?.displayName||origin?.author_name||message.member?.displayName||message.author?.globalName||message.author?.username||message.author?.tag||'Participante',
      username:person?.user?.username||(!origin?message.author?.username:'')||'',
      avatar:person?.displayAvatarURL?.({size:128})||origin?.avatar_url||message.author?.displayAvatarURL?.({size:128})||'',
      role:role?{id:role.id,name:role.name}:null,bot,customer:authorId===ticket.user_id,viaSite:!!origin,
      created:message.createdAt?.toISOString?.()||'',content,
      embeds:(message.embeds||[]).map(e=>({title:e.title||'',description:e.description||'',fields:(e.fields||[]).map(f=>({name:f.name,value:f.value}))})),
      attachments:[...(message.attachments?.values?.()||[])].map(a=>({name:a.name||'Arquivo',url:a.url}))
    });
  }
  const text=result.map(m=>`[${m.created}] ${m.name}${m.username?` (@${m.username})`:''} (${m.authorId})${m.role?` [${m.role.name}]`:''}: ${m.content}${m.embeds.map(e=>'\n'+[e.title,e.description,...e.fields.map(f=>`${f.name}: ${f.value}`)].filter(Boolean).join('\n')).join('')}${m.attachments.map(a=>`\n${a.name}: ${a.url}`).join('')}`).join('\n\n');
  return{version:1,messages:result,text};
}

export function saveTicketTranscript(store,id,transcript){store.set(key(id),{version:transcript.version,messages:transcript.messages});}
export function readTicketTranscript(store,ticket){
  const saved=store.get(key(ticket.id));
  if(saved?.version===1&&Array.isArray(saved.messages))return saved.messages;
  // Old exports contain no role snapshots. Keep their recorded identity, without
  // inventing a Discord role from a nickname or an arbitrary line in the text.
  const rows=[],header=/^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] (.*?) \((\d{17,20})\): ?(.*)$/;
  for(const line of String(ticket.transcript||'').split('\n')){
    const match=line.match(header);
    if(match)rows.push({created:match[1],name:match[2],authorId:match[3],customer:match[3]===ticket.user_id,content:match[4],legacy:true});
    else if(rows.length)rows.at(-1).content+='\n'+line;
    else if(line.trim())rows.push({name:'Histórico anterior',content:line,legacy:true});
  }
  // Old plain exports used the webhook's ID. A saved message snowflake records
  // its exact creation time, so a unique match restores the actual site author.
  const web=store.all?.('SELECT * FROM ticket_web_messages WHERE ticket_id=? AND user_id=?',ticket.id,ticket.user_id)||[];
  for(const row of rows){
    const matches=web.filter(m=>{try{return new Date(Number((BigInt(m.message_id)>>22n)+1420070400000n)).toISOString()===row.created&&m.author_name===row.name;}catch{return false;}});
    if(matches.length===1){row.authorId=matches[0].user_id;row.avatar=matches[0].avatar_url;row.customer=true;row.viaSite=true;}
  }
  return rows;
}

export function renderTicketTranscript(ticket,messages,download){
  const people=new Map(messages.filter(m=>m.authorId).map(m=>[m.authorId,m.name]));
  const content=value=>escape(String(value||'').replace(/<@!?(\d{17,20})>/g,(all,id)=>people.has(id)?`@${people.get(id)}`:all));
  const conversation=messages.map(m=>{
    const avatar=avatarUrl(m.avatar),kind=m.bot?'Bot':m.customer?'Cliente':'Equipe',role=m.role?.name||(m.legacy?'Cargo não registrado':m.bot?'Sistema':'Membro');
    return `<article class="message ${m.bot?'system':m.customer?'customer':'staff'}"><div class="avatar">${avatar?`<img src="${escape(avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:escape(String(m.name||'?').replace(/\[.*?\]/g,'').trim().slice(0,2).toUpperCase())}</div><div class="bubble"><header class="identity"><strong>${escape(m.name)}</strong><span class="role">${escape(role)}</span><span class="kind">${kind}${m.viaSite?' · pelo site':''}</span></header><div class="author-meta">${m.username?`<span>@${escape(m.username)}</span>`:''}${m.authorId?`<span class="discord-id">ID Discord: ${escape(m.authorId)}</span>`:''}<time datetime="${escape(m.created)}">${escape(date(m.created))}</time></div><div class="body">${content(m.content).trim()}</div>${(m.embeds||[]).map(e=>`<section class="embed">${e.title?`<strong>${content(e.title)}</strong>`:''}${e.description?`<div>${content(e.description)}</div>`:''}${(e.fields||[]).map(f=>`<div><b>${content(f.name)}</b><br>${content(f.value)}</div>`).join('')}</section>`).join('')}${(m.attachments||[]).map(a=>{const url=httpsUrl(a.url);return url?`<a class="attachment" href="${escape(url)}" target="_blank" rel="noopener noreferrer">↗ ${escape(a.name)}</a>`:`<span class="attachment">${escape(a.name)}</span>`;}).join('')}</div></article>`;
  }).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio K · Transcript</title><style>
*{box-sizing:border-box}body{margin:0;background:#100b12;color:#faf4fa;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:1080px;margin:auto;padding:40px 24px 64px}.top{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap}.eyebrow{color:#F345FE;font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}h1{margin:5px 0;font-size:30px}.meta,.note{color:#b6a6b8;font-size:13px}.meta{margin:5px 0}.btn{display:inline-block;background:#F345FE;color:#210824;text-decoration:none;font-weight:800;padding:12px 18px;border-radius:12px}.summary{display:flex;gap:10px;margin:22px 0 28px;flex-wrap:wrap}.summary span{background:#201322;border:1px solid #49204d;border-radius:30px;padding:6px 12px;font-size:12px}.conversation{display:flex;flex-direction:column;gap:22px}.message{display:flex;gap:12px;align-items:flex-start;max-width:88%}.message.customer{align-self:flex-end;flex-direction:row-reverse}.avatar{flex:0 0 40px;width:40px;height:40px;display:grid;place-items:center;background:#502052;border-radius:50%;overflow:hidden;font-size:12px;font-weight:800}.avatar img{width:100%;height:100%;object-fit:cover}.bubble{min-width:0;background:#211624;border:1px solid #422546;border-radius:0 18px 18px;padding:15px 18px}.customer .bubble{background:#361639;border-color:#78317e;border-radius:18px 0 18px 18px}.system .bubble{background:#18131a}.identity{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.identity strong{font-size:14px}.role{font-size:11px;color:#ffbaff;background:#521b58;border:1px solid #79317f;border-radius:6px;padding:2px 7px}.kind{font-size:11px;color:#c5b4c8}.author-meta{display:flex;gap:5px 12px;flex-wrap:wrap;font-size:11px;color:#bda8c0;margin:5px 0 12px}.discord-id{user-select:all}.body{white-space:pre-wrap;overflow-wrap:anywhere}.body:empty{display:none}.embed{border-left:3px solid #F345FE;background:#100a1244;border-radius:5px;margin-top:12px;padding:10px 14px;white-space:pre-wrap;overflow-wrap:anywhere}.embed>div{margin-top:5px}.attachment{display:block;color:#ffc9ff;overflow-wrap:anywhere;margin-top:10px}.note{margin-top:28px;padding-top:18px;border-top:1px solid #39203d}.empty{color:#b6a6b8}@media(max-width:600px){.wrap{padding:24px 12px 40px}h1{font-size:24px}.message{max-width:100%;gap:8px}.avatar{flex-basis:30px;width:30px;height:30px}.bubble{padding:12px}.author-meta{font-size:10px}.btn{font-size:13px}}
</style></head><body><main class="wrap"><header class="top"><div><div class="eyebrow">Studio K · histórico de atendimento</div><h1>${escape(ticket.category)}</h1><p class="meta">Ticket ${escape(ticket.id.slice(0,8))} · encerrado em ${escape(date(ticket.updated))}</p></div><a class="btn" href="${escape(download)}">Baixar transcript .txt</a></header><div class="summary"><span>Atendimento encerrado</span><span>${messages.length} mensagem${messages.length===1?'':'s'}</span></div><section class="conversation" aria-label="Conversa do atendimento">${conversation||'<p class="empty">Nenhuma mensagem registrada.</p>'}</section><p class="note">Este link é privado. Os cargos exibidos foram registrados no encerramento; históricos antigos podem não conter essa informação.</p></main></body></html>`;
}
