# PIX PurinCash

A integração usa a API REST oficial e funciona no backend Node existente. Nenhuma chave é enviada ao portfólio. Sem configuração completa, permanece o PIX manual atual.

## Configuração do servidor

Adicione ao arquivo de ambiente privado da VM, fora do repositório:

```dotenv
PURINCASH_ENABLED=false
PURINCASH_API_KEY=
PURINCASH_WEBHOOK_SECRET=
# O PUBLIC_URL existente precisa ser o endereço HTTPS público do backend novo.
```

No [painel PurinCash](https://purincash.com/dashboard/api), a titular deve obter a chave de teste `ps_test_` e o segredo de assinatura. Use `PURINCASH_ENABLED=true` apenas quando ambos estiverem configurados e o HTTPS funcionar. A URL de callback é derivada de `PUBLIC_URL`: `/api/webhooks/purincash`.

Sandbox identifica a cobrança como teste e nunca aprova pedidos nem libera estoque/cargos reais. A mudança para `ps_live_` exige conta aprovada e validação do fluxo na nova hospedagem. Não crie cobrança real apenas para testar a instalação.

## Fluxo e recuperação

- O servidor calcula o total após descontos, cria uma cobrança para o pedido ou carrinho e devolve código copia e cola, imagem QR, validade e indicação de teste.
- O cliente envia `idempotencyKey` estável em cada tentativa de checkout. Repetir a mesma tentativa devolve os mesmos IDs e a mesma resposta, inclusive após perda da resposta de rede. Uma tentativa simultânea ainda em processamento responde 409. A chave é obrigatória com PurinCash ativa; o cliente antigo continua funcionando com PIX manual.
- Uma cobrança incerta após erro de rede fica para conferência. O servidor não repete automaticamente `POST /v1/charges`, pois a documentação não define chave de idempotência nesse endpoint. O checkout ainda devolve os IDs dos pedidos e instruções para contato; a equipe deve conferir o painel antes de criar outra cobrança.
- `POST /api/portfolio/me/orders/:id/payment` exige sessão do dono e origem autorizada; recupera a cobrança já registrada. Não recria cobrança incerta. Em um carrinho, a mesma cobrança corresponde ao grupo inteiro.
- O webhook recebe os bytes crus antes do parser JSON, valida HMAC-SHA256 e persiste apenas campos de conciliação, sem CPF ou corpo bruto. Responde 202 e processa depois.
- Antes de aprovar, o backend consulta `GET /v1/charges/{paymentId}` e confere identificador, valor, BRL e estado. Ambiente é validado na criação e no evento: o schema oficial de consulta não expõe `environment`.
- Eventos são deduplicados no SQLite. Retentativas de consulta sobrevivem a reinício. Pagamento com pedido cancelado, expirado ou valor divergente fica para conferência; não há entrega parcial automática de carrinho.
- A confirmação usa a fila de entrega existente do bot. Com o Discord offline, o pedido pago continua aguardando a entrega. Não há saque ou reembolso automático nesta integração.

O SQLite novo inclui `purincash_charges`, `purincash_order_links` e `purincash_events`. Preserve essas tabelas junto ao banco, à chave `encryption.key` e aos uploads na migração.

## Contrato oficial consultado em 25/10/2026

- [Criar cobrança](https://docs.purincash.com/api-reference/cobrancas/create-charge): `POST /v1/charges`, valor inteiro em centavos a partir de 80, `expiresIn` em segundos. `expiresAt` vem no nível principal; `pix` contém `brCode` e `qrCodeImage`.
- [Consultar cobrança](https://docs.purincash.com/api-reference/cobrancas/get-charge).
- [Webhooks](https://docs.purincash.com/webhooks/visao-geral), [assinatura](https://docs.purincash.com/webhooks/assinatura) e [eventos PIX](https://docs.purincash.com/webhooks/pagamentos). São aceitos `payment.paid` e `charge.paid`, pois os guias de sandbox divergem sobre qual nome chega ao simular uma cobrança.
- [Autenticação](https://docs.purincash.com/guias/autenticacao): Bearer `ps_test_`/`ps_live_`; sem SDK obrigatório.

Hospedagem gratuita não torna o processamento de pagamento gratuito. A página pública anuncia R$ 0,50 por venda; os [Termos, seção 6](https://purincash.com/termos-de-uso/) estabelecem tarifas e limites por conta, exibidos no painel. Confira os valores efetivos na conta antes da ativação em produção.

Os testes locais usam transporte simulado e assinaturas de fixture. Nenhuma conta foi criada, chave real inserida, cobrança real enviada ou validação de produção executada.
