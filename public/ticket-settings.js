const logFields=[['customer','Quem abriu'],['type','Tipo de ticket'],['priority','Prioridade'],['state','Estado'],['assignee','Staff responsável'],['tags','Tags'],['dates','Datas de abertura e encerramento'],['reason','Motivo do encerramento'],['notes','Notas internas completas'],['history','Histórico de ações da equipe'],['transcript','Link da conversa com o cliente']];

export function ticketOrganizationSettings({settings:s,metadata,card,field,select,toggle,esc}){
  const destination=(label,name,value,kind,empty='Selecione…')=>{
    const channels=(metadata.channels||[]).filter(c=>Number(c.type)===(kind==='category'?4:0));
    const html=channels.length?select(label,name,value,[['',empty],...channels.map(c=>[c.id,c.name])]):field(label,name,value,{placeholder:'ID do destino no Discord'});
    return html.replace('<select ',`<select data-ticket-destination="${kind}" `);
  };
  const routes=s.categories.map((type,index)=>{
    const current=(s.categoryRoutes||[]).find(route=>route.name===type);
    return `<input type="hidden" name="categoryRoutes.${index}.name" value="${esc(type)}">${destination(`Categoria para ${type}`,`categoryRoutes.${index}.categoryId`,current?.categoryId||'','category','Usar categoria padrão')}`;
  }).join('');
  return `<div class="grid equal"><div>${card('Tipos, canais e categorias',`<form data-settings="tickets" data-ticket-routing>
    ${field('Tipos de atendimento','categories',s.categories.join('\n'),{type:'textarea',help:'Um tipo por linha, até 25. Após salvar, os seletores de destino acompanham os tipos cadastrados.'})}
    ${destination('Categoria padrão dos tickets','categoryId',s.categoryId,'category')}
    <div class="form-grid">${routes}</div>
    ${destination('Canal do painel público de tickets','panelChannelId',s.panelChannelId||'','log')}
    <div class="actions"><button class="primary" type="submit">Salvar organização</button><button type="button" data-action="ticketpanel:publish">Publicar painel de tickets</button></div>
  </form>`)}${card('Criar destino no Discord',`<form id="ticket-destination-form">
    ${select('Tipo de destino','destinationKind','category',[['category','Categoria privada'],['log','Canal privado de logs']])}
    ${field('Nome do novo destino','destinationName','',{required:true,placeholder:'Ex.: Suporte, Compras ou Gestão de tickets'})}
    ${destination('Categoria do novo canal de logs (opcional)','destinationParent','','category')}
    <p class="subtle">O novo destino fica restrito à equipe configurada e ao bot. Depois, selecione-o na organização dos tickets.</p><button class="primary" type="submit">Criar destino</button>
  </form>`)}</div><div>${card('Informações internas e encerramento',`<form data-settings="tickets">
    ${destination('Categoria dos canais internos da equipe','staffInfoCategoryId',s.staffInfoCategoryId||'','category')}
    ${destination('Canal dos logs de tickets encerrados','logChannelId',s.logChannelId||'','log','Usar destino definido em Registros')}
    <p class="subtle">Cada atendimento terá um canal interno com resumo, controles e notas. O cliente continua em seu canal de conversa. O destino de logs deve ser privado para a equipe.</p>
    <div class="field"><label>Informações incluídas no encerramento</label><div class="role-picker">${logFields.map(([value,label])=>`<label class="toggle-label"><input type="checkbox" data-multivalue="logFields" value="${value}" ${(s.logFields||[]).includes(value)?'checked':''}>${label}</label>`).join('')}</div></div>
    ${toggle('Remover o canal interno depois de confirmar o envio ao log','deleteInfoChannelOnClose',s.deleteInfoChannelOnClose!==false)}
    <p class="subtle">Se o envio ao log falhar, o canal interno e os dados são preservados para nova tentativa. Notas internas nunca são incluídas no transcript do cliente.</p><button class="primary" type="submit">Salvar informações e logs</button>
  </form>`)}</div></div>`;
}
