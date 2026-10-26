export const SUPPORTED_LANGUAGES=[
  {code:'pt',label:'Português (Brasil)',emoji:'🇧🇷'},
  {code:'en',label:'English',emoji:'🇺🇸'},
  {code:'es',label:'Español',emoji:'🇪🇸'},
  {code:'fr',label:'Français',emoji:'🇫🇷'},
  {code:'de',label:'Deutsch',emoji:'🇩🇪'},
  {code:'it',label:'Italiano',emoji:'🇮🇹'},
  {code:'ja',label:'日本語',emoji:'🇯🇵'},
  {code:'ko',label:'한국어',emoji:'🇰🇷'},
  {code:'zh-CN',label:'简体中文',emoji:'🇨🇳'},
  {code:'ru',label:'Русский',emoji:'🇷🇺'}
];
export const normalizeLanguage=value=>{
  const raw=String(value||'').trim(),lower=raw.toLowerCase().replace('_','-');
  if(['pt','pt-br','pt-pt','português','portugues','portuguese'].includes(lower)||lower.startsWith('pt-'))return 'pt';
  if(lower==='zh-cn'||lower==='zh-hans'||lower.startsWith('zh-cn')||lower.startsWith('zh-sg'))return 'zh-CN';
  const exact=SUPPORTED_LANGUAGES.find(l=>l.code.toLowerCase()===lower);
  if(exact)return exact.code;
  const prefix=lower.split('-')[0],byPrefix=SUPPORTED_LANGUAGES.find(l=>l.code.toLowerCase()===prefix);
  return byPrefix?.code||'pt';
};
export const resolvePreferredLanguage=(storedLanguage='',explicit=false,interactionLocale='')=>{
  if(explicit&&storedLanguage)return normalizeLanguage(storedLanguage);
  return normalizeLanguage(interactionLocale||'pt');
};
const protectedTranslationPattern=/```[\s\S]*?```|`[^`\n]+`|<(?:@!?|@&|#)\d+>|<t:\d+(?::[tTdDfFR])?>|<a?:[A-Za-z0-9_]+:\d+>|https?:\/\/[^\s)]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|[A-Za-z0-9_-]{12,}/gi;
export const splitTranslationText=value=>{
  const source=String(value||''),parts=[];let last=0;
  protectedTranslationPattern.lastIndex=0;
  for(const match of source.matchAll(protectedTranslationPattern)){
    if(match.index>last)parts.push({text:source.slice(last,match.index),protected:false});
    parts.push({text:match[0],protected:true});
    last=match.index+match[0].length;
  }
  if(last<source.length)parts.push({text:source.slice(last),protected:false});
  return parts.length?parts:[{text:source,protected:false}];
};
