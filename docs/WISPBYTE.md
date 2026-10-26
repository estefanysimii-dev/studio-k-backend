# Studio K no Wispbyte Free

O backend usa Node 24, disco persistente e o subdomínio HTTPS `studiok-api.wisp.uno`.
O portfólio permanece em `https://studiokatelier.infinityfreeapp.com`.

## Arquivos e inicialização

- Código: `/home/container/app`.
- Dados restaurados: `/home/container/data`, incluindo SQLite, WAL/SHM, chave original e mídias.
- Ambiente privado: `/home/container/.env`, modo `0600`; nunca versionar ou incluir em pacotes públicos.
- Conversores: uma instalação verificada dentro de `/home/container/.studio-host-tools/run-*/`.
- Copiar o `env.sh` da instalação aprovada para `/home/container/.studio-host-tools/active-env.sh`.
- Binário Linux x64 `studio-k-fivem-preview`: `/home/container/studio-k-fivem-preview`, executável.
- Startup do painel: `/bin/sh /home/container/app/deploy/wisp/start.sh`.

O script mapeia `SERVER_PORT` para `PORT`, carrega somente os wrappers de conversão,
valida uma cópia do banco e a correspondência da chave antes de iniciar o bot.
Não inicialize um banco vazio como substituto dos dados originais.

O binário FiveM atual foi compilado em Linux x64 a partir do fonte `56af9c7`, com Rust
1.99.1 e Debian Bookworm. SHA256: `c412586077692bb30f48df418a9780da1ccac54f0c8c053e4b54aabbc66da889`.
A [execução de compilação](https://github.com/estefanysimii-dev/studio-k-backend/actions/runs/40205789700)
registra o toolchain e as bibliotecas. Para versões futuras, compile o fonte novo
fora do container gratuito e teste o binário antes de substituí-lo.

Use `PUBLIC_URL` e `PORTFOLIO_BACKEND_URL=https://studiok-api.wisp.uno`,
`PORTFOLIO_PUBLIC_URL=https://studiokatelier.infinityfreeapp.com` e
`STUDIO_DOMAIN=studiok-api.wisp.uno`. Preserve as credenciais existentes do Discord e do Google.
Os callbacks precisam terminar em `/api/oauth/discord/callback` e `/api/oauth/google/callback`
na origem nova. A tradução usa as variáveis descritas em [TRADUCAO.md](TRADUCAO.md).

O Pix automático fica desativado (`PURINCASH_ENABLED=false`) por decisão da titular.
O fluxo manual continua disponível. A ativação futura depende da verificação exigida pelo
PurinCash e de concluir o teste de sandbox descrito em [PURINCASH.md](PURINCASH.md).

## Conversores sem permissões de administrador

`deploy/wisp/host-preflight.mjs` lê recursos do container sem instalar nada.
`install-user-tools.mjs --stream-plan all` calcula o espaço necessário usando metadados
Debian autenticados. Só execute `--stream-install` quando o plano indicar `fits=true`.

O instalador usa um pacote por vez, verifica SHA256 e o conteúdo extraído, e remove
apenas seu próprio arquivo temporário de download após a verificação. Não executa
scripts de instalação nem altera pacotes do sistema. As versões são resolvidas pelos
repositórios Debian trixie assinados. O modo `--stage` reutiliza um estágio de plano vazio.

A instalação limita seus subprocessos a uma meta média de 12% de um núcleo, usando
o contador de CPU do cgroup e pausando somente seus próprios processos. As proteções
da hospedagem continuam ativas. A primeira tentativa sem esse controle foi interrompida
pelo provedor por CPU alta; por isso a preparação pode demorar mais no plano Free.

Uma instalação interrompida pode ser retomada explicitamente com
`--stream-resume all --stage CAMINHO --plan PLANO.json --journal REGISTRO.jsonl`.
O script revalida as versões e hashes contra metadados Debian assinados atualizados,
aceita somente o prefixo contínuo que teve download, conteúdo e limpeza verificados,
e recalcula o espaço para os pacotes restantes. Não use esse modo em uma instalação
completa nem altere o plano ou o registro para forçar a retomada.

Os limites de 700 MiB para ferramentas e 130 MiB de folga são guardas para este servidor
de 1 GiB com os dados restaurados. Recalcule após qualquer aumento relevante de dados;
um plano recusado não deve ser forçado. As bibliotecas ficam restritas aos wrappers.
Depois da instalação, use `converter-smoke.mjs --run` com o PATH da instalação para
validar OBJ→GLB, PSD→PNG e o carregamento do binário FiveM antes de ativar o startup.

## Operação gratuita

O plano oferece 512 MiB de RAM, 1 GiB de disco e 35% de um vCPU. Não dependa de boosts
temporários de RAM. Modelos 3D grandes podem exceder esses recursos; o teste pequeno
de conversão não garante capacidade para qualquer arquivo.

A [página oficial](https://wispbyte.com/) e o [detalhamento do Free](https://wispbyte.com/blog/free-hosting-comparison)
pedem login manual no painel a cada 14 dias. O guia inicial ainda menciona um mês;
adote o prazo menor. Os anúncios de renovação são descritos como opcionais, mas a
ativação inicial observada exigiu uma etapa de anúncio/verificação. Não há promessa
de recuperação automática sem interação em todo cenário.

Mantenha uma cópia privada externa de SQLite, chave e mídias. Os arquivos no container
e um ZIP de código não substituem esse backup. Preserve os dados antigos no Railway
até confirmar o funcionamento completo da instalação nova.
