# Stremio/Nuvio Bridge — GitHub + Render

Projeto Node.js pronto para subir no GitHub e publicar no Render.

## O que ele faz

- expõe `manifest.json` compatível com Stremio/Nuvio;
- entrega streams de filmes e séries a partir de `data/streams.json`;
- cria um catálogo de TV ao vivo a partir de `data/channels.json`;
- não depende de Cloudflare Workers.

> Use apenas streams e APIs que você tenha autorização para acessar/distribuir.

## Subir no GitHub

1. Crie um repositório novo.
2. Envie **todos os arquivos desta pasta** para a raiz do repositório.
3. Faça commit.

## Publicar no Render

1. Entre no Render e escolha **New → Web Service**.
2. Conecte o repositório do GitHub.
3. O `render.yaml` já contém a configuração básica.
4. Build command: `npm install`
5. Start command: `npm start`
6. Depois do deploy, use:

   `https://SEU-SERVICO.onrender.com/manifest.json`

no Stremio/Nuvio.

## Adicionar um filme

Em `data/streams.json`:

```json
{
  "movie:tt0133093": [
    {
      "name": "Minha fonte",
      "title": "1080p",
      "url": "https://meu-servidor.exemplo/video.mp4"
    }
  ]
}
```

## Adicionar uma série

O Stremio normalmente usa `IMDB:temporada:episodio` no ID do stream. Exemplo:

```json
{
  "series:tt0411008:1:1": [
    {
      "name": "Minha fonte",
      "title": "S01E01",
      "url": "https://meu-servidor.exemplo/episodio.m3u8"
    }
  ]
}
```

## Adicionar TV ao vivo

Em `data/channels.json`:

```json
[
  {
    "id": "tv:meu-canal",
    "name": "Meu Canal",
    "poster": "https://.../logo.png",
    "url": "https://.../live.m3u8"
  }
]
```

## Próximo passo

Se você tiver uma API ou lista M3U **autorizada**, dá para trocar os JSONs estáticos por carregamento dinâmico sem mudar a URL instalada no Stremio/Nuvio.
