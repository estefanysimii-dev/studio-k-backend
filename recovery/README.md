# Recuperação protegida do volume studio-k-data

**Não está implantado.** Esta branch isolada existe somente para preparar uma recuperação controlada; a branch `main` e a produção não foram modificadas.

## Por que usar este contêiner

A implantação original do `studio-k-backend` está offline e o Railway CLI precisa de um deployment ativo para navegar/baixar arquivos do volume. O contêiner daqui sobe um servidor HTTP mínimo para `/healthz` e **não abre** o SQLite, **não lê nem cria** `encryption.key`, **não inicializa** o bot e **não importa** o código da aplicação.

**Limitação importante:** o volume continuará montado com permissão de escrita no sistema. O contêiner apenas se compromete a não acessar os arquivos do volume; ele não cria uma montagem read-only. Qualquer mudança de deployment tem risco operacional e deve ser executada somente com autorização explícita.

## Identificadores atuais

- Projeto Railway: `Studio K`, ambiente: `production`
- Serviço original: `studio-k-backend`
- Volume existente: `studio-k-data` (`/app/data`)
- Branch temporária: `recovery/studio-k-data-20261024`
- Dockerfile temporário: `recovery/Dockerfile`

## Ordem exigida

1. Verificar no painel Railway se o volume original continua anexado e se a assinatura/limites permitem iniciar um serviço.
2. **Não criar** outro volume, não remover, não desanexar, não restaurar backups antigos, não alterar `DATA_DIR`.
3. Antes de alterar produção, aprovar explicitamente a troca temporária do source para esta branch e do caminho do Dockerfile para `recovery/Dockerfile` no **mesmo serviço**, mesmo ambiente, mantendo o **mesmo volume**. Preparar/stage mudanças primeiro; somente depois fazer o deploy aprovado.
4. Confirmar healthcheck `GET /healthz` respondendo `{"ok":true,"mode":"recovery"}` e verificar que o bot original não está executando.
5. Na máquina local com Railway CLI autenticada, vincular o projeto (serviço/ambiente) e usar:

```powershell
railway login
railway link
railway volume files --volume studio-k-data list /
New-Item -ItemType Directory -Force "$HOME\StudioK-Backup" | Out-Null
railway volume files --volume studio-k-data download / "$HOME\StudioK-Backup"
```

6. Verificar que os arquivos locais incluem `studio-k.sqlite`, `encryption.key`, a pasta `backups/` e quaisquer arquivos `studio-k.sqlite-wal` e `studio-k.sqlite-shm` existentes. Não compartilhar os arquivos de produção publicamente.
7. Verificar integridade do banco em uma cópia local, mantendo todos os arquivos SQLite sidecar juntos. Com Node 24 instalado:

```powershell
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1],{readOnly:true}); console.log(db.prepare('PRAGMA integrity_check').get());db.close()" "$HOME\StudioK-Backup\studio-k.sqlite"
```

A verificação deve retornar `{ integrity_check: 'ok' }`; caso não retorne, manter intocado o backup e analisar os arquivos `-wal`/ `-shm` e o estado do banco.

8. Fazer outra cópia de segurança externa, idealmente criptografada, antes de restaurar o serviço original.
9. Somente então reconectar o backend à branch `main`, restaurar o Dockerfile `Dockerfile` e solucionar os erros de build; testar healthcheck, Discord e integrações.

Se o CLI disser `has no active deployment`, `SFTP timeout` ou erro de créditos/assinatura, **não repetir mudanças destrutivas**. Voltar ao diagnóstico de billing/deployment e registrar o erro.

## Atenção ao Trial

A documentação Railway indica Trial de até 30 dias, crédito de US$5, e um período de retenção para volumes após a expiração dos créditos; verificar a data real no painel, não presumir que o crédito ainda existe.
