const htmlResponse=(response,text)=>
  (response.headers.get('content-type')||'').includes('text/html')||/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text);

export async function fetchPanelResponse(path,options={},fetcher=fetch){
  const url=`/api${path}`,request={...options,cache:'no-store'};
  let response=await fetcher(url,request),text=await response.text();
  // A hosting outage can leave an HTML error cached outside our application.
  // A fresh URL recovers read-only requests; writes must never be replayed.
  if((request.method||'GET').toUpperCase()==='GET'&&htmlResponse(response,text)){
    const fresh=`${url}${url.includes('?')?'&':'?'}_studio_refresh=${crypto.randomUUID()}`;
    response=await fetcher(fresh,request);text=await response.text();
  }
  return{response,text};
}
