# Tradução fora do Railway

O backend suporta dois provedores explícitos e não tenta acessar `libretranslate.railway.internal`. Sem configuração completa, o botão de tradução fica indisponível e as mensagens do bot permanecem no idioma original.

## Cloudflare Workers AI

Configure no ambiente privado do backend:

```dotenv
TRANSLATION_PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
```

No painel Cloudflare, entre em **AI → Workers AI → Use REST API**. A titular deve usar o template **Create a Workers AI API Token** e guardar o token no servidor. Se criar um token personalizado, a documentação atual exige **Workers AI Read e Workers AI Edit**, limitado à conta usada. O Account ID tem 32 caracteres hexadecimais. Não coloque o token no portfólio, em logs ou no Git.

Depois habilite o tradutor nas configurações do bot. Ele chama diretamente o modelo `@cf/meta/m2m100-1.2b` pela API oficial; não depende de um Worker hospedado nem do AI Gateway.

A Central distingue configuração presente de recurso habilitado. A indicação de provedor configurado é uma checagem local dos campos, não uma afirmação de conectividade ou de token já validado por chamada real.

As mensagens geradas pelo bot têm origem portuguesa declarada. Para a ação de traduzir uma mensagem existente, a detecção ocorre offline com `franc-min`, restrita aos dez idiomas oferecidos no seletor: português, inglês, espanhol, francês, alemão, italiano, japonês, coreano, chinês e russo. Amostras curtas ou ambíguas retornam um erro claro; nenhum idioma é presumido silenciosamente. A detecção é estatística, portanto não é uma garantia de acerto em textos mistos ou muito curtos.

O adaptador mantém menções, URLs, e-mails, timestamps, código e identificadores protegidos, reutiliza cache local por sete dias e limita a concorrência. Textos longos são divididos em partes. Na cota esgotada ou em erro do provedor, a localização automática conserva a mensagem original; não existe troca automática para outro serviço ou contratação de excedentes.

A oferta pública informa início grátis sem cartão e **10.000 neurons por dia** no Free. Não é um número fixo de mensagens: consumo depende dos tokens. No Free, chamadas além da franquia falham. Não habilite plano pago, Unified Billing ou créditos pré-pagos para este fluxo gratuito.

A API direta tem compromisso de retenção zero para inferência padrão e não usa conteúdo para treino, com exceções legais e operacionais documentadas. Logging/caching no AI Gateway e recursos com estado têm outras regras; esta integração não os usa. A detecção de idioma não transmite texto a outro fornecedor.

## LibreTranslate explícito

Para uma instância própria fora do Railway:

```dotenv
TRANSLATION_PROVIDER=libretranslate
LIBRETRANSLATE_URL=http://SEU-SERVICO:5000
LIBRETRANSLATE_API_KEY=
```

Sem `TRANSLATION_PROVIDER`, uma `LIBRETRANSLATE_URL` explícita continua sendo reconhecida para compatibilidade. O domínio privado antigo do Railway é recusado. A integração mantém `POST /translate`, array em `q` e detecção `source:auto` do serviço. O endpoint comercial `libretranslate.com` não é uma API gratuita garantida.

## Fontes e validação

Consultadas em 25/10/2026:

- [REST API e permissões do token](https://developers.cloudflare.com/workers-ai/get-started/rest-api/).
- [Modelo e contrato](https://developers.cloudflare.com/workers-ai/models/m2m100-1.2b/).
- [Oferta sem cartão](https://www.cloudflare.com/products/workers-ai/), [franquia e limites](https://developers.cloudflare.com/workers-ai/platform/pricing/).
- [Tratamento de dados](https://developers.cloudflare.com/workers-ai/platform/data-usage/).
- [franc: API e limites de detecção](https://github.com/wooorm/franc).
- [LibreTranslate](https://docs.libretranslate.com/).

Os testes usam transporte simulado. Nenhuma conta ou token foi criado, nenhuma mensagem real foi enviada e nenhum serviço foi publicado por este trabalho.
