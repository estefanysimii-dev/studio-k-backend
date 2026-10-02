# Studio K — deploy em nuvem

## Backend (Railway)
- Builder: Dockerfile
- Health check: `/healthz`
- Volume persistente obrigatório: montar em `/app/data`
- Variáveis: use `.env.example` como referência.
- `PUBLIC_URL` deve apontar para o domínio do painel Netlify.
- `SETUP_KEY` e `INTEGRATION_KEY` devem ter 32+ caracteres aleatórios.
- Nunca envie `.env`, `data/`, `demo-data/` ou tokens ao repositório/deploy estático.

## Frontend (Netlify)
O navegador deve continuar chamando `/api/...` no mesmo domínio. Configure um proxy Netlify de `/api/*` para o backend Railway; isso preserva cookies HttpOnly/SameSite e a proteção CSRF sem expor o token Discord.

## Primeira configuração
No primeiro acesso, o painel solicitará a `SETUP_KEY` e uma senha administrativa de pelo menos 12 caracteres. A chave só é necessária uma vez; depois que a senha é criada, `/api/setup` deixa de aceitar nova configuração.
