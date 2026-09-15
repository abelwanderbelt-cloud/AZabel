# OnePlay • Azabel v3

Bridge para Stremio/Nuvio baseado nos providers Stremio que aparecem no OnePlay Matrix 3.4.1.

## Deploy no Render

1. Substitua os arquivos do repositório pelos arquivos desta pasta.
2. No GitHub, confirme em **Commit changes**.
3. Aguarde o redeploy automático do Render.
4. Abra `https://SEU-SERVICO.onrender.com/health` e confirme `version: 3.0.0`.
5. Instale `https://SEU-SERVICO.onrender.com/manifest.json` no Stremio/Nuvio.

## Teste rápido

Depois do deploy, você pode abrir no navegador:

- `/debug/movie/tt0133093` para testar um filme por IMDb.
- `/debug/series/tt0411008:1:1` para testar uma série/episódio.

A rota de debug mostra apenas contagens por provider; os streams são entregues normalmente ao Stremio/Nuvio.

## Providers integrados

- FrostStream
- SuperStream
- FenixFlix
- BestCine
- Cotonet (filmes)
- OnePlay Live / EmbedTV para catálogo de TV ao vivo

Os serviços upstream são externos e podem mudar ou ficar indisponíveis sem aviso.
