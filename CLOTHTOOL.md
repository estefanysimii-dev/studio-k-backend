# ClothTool — acesso da equipe

O aplicativo Windows solicita `POST /api/clothtool/device`. O usuário autoriza o código em Central → ClothTool. A autorização usa o mesmo middleware Staff do painel, com verificação adicional atualizada no Discord antes de emitir a sessão e a cada consulta do aplicativo.

- Código válido por 10 minutos; polling a cada 5 segundos; consumo único.
- Credencial aleatória de 256 bits, apenas seu SHA-256 no banco. Não aceita nas APIs do painel.
- Sessão de até 12 horas, vinculada à sessão web que aprovou o dispositivo.
- `GET /api/clothtool/session` exige Bearer e revalida cargo, expiração e sessão web.
- Sair do site ou revogar a conexão impede novas validações. O aplicativo verifica a cada 45 segundos, com timeout de 12 segundos, e bloqueia a interface se não puder confirmar acesso.
- Painel lista e revoga somente as conexões da própria conta. Revogar todas também cancela autorizações pendentes.
- Duas tabelas SQLite novas, criadas automaticamente no volume já usado pelo backend. Nenhum segredo ou serviço adicional necessário.
- Não há upload/download público de executáveis, credencial Discord no aplicativo ou rota administrativa liberada pelo token desktop.

Validação: `node --test tests/clothtool.test.js` cobre fluxo, origem, conta comum, expiração, repetição, perda de cargo, logout e revogação. A suíte completa é `npm test`.

O código do aplicativo desktop é entregue separadamente. O acesso desta versão não altera executáveis antigos já distribuídos nem constitui proteção contra modificações no código-fonte local.
