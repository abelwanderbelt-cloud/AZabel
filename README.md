# OnePlay • Azabel v3.2

Versão para GitHub + Render.

- Filmes/séries: somente SuperStream + Cotonet.
- TV ao vivo: anunciada ao Stremio como um catálogo `movie` chamado **OnePlay • TV ao vivo** para forçar a exibição na interface.
- Os itens de TV usam IDs `live:*`; ao abrir um deles, o servidor resolve a transmissão ao vivo.

## Testes

- `/health` deve mostrar `3.2.0`.
- `/catalog/movie/oneplay-live.json` deve retornar a lista de canais.
- O manifest continua em `/manifest.json`.
