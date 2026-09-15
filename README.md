# OnePlay • Azabel v4.1

Versão para GitHub + Render.

## O que mudou
- VOD: mantém apenas SuperStream + Cotonet.
- TV ao vivo: lê o `master.txt` usado pelo OnePlay Matrix 3.4.1, baixa as listas M3U e transforma os canais em catálogo `channel` do Stremio.
- O stream do canal vem diretamente da URL presente na M3U, inclusive headers no formato Kodi `URL|Header=valor` quando existirem.

## Deploy
Substitua os arquivos do repositório GitHub por estes. O Render deve redeployar automaticamente.

### Testes
- `/health` -> precisa mostrar `4.1.0`
- `/debug/live` -> mostra quantas listas e canais foram carregados
- `/catalog/channel/oneplay-live.json` -> lista de canais para o Stremio
- `/manifest.json` -> URL para instalar o addon

## Variáveis opcionais no Render
- `LIVE_MASTER_URL`: troca a URL do master.txt
- `LIVE_CACHE_MS`: cache em ms (padrão 10 min)
- `LIVE_MAX_LISTS`: máximo de listas lidas (padrão 40)
- `LIVE_MAX_CHANNELS`: máximo de canais (padrão 2500)
- `UPSTREAM_TIMEOUT_MS`: timeout upstream (padrão 12000)

Use apenas listas e streams que você tenha autorização para acessar.
