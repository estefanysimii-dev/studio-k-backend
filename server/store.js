import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, randomInt } from 'node:crypto';
import { defaults, settingsSchema } from './schema.js';
export class AppError extends Error { constructor(message, status=400) { super(message); this.status=status; } }
export function openStore(directory) {
  const dir=resolve(directory); mkdirSync(dir,{recursive:true}); mkdirSync(join(dir,'backups'),{recursive:true});
  const keyPath=join(dir,'encryption.key');
  if(existsSync(join(dir,'studio-k.sqlite'))&&!existsSync(keyPath))throw new Error('A chave encryption.key está ausente. Restaure a chave original antes de abrir este banco.');
  if(!existsSync(keyPath)) writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
  const key=readFileSync(keyPath); const db=new DatabaseSync(join(dir,'studio-k.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,data TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stock(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),secret TEXT NOT NULL,order_id TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,product_id TEXT NOT NULL REFERENCES products(id),product TEXT NOT NULL,price INTEGER NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,expires TEXT NOT NULL,approved_by TEXT,role_done INTEGER NOT NULL DEFAULT 0,delivery_done INTEGER NOT NULL DEFAULT 0,error TEXT,receipt TEXT);
    CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,channel_id TEXT UNIQUE,category TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,claimed_by TEXT,transcript TEXT);
    CREATE INDEX IF NOT EXISTS tickets_open_user ON tickets(user_id,status);
    CREATE TABLE IF NOT EXISTS giveaways(id TEXT PRIMARY KEY,data TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT,winners TEXT,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entries(giveaway_id TEXT NOT NULL REFERENCES giveaways(id),user_id TEXT NOT NULL,PRIMARY KEY(giveaway_id,user_id));
    CREATE TABLE IF NOT EXISTS giveaway_attempts(giveaway_id TEXT NOT NULL REFERENCES giveaways(id),user_id TEXT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(giveaway_id,user_id));
    CREATE TABLE IF NOT EXISTS giveaway_manual(giveaway_id TEXT NOT NULL REFERENCES giveaways(id),user_id TEXT NOT NULL,requirement_id TEXT NOT NULL,approved_by TEXT NOT NULL,approved_at TEXT NOT NULL,PRIMARY KEY(giveaway_id,user_id,requirement_id));
    CREATE TABLE IF NOT EXISTS youtube_accounts(user_id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,channel_title TEXT NOT NULL,refresh_secret TEXT NOT NULL,connected_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS giveaway_invites(giveaway_id TEXT NOT NULL REFERENCES giveaways(id),user_id TEXT NOT NULL,code TEXT NOT NULL UNIQUE,created TEXT NOT NULL,PRIMARY KEY(giveaway_id,user_id));
    CREATE TABLE IF NOT EXISTS invite_joins(giveaway_id TEXT NOT NULL REFERENCES giveaways(id),joined_user_id TEXT NOT NULL,inviter_user_id TEXT NOT NULL,code TEXT NOT NULL,joined_at TEXT NOT NULL,left_at TEXT,PRIMARY KEY(giveaway_id,joined_user_id));
    CREATE TABLE IF NOT EXISTS referral_joins(joined_user_id TEXT PRIMARY KEY,inviter_user_id TEXT NOT NULL,code TEXT NOT NULL,joined_at TEXT NOT NULL,left_at TEXT);
    CREATE INDEX IF NOT EXISTS referral_joins_inviter ON referral_joins(inviter_user_id,joined_at);
    CREATE INDEX IF NOT EXISTS invite_joins_inviter ON invite_joins(giveaway_id,inviter_user_id);
    CREATE TABLE IF NOT EXISTS voice_activity(user_id TEXT PRIMARY KEY,seconds INTEGER NOT NULL DEFAULT 0,joined_at TEXT);
    CREATE TABLE IF NOT EXISTS giveaway_voice(giveaway_id TEXT NOT NULL REFERENCES giveaways(id),user_id TEXT NOT NULL,seconds INTEGER NOT NULL DEFAULT 0,joined_at TEXT,PRIMARY KEY(giveaway_id,user_id));
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,data TEXT NOT NULL,discord_id TEXT,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS optins(user_id TEXT PRIMARY KEY,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_preferences(user_id TEXT PRIMARY KEY,language TEXT NOT NULL DEFAULT 'pt',updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS verifications(user_id TEXT PRIMARY KEY,username TEXT NOT NULL,verified_at TEXT NOT NULL,last_authorized_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS member_recovery(user_id TEXT PRIMARY KEY,username TEXT NOT NULL,refresh_secret TEXT NOT NULL,scopes TEXT NOT NULL,authorized_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS member_events(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,event TEXT NOT NULL,created TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS member_events_created ON member_events(created);
    CREATE INDEX IF NOT EXISTS member_events_user ON member_events(user_id);
    CREATE TABLE IF NOT EXISTS message_activity(day TEXT NOT NULL,user_id TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,user_id));
    CREATE INDEX IF NOT EXISTS message_activity_user ON message_activity(user_id,day);
    CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,actor TEXT NOT NULL,detail TEXT NOT NULL,created TEXT NOT NULL,meta TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,name TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,result TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS feedback_requests(
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      rating INTEGER,
      comment TEXT,
      meta TEXT NOT NULL DEFAULT '{}',
      created TEXT NOT NULL,
      submitted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feedback_source_unique ON feedback_requests(type,source_id);
    CREATE INDEX IF NOT EXISTS feedback_user_status ON feedback_requests(user_id,status);
  `);
  if(!db.prepare('PRAGMA table_info(orders)').all().some(c=>c.name==='approved_at'))db.exec('ALTER TABLE orders ADD COLUMN approved_at TEXT');
  if(!db.prepare('PRAGMA table_info(logs)').all().some(c=>c.name==='meta'))db.exec("ALTER TABLE logs ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'");
  db.exec('DROP INDEX IF EXISTS open_ticket_per_user');
  db.exec('CREATE INDEX IF NOT EXISTS tickets_open_user ON tickets(user_id,status)');
  // Backfill referral_joins from previously tracked giveaway invite joins where possible.
  if(db.prepare('SELECT COUNT(*) AS n FROM referral_joins').get().n===0){
    const legacy=db.prepare('SELECT joined_user_id,inviter_user_id,code,joined_at,left_at FROM invite_joins ORDER BY joined_at').all();
    const ins=db.prepare('INSERT INTO referral_joins(joined_user_id,inviter_user_id,code,joined_at,left_at) VALUES(?,?,?,?,?) ON CONFLICT(joined_user_id) DO UPDATE SET inviter_user_id=excluded.inviter_user_id,code=excluded.code,joined_at=excluded.joined_at,left_at=excluded.left_at');
    for(const row of legacy)ins.run(row.joined_user_id,row.inviter_user_id,row.code,row.joined_at,row.left_at);
  }
  // Backfill member_events once from existing member audit logs when available.
  if(db.prepare('SELECT COUNT(*) AS n FROM member_events').get().n===0){
    const legacy=db.prepare("SELECT actor,detail,created FROM logs WHERE type='membro' ORDER BY id").all();
    const ins=db.prepare('INSERT INTO member_events(user_id,event,created) VALUES(?,?,?)');
    for(const row of legacy){
      const event=row.detail.includes(' entrou do servidor.')?'join':row.detail.includes(' saiu do servidor.')?'leave':'';
      if(event&&/^\d{17,20}$/.test(String(row.actor)))ins.run(row.actor,event,row.created);
    }
  }
  const one=(sql,...args)=>db.prepare(sql).get(...args), all=(sql,...args)=>db.prepare(sql).all(...args), run=(sql,...args)=>db.prepare(sql).run(...args);
  const now=()=>new Date().toISOString();
  const get=(k,fallback=null)=>{const row=one('SELECT value FROM kv WHERE key=?',k);return row?JSON.parse(row.value):fallback;};
  const set=(k,v)=>run('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',k,JSON.stringify(v));
  const log=(type,detail,actor='sistema',meta={})=>run('INSERT INTO logs(type,actor,detail,created,meta) VALUES(?,?,?,?,?)',type,actor,String(detail).slice(0,2000),now(),JSON.stringify(meta&&typeof meta==='object'?meta:{}).slice(0,12000));
  const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
  const encrypt=text=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');};
  const decrypt=value=>{const data=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');};
  const settings=()=>settingsSchema.parse(get('settings',defaults));
  const products=()=>all('SELECT * FROM products ORDER BY created DESC').map(p=>({...JSON.parse(p.data),id:p.id,stock:one('SELECT COUNT(*) AS n FROM stock WHERE product_id=? AND order_id IS NULL',p.id).n}));
  function createOrder(productId,userId){return transaction(()=>{
    const row=one('SELECT * FROM products WHERE id=?',productId);if(!row)throw new AppError('Produto não encontrado.',404);
    const p=JSON.parse(row.data);if(!p.active)throw new AppError('Produto indisponível.');
    const pending=one("SELECT COUNT(*) AS n FROM orders WHERE user_id=? AND status='pending'",userId).n;if(pending>=3)throw new AppError('Você já possui três pedidos aguardando pagamento.');
    const unit=p.type==='digital'?one('SELECT id FROM stock WHERE product_id=? AND order_id IS NULL LIMIT 1',productId):null;
    if(p.type==='digital'&&!unit)throw new AppError('Este produto está sem estoque.');
    const orderId=randomUUID(),created=now(),expires=new Date(Date.now()+settings().sales.orderExpiryMinutes*60000).toISOString();
    run('INSERT INTO orders(id,user_id,product_id,product,price,status,created,expires) VALUES(?,?,?,?,?,?,?,?)',orderId,userId,productId,JSON.stringify(p),p.priceCents,'pending',created,expires);
    if(unit)run('UPDATE stock SET order_id=? WHERE id=?',orderId,unit.id);
    log('venda',`Pedido ${orderId.slice(0,8)} criado: ${p.name}`,userId);return one('SELECT * FROM orders WHERE id=?',orderId);
  });}
  function approveOrder(orderId,actor){return transaction(()=>{
    const row=one('SELECT * FROM orders WHERE id=?',orderId);if(!row)throw new AppError('Pedido não encontrado.',404);
    if(row.status==='paid'||row.status==='delivered')return row;
    if(row.status!=='pending')throw new AppError('Este pedido já foi encerrado.');
    if(Date.parse(row.expires)<=Date.now())throw new AppError('O pedido expirou. Crie outro após conferir o estoque.');
    run("UPDATE orders SET status='paid',approved_by=?,approved_at=? WHERE id=?",actor,now(),orderId);log('pagamento',`Pix confirmado manualmente: ${orderId.slice(0,8)}`,actor);
    return one('SELECT * FROM orders WHERE id=?',orderId);
  });}
  function cancelOrder(orderId,actor='sistema'){return transaction(()=>{
    const row=one('SELECT * FROM orders WHERE id=?',orderId);if(!row)throw new AppError('Pedido não encontrado.',404);
    if(row.status!=='pending')throw new AppError('Só pedidos pendentes podem ser cancelados.');
    run("UPDATE orders SET status='cancelled' WHERE id=?",orderId);run('UPDATE stock SET order_id=NULL WHERE order_id=?',orderId);log('venda',`Pedido ${orderId.slice(0,8)} cancelado; estoque liberado.`,actor);
  });}
  function drawGiveaway(giveawayId,eligible){return transaction(()=>{
    const row=one('SELECT * FROM giveaways WHERE id=?',giveawayId);if(!row)throw new AppError('Sorteio não encontrado.',404);
    if(row.status!=='active')return row.winners?JSON.parse(row.winners):[];
    const pool=[...new Set(eligible)],winners=[];const data=JSON.parse(row.data);
    while(pool.length&&winners.length<data.winners)winners.push(pool.splice(randomInt(pool.length),1)[0]);
    run("UPDATE giveaways SET status='drawn',winners=? WHERE id=?",JSON.stringify(winners),giveawayId);log('sorteio',`Resultado fixado para ${data.title}: ${winners.length} vencedor(es).`);return winners;
  });}
  async function makeBackup(guildSnapshot=null){
    const stamp=now().replace(/[:.]/g,'-');const name=`studio-k-${stamp}`;
    await backup(db,join(dir,'backups',`${name}.sqlite`));
    writeFileSync(join(dir,'backups',`${name}.json`),JSON.stringify({version:1,created:now(),settings:settings(),guild:guildSnapshot},null,2),{mode:0o600});
    const files=readdirSync(join(dir,'backups')).filter(f=>f.endsWith('.json')).sort().reverse();
    for(const f of files.slice(settings().backups.retain)){for(const ext of ['json','sqlite']){const target=join(dir,'backups',f.replace(/\.json$/,`.${ext}`));if(existsSync(target))unlinkSync(target);}}
    set('lastBackup',now());log('backup','Configurações e banco de dados salvos.');return name;
  }
  return {db,dir,one,all,run,get,set,log,now,settings,products,transaction,encrypt,decrypt,createOrder,approveOrder,cancelOrder,drawGiveaway,makeBackup};
}
