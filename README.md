# OnePlay • Azabel FINAL v4.0

Versão final do bridge para Stremio/Nuvio.

- Filmes/séries: **SuperStream + Cotonet**
- Canais ao vivo: catálogo nativo **`channel`**
- Manifest: `/manifest.json`
- Health: `/health`
- Catálogo de canais: `/catalog/channel/oneplay-live.json`

## Atualizar no Render
Substitua os arquivos do repositório GitHub por estes, faça **Commit changes** e aguarde o redeploy automático do Render.

Depois confirme:

`https://azabel.onrender.com/health`

Deve mostrar `"version":"4.0.0"`.

No Stremio, remova a versão antiga do addon e instale novamente:

`https://azabel.onrender.com/manifest.json`

Isso é importante porque o Stremio pode manter em cache a versão antiga do manifest.
