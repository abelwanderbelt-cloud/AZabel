# OnePlay • Azabel v3.1

Versão para Render/Stremio/Nuvio com apenas:

- SuperStream — filmes e séries
- Cotonet — filmes
- OnePlay Live — catálogo de canais ao vivo

## Atualização
Substitua os arquivos do repositório GitHub pelos arquivos desta pasta e confirme o commit. O Render deve redeployar automaticamente.

## Testes
- `/health` deve mostrar `version: 3.1.0` e providers `super` e `cotonet`.
- `/manifest.json` deve declarar o catálogo `channel` chamado `OnePlay • TV ao vivo`.
- `/catalog/channel/oneplay-live.json` deve retornar os canais.
- `/debug/movie/tt0133093` testa os providers sem expor URLs.

Manifest para instalar:

`https://SEU-SERVICO.onrender.com/manifest.json`

Observação: fontes externas podem mudar ou ficar indisponíveis. Use apenas conteúdo que você tenha autorização para acessar.
