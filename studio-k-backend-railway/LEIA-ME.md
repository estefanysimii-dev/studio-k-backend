# Studio K

Bot para um servidor Discord com painel administrativo integrado, em português, escuro e roxo. Produtos digitais e serviços; pagamentos por Pix com conferência manual.

## Situação desta entrega

O código do bot, o painel e o banco de dados estão implementados. A demonstração local funciona sem credenciais e usa uma base separada. Os testes automatizados verificam as regras locais e simulam as respostas do Discord em testes de entrega. Não foram feitos envios reais, compras reais nem testes de permissões no seu servidor, porque as credenciais ainda não foram configuradas.

O painel está servido pela própria aplicação Node.js, junto do processo persistente do bot. Não existe uma versão hospedada publicamente nesta entrega. Para funcionar 24 horas, mantenha a aplicação em uma máquina ligada ou em uma hospedagem que aceite processos Node.js contínuos e disco persistente.

## Começar no Windows

1. Instale Node.js 24.17 ou superior da linha 24 LTS pelo site oficial: <https://nodejs.org>.
2. Extraia o pacote e abra a pasta `studio-k`.
3. Para explorar, execute `DEMONSTRACAO.cmd`. Abra <http://localhost:3210> e clique em **Explorar demonstração**.
4. Para usar seu servidor, feche a demonstração e copie `.env.example` para `.env`.
5. Preencha as três variáveis Discord descritas abaixo. Não compartilhe esse arquivo.
6. Execute `INICIAR.cmd` e abra <http://localhost:3210>.
7. No primeiro acesso local, crie uma senha de administrador com pelo menos 12 caracteres. Não há senha padrão.

Alternativa pelo terminal, dentro da pasta:

```text
npm ci
npm run demo
```

Para iniciar a instalação real:

```text
npm start
```

A demonstração e a instalação real usam a mesma porta por padrão. Encerre uma antes de abrir a outra. Os dados de demonstração ficam em `demo-data`; os reais ficam em `data`. Nenhum exemplo de produto é adicionado ao banco real.

## Conectar o Discord

No [Discord Developer Portal](https://discord.com/developers/applications):

1. Crie uma aplicação chamada **Studio K**.
2. Na seção Bot, obtenha o token e preencha `DISCORD_TOKEN` no `.env` local. Não envie o token no chat.
3. Ative **Server Members Intent** e **Message Content Intent**. O segundo permite salvar o conteúdo dos tickets no histórico. Se ficar desativado no portal, esta configuração do bot poderá ser recusada pelo Discord.
4. Copie o Application ID para `DISCORD_CLIENT_ID`.
5. Ative o modo de desenvolvedor no seu Discord, copie o ID do seu servidor e preencha `DISCORD_GUILD_ID`.
6. Em OAuth2 / URL Generator, selecione `bot` e `applications.commands`. Selecione View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Channels, Manage Roles, Manage Webhooks e Manage Events. Não é necessário dar Administrator.
7. Abra o convite gerado e escolha o seu servidor.
8. Coloque o cargo do Studio K **acima** dos cargos que ele deve conceder. O bot não concede cargos gerenciados nem cargos com Administrator.
9. Reinicie a aplicação. Os comandos são registrados somente no servidor informado.

O bot precisa enxergar os canais que você selecionar. Categorias com permissões particulares também devem permitir o funcionamento do bot. O painel substitui os IDs por opções com nomes quando o bot estiver conectado.

## Configurar a operação

### Identidade

Em Configurações, defina nome, avatar, banner, descrição do aplicativo, presença e atividade. Salve e depois clique em **Aplicar no Discord**. Imagens: PNG, JPEG ou WebP, até 2 MB. O Discord pode limitar a frequência das alterações. “Descrição” é a descrição do aplicativo; não representa todos os campos de perfil de uma conta pessoal.

### Vendas

1. Salve sua chave Pix, o nome do recebedor e as instruções em Configurações.
2. Configure a equipe de tickets para receber comprovantes e atender serviços.
3. Cadastre produtos em Produtos e estoque. Informe preço, descrição, categoria, imagem e, se quiser, cargo após a compra.
4. Em produtos digitais, adicione as unidades no botão **Estoque**: cada linha é uma chave, código ou link entregue a uma compra. Uma unidade corresponde a um pedido.
5. Publique cada produto no canal desejado. Clientes também podem usar `/loja`.
6. O pedido reserva uma unidade até o prazo configurado. O cancelamento e a expiração liberam a reserva.
7. Confira o crédito na sua conta bancária e aprove o pedido no painel. Não aprove apenas por uma imagem de comprovante.
8. O bot concede o cargo e envia a unidade reservada no privado. Serviços abrem ou reutilizam o atendimento do cliente.

O sistema usa valores em centavos. Aprovar duas vezes o mesmo pedido não cria uma segunda venda ou entrega. Se uma etapa falhar, o pedido permanece aprovado com entrega pendente e indicação do erro. A rotina tenta novamente a cada 30 segundos. DMs usam uma identificação para reduzir duplicações em reenvios próximos, mas a API externa não oferece garantia absoluta de envio único em todas as falhas possíveis.

O cliente pode recuperar uma entrega digital com `/pedido` mesmo com DMs bloqueadas. Produtos e preços ficam registrados no pedido como estavam no momento da compra. Alterações futuras no catálogo não mudam o valor dos pedidos existentes.

Este fluxo não gera Pix dinâmico, QR Code bancário nem confirmação por banco. Não processa estornos, assinaturas ou reembolsos automaticamente. Essas operações continuam manuais. O catálogo de `/loja` apresenta os primeiros 25 produtos ativos; outros produtos podem ser publicados individualmente nos canais.

### Tickets

Defina título, descrição, cor, texto do seletor, categorias de assunto, categoria Discord e cargo da equipe. Publique o painel. Há um ticket aberto por membro; equipe pode assumir; membro ou equipe podem encerrar. O fechamento salva até as 5.000 mensagens mais recentes em texto, incluindo links de anexos, e bloqueia novas mensagens do cliente no canal. Os arquivos anexos não são copiados; seus links podem expirar. O canal não é apagado automaticamente. Um ticket encerrado permite abrir um novo.

O fechamento por inatividade é opcional. Use `0` para manter desativado. O histórico só é capturado ao encerrar: mensagens apagadas antes disso não podem ser recuperadas.

### Mensagens e embeds

O editor inclui título, descrição, cor, autor, ícone, link, imagens, miniatura, rodapé, data e até 25 campos. Há prévia aproximada e modelos salvos. Mensagens em canais podem usar nome e avatar de webhook. Mensagens privadas são enviadas pelo próprio Studio K; não permitem trocar a identidade a cada envio.

Para mensagens opcionais pelo editor ou pela integração, o membro deve ativar `/notificacoes`. O mesmo comando desativa esse recebimento. Mensagens relacionadas a compras são parte do fluxo que o cliente iniciou. O envio depende das configurações de privacidade do destinatário. Não há disparo indiscriminado para todos os membros.

### Boas-vindas e saída

Configure texto, embed, canal e ativação separados para entrada e saída. Variáveis: `{user}`, `{username}`, `{server}` e `{count}`. A primeira identifica o membro; as outras mostram nome, servidor e quantidade de membros. O bot precisa estar conectado quando o evento acontecer.

### Verificação

Aceitação de regras pelo botão ou `/verificar`, idade mínima da conta e concessão de um cargo. Configure no Discord as permissões desse cargo. É uma verificação básica de entrada, não CAPTCHA, documento, biometria ou garantia contra contas falsas.

### Sorteios

Título/prêmio, descrição, canal, prazo, quantidade de vencedores e cargo obrigatório opcional. Inscrição única por membro. No encerramento, a aplicação verifica se o participante ainda está no servidor e possui o cargo exigido, seleciona os vencedores com aleatoriedade criptográfica e fixa o resultado no banco antes de anunciar. Se o anúncio falhar, a repetição usa o mesmo resultado. Sorteios vencidos durante uma interrupção são processados quando o bot retorna. Não há cobrança pela participação.

### Eventos

Criação de eventos externos nativos do Discord com título, descrição, início, término e local ou link. Os membros podem marcar interesse no próprio Discord. Nesta versão, alterações posteriores e cancelamento de um evento são feitos diretamente no Discord; o painel mantém o registro de criação, sem sincronizar essas edições.

### Registros

Histórico das ações do painel e do bot. Logs opcionais de membros, mensagens editadas/excluídas, banimentos, canais e cargos em um canal escolhido. Logs de mensagens guardam identificadores, não o conteúdo inteiro; históricos de tickets são separados. A interface exibe os últimos 100 registros e os últimos 200 pedidos/tickets; os demais permanecem no banco.

## Backups e recuperação

A cada intervalo definido, a aplicação salva:

- `.json`: configurações do painel e, quando conectado, nomes/IDs/estrutura de cargos, canais e permissões do servidor.
- `.sqlite`: cópia consistente do banco, incluindo pedidos, produtos, estoque cifrado, sessões e histórico.

Os backups ficam em `data/backups`, com quantidade máxima configurável. São locais; não protegem contra perda do próprio disco. Copie-os para um armazenamento seu periodicamente. Para recuperar o estoque cifrado, preserve também **`data/encryption.key`** em local seguro. A chave não é incorporada automaticamente aos downloads.

**Restaurar configurações** no painel restaura somente as configurações do Studio K. Não recria cargos/canais, não restaura mensagens do Discord, não muda vendas e não reverte pagamentos.

Para recuperação integral, pare a aplicação, preserve a pasta atual, coloque a cópia escolhida como `studio-k.sqlite` em uma pasta `data` nova, copie a chave de cifragem original para essa mesma pasta e reinicie apontando `DATA_DIR` para ela. Não misture uma cópia do banco com arquivos `-wal` ou `-shm` de outro momento. Uma cópia antiga restaura também estados antigos de vendas: antes de retomar automações, confira entregas e pagamentos realizados depois dela. Faça a recuperação offline; reative o token somente após essa conferência.

## Hospedar com acesso pela internet

Mantenha uma única instância do processo, com disco persistente. O banco SQLite e as filas desta versão são para uma instalação de um servidor, não para múltiplas réplicas. O frontend e a API devem ser servidos pela mesma origem.

1. Crie primeiro a senha local, com `HOST=127.0.0.1`.
2. Configure um domínio HTTPS em um proxy reverso da sua hospedagem.
3. Defina `PUBLIC_URL=https://seu-dominio`, `COOKIE_SECURE=true` e, se necessário dentro da hospedagem, `HOST=0.0.0.0`.
4. Restrinja a porta interna: o acesso externo deve passar pelo HTTPS.
5. Preserve a pasta `data` entre reinícios e atualizações. O `.env` e a chave não entram em repositórios.

O projeto inclui um `Dockerfile` opcional, usando o volume `/app/data`. Sem domínio/hospedagem informados, nenhuma implantação pública foi feita. A senha protege um administrador único; não há login Discord OAuth2 ou contas com permissões diferentes nesta versão.

## Integração semelhante a webhook

Endpoint: `POST /api/integrations/message`.

Defina `INTEGRATION_KEY` com um segredo aleatório de pelo menos 32 caracteres no `.env`. A integração é para uso de um servidor externo confiável, nunca de JavaScript público no navegador.

Cabeçalhos:

```text
Authorization: Bearer <seu-segredo>
Content-Type: application/json
Idempotency-Key: <identificador-unico-desta-mensagem>
```

Exemplo de corpo:

```json
{
  "target": "dm",
  "targetId": "ID_DO_MEMBRO",
  "content": "Sua atualização está disponível.",
  "embed": {
    "title": "Studio K",
    "description": "Detalhes da atualização.",
    "color": "#995cff"
  }
}
```

Use `target: "channel"` para canais. Para DMs opcionais, o membro deve estar no servidor e ter ativado `/notificacoes`. A chave de idempotência evita repetir solicitações já concluídas e registradas; não substitui a reconciliação de um envio cujo resultado ficou incerto por uma interrupção de rede/processo.

## Testes e limites da validação

```text
npm run check
npm test
```

A entrega foi verificada com 13 testes locais, incluindo transações de estoque, repetição de aprovação, expiração, estoque cifrado, sorteios, backups, autenticação, proteção contra requisições de outra origem e entrega com falha de DM simulada. Editor e salvamento de modelos foram conferidos no navegador. Consulte `VALIDACAO.md`.

Antes de usar com clientes, faça um pedido de teste de baixo valor sob seu controle, um ticket, uma verificação, uma entrada/saída e um sorteio de teste no servidor. Confirme a hierarquia de cargos e os canais. Esse teste real depende da sua instalação Discord e não foi substituído pelos testes simulados.

## Ideias para a próxima evolução

Cupons, avaliações após atendimento, orçamentos com aceite, fila de produção de serviços, prazos por pedido e confirmação automática pelo provedor Pix. Essas ideias não estão apresentadas como funcionalidades já implementadas.

## Referências

- [API de webhooks do Discord](https://docs.discord.com/developers/resources/webhook)
- [API de usuários e mensagens privadas](https://docs.discord.com/developers/resources/user)
- [Política para desenvolvedores](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy)
- [discord.js](https://discord.js.org/docs/packages/discord.js/main)

