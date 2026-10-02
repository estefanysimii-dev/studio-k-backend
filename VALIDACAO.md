# Validação — Studio K

Data: 1º de outubro de 2026.

## Verificado localmente

- Verificação de sintaxe do servidor, integração Discord, banco e interface: passou.
- 13 testes automatizados: passaram.
- Autenticação com senha, sessões, logout, origem da requisição e proteção das alterações: passaram nos testes HTTP.
- Reserva da última unidade de estoque, liberação ao cancelar e bloqueio de aprovação de pedido expirado: passaram.
- Aprovação repetida de pedido: não cria novo registro de pagamento nem reserva nova unidade.
- Pedido mantém o preço e o produto registrados na compra, mesmo após alteração do catálogo.
- Cifragem de estoque: leitura após reabrir a instalação e detecção de alteração indevida verificadas.
- Sorteio: vencedores únicos, sem alteração do resultado ao repetir a finalização.
- Backup: geração de cópia SQLite e configurações JSON verificada.
- Mensagem privada opcional: opt-in e opt-out verificados com transporte simulado.
- Entrega: falha de DM simulada mantém entrega pendente; nova tentativa entrega a mesma unidade; uma execução posterior não entrega novamente.
- Painel no navegador: entrada na demonstração, navegação, editor com prévia e salvamento de modelo verificados. Vitrine e menu conferidos em largura móvel de 390 px, sem transbordamento horizontal na página observada.
- Instalação de dependências: auditoria do gerenciador sem vulnerabilidades conhecidas reportadas no momento da instalação. Isso não equivale a uma auditoria de segurança completa.

## Não verificado ao vivo

Token, gateway, intents, permissões e hierarquia de cargos do seu servidor; criação de canais; publicação de mensagens, webhooks, sorteios e eventos; alterações de avatar/banner; entrega real e recebimento de Pix. Nenhuma credencial Discord foi fornecida e nenhuma venda real foi processada.

Não foi realizada implantação em hospedagem externa. O Dockerfile foi fornecido como opção, mas sua imagem não foi construída/testada nesta entrega. O painel é de administrador único; não há gestão de múltiplos operadores.

## Aceitação no seu servidor

Depois da configuração, validar: entrada e saída de um membro de teste; embed em canal; adesão e cancelamento de notificações; ticket e histórico; cargo de verificação; compra digital com estoque e recuperação por `/pedido`; compra de serviço; concessão do cargo de compra; sorteio com prazo curto; evento; backup e restauração apenas das configurações.

Os testes simulados verificam a lógica da aplicação, mas não substituem essa validação no Discord.
