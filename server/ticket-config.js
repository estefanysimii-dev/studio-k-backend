export const TICKET_LOG_FIELDS=['customer','type','priority','state','assignee','tags','dates','reason','notes','history','transcript'];
export function ticketParent(settings,type){
  return (settings.categoryRoutes||[]).find(route=>route.name.normalize('NFC').trim()===String(type).normalize('NFC').trim())?.categoryId||settings.categoryId||'';
}
