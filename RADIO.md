# Rádio Studio K — configuração e publicação

Implementação nos repositórios atuais, baseada em:
- site: 0d1a354ab9d6a697e0406540845df863c508fa5a
- backend: a3e7fd520ff486c325111d07617048dcea6793bd

## Onde configurar
Central de Controle → Site → Rádio Studio K → Salvar alterações.
Ative a rádio, informe nome, fonte, playlist Spotify, posição, modo compacto, volume inicial e exibição na Central. O visitante pode trocar o tema pelo header. Tema, volume e expansão ficam no localStorage. Nenhum token Spotify é necessário para Embed.

## Escolha da fonte
Spotify Embed: reproduz pela experiência oficial do Spotify, sujeito ao contexto do visitante. Play/pause controlados pela iFrame API; se bloqueado, o visitante pode usar o player oficial ao expandir. Sem garantia de sincronização musical, sem volume pela API e sem PCM. Voltar ao vivo e volume são desativados com explicação. O glow decorativo segue playback_update, nunca é apresentado como análise espectral.

Programação própria: lista JSON ordenada com title, url e duration (segundos reais). Arquivos devem ser HTTPS ou caminhos no próprio site. A sequência se repete. O servidor cria e persiste epochMs ao configurar/alterar a fonte ou as faixas. Alterar nome/posição, desativar/reativar e reiniciar o servidor preservam o epoch. O player consulta /api/portfolio/radio sem cache, estima o relógio com a metade do tempo de ida/volta e avança a faixa/posição com base nesse epoch. Pausar e retomar volta ao ponto atual. Há correção de desvio acima de dois segundos, nova consulta a cada 30 segundos e realinhamento ao voltar à aba.

Exemplo:
```json
[
  {"title":"Faixa 1","url":"https://audio.seudominio.com/faixa-1.mp3","duration":180},
  {"title":"Faixa 2","url":"https://audio.seudominio.com/faixa-2.mp3","duration":210}
]
```

HLS: URL de transmissão ao vivo existente. Safari usa suporte nativo; outros navegadores compatíveis usam hls.js, carregado somente neste modo. O ponto comum vem da janela da transmissão (não de uma playlist Spotify); voltar ao vivo usa liveSyncPosition ou o fim da janela menos três segundos. Latência e buffer podem variar entre visitantes. Não há servidor de transmissão incluído.

Análise real: ative somente para áudio próprio com CORS. AnalyserNode calcula energia em 40–250 Hz e 2–10 kHz. Começa após interação do visitante, respeitando AudioContext/autoplay. A fonte e, em HLS, os segmentos precisam permitir CORS; sem isso, desative a análise para evitar áudio bloqueado. Não há extração de áudio do Spotify.

## Publicação
1. Use os projetos na raiz de studio-k-backend e studio-k-portfolio deste pacote. A pasta e ZIP antigos studio-k-backend-railway presentes no histórico do repositório não recebem estas alterações.
2. Publique primeiro o backend no serviço Railway existente. Preserve o volume DATA_DIR e todas as variáveis OAuth2/bot. Não substitua o banco por dados de teste. Faça backup normal do volume antes da publicação.
3. No frontend Netlify, preserve STUDIO_BACKEND_URL com o endereço Railway e STUDIO_PUBLIC_URL com a origem pública existente. Node 24. Instalação: npm ci. Build: npm run build. Use a integração Next.js existente.
4. As novas configurações usam portfolio:site no mesmo SQLite. Site antigo recebe rádio desativada por padrão. Não é necessária migração destrutiva, novo banco ou nova conta OAuth.
5. Confira /api/portfolio/radio, login Discord, acesso Staff à Central, salvar rádio, produtos/checkout, portfólio e viewer 3D. Teste dois dispositivos com a fonte musical final, além de autoplay bloqueado, CORS, celular e Safari.
6. Rollback: republicar os commits anteriores. O campo adicional radio pode continuar no banco; versões anteriores o ignoram.

## Validação nesta entrega
Build Next.js e tipos passaram. 32 testes do backend e 1 teste do relógio do frontend passaram. Verificações de sintaxe passaram. Testes novos cobrem validação, epoch, loop, persistência SQLite, endpoint público sem cache e bloqueio de edição não autorizada.

Navegador local: áudio sintético de teste próprio confirmou play/pause, retomada ao vivo, troca de página sem recriar player, volume e AnalyserNode com energia real de graves/agudos. Uma medição local ficou a cerca de 2 ms do relógio comum; isso não é promessa de precisão na internet. Tema claro/escuro foi conferido visualmente.

Não houve publicação em produção. Não foram usados tokens Discord reais nem credenciais de produção. HLS real, reprodução completa de playlists Spotify, OAuth2 real, pagamentos e o viewer com um modelo real não foram validados ponta a ponta nesta sessão. O Embed do Spotify não terminou de carregar na prévia do navegador integrado; o código inclui timeout e orientação para abrir no Spotify. ClothTool permanece fora desta etapa.

## Documentação oficial consultada antes de implementar
- https://developer.spotify.com/documentation/embeds/references/iframe-api
- https://developer.spotify.com/documentation/embeds/tutorials/using-the-iframe-api
- https://developer.spotify.com/documentation/embeds/tutorials/creating-an-embed

A documentação de seek descreve episódios de podcast e não garante seek de faixas musicais/playlist. A lista de métodos não oferece setVolume. Por isso um link de playlist, sozinho, não implementa a rádio musical sincronizada solicitada.
