import { z } from 'zod';

const audioUrl=z.string().trim().max(2000).refine(value=>{
  if (/^\/(?!\/)[^\\\s]*$/.test(value)) return true;
  try { return new URL(value).protocol==='https:'; } catch { return false; }
},'Use uma URL HTTPS pública ou um caminho de áudio no site.');
const playlist=z.string().trim().max(2000).refine(value=>!value||/^https:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?playlist\/[a-zA-Z0-9]{22}(?:\?[^#]*)?$/.test(value),'Use o link completo de uma playlist do Spotify.');
export const radioSchema=z.object({
  enabled:z.boolean().default(false),
  name:z.string().trim().min(1).max(80).default('Rádio Studio K'),
  source:z.enum(['spotify','schedule','hls']).default('spotify'),
  spotifyUrl:playlist.default(''),
  streamUrl:audioUrl.or(z.literal('')).default(''),
  tracks:z.array(z.object({title:z.string().trim().min(1).max(120),url:audioUrl,duration:z.number().finite().positive().max(86400)})).max(200).default([]),
  epochMs:z.number().int().min(0).max(8640000000000000).default(0),
  position:z.enum(['left','right']).default('right'),
  compact:z.boolean().default(true),
  showInControl:z.boolean().default(false),
  autoplay:z.boolean().default(false),
  defaultVolume:z.number().min(0).max(1).default(0.5),
  analyze:z.boolean().default(false)
}).superRefine((radio,ctx)=>{
  if(!radio.enabled)return;
  const missing=radio.source==='spotify'?!radio.spotifyUrl:radio.source==='hls'?!radio.streamUrl:!radio.tracks.length;
  if(missing)ctx.addIssue({code:'custom',message:'Configure a fonte antes de ativar a rádio.',path:['source']});
});
export const defaultRadio=radioSchema.parse({});
export function normalizeRadio(input,current=defaultRadio,now=Date.now()){
  const next=radioSchema.parse(input);
  const changed=next.source!==current.source||next.streamUrl!==current.streamUrl||JSON.stringify(next.tracks)!==JSON.stringify(current.tracks);
  // The server owns the shared epoch. Cosmetic changes and restarts preserve it.
  next.epochMs=changed||!current.epochMs?now:current.epochMs;
  return next;
}
export function radioSnapshot(radio,now=Date.now()){
  let live=null;
  if(radio.source==='schedule'&&radio.tracks.length){
    const total=radio.tracks.reduce((sum,t)=>sum+t.duration,0);
    let position=((now-radio.epochMs)/1000%total+total)%total;
    for(let index=0;index<radio.tracks.length;index++){
      if(position<radio.tracks[index].duration){live={index,positionSeconds:position};break;}
      position-=radio.tracks[index].duration;
    }
  }
  return {radio,serverNowMs:now,live,capabilities:{synchronized:radio.source!=='spotify',volume:radio.source!=='spotify',spectrum:radio.source!=='spotify'&&radio.analyze}};
}
