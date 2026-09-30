# Eagle Click 3.0 — índice estático

Esta versão tira a indexação pesada do Cloudflare Worker.

## 1. GitHub Secret

No repositório do índice, crie o Secret:

`M3U_URL`

Valor: a URL M3U completa do seu provedor. Ela contém username e password, então deve permanecer somente como Secret.

## 2. Arquivos

- `worker.js` → código completo para colar no Cloudflare Worker.
- `.github/workflows/update-index.yml` → atualização automática a cada 6 horas.
- `scripts/build-index.mjs` → baixa a M3U no GitHub Runner e cria o índice.
- `eagle-index/` → arquivos públicos de índice, sem username/password.

## 3. Configure o Worker

No topo de `worker.js`, altere somente:

`INDEX_BASE`

para:

`https://raw.githubusercontent.com/abelwanderbelt-cloud/AZabel/main/eagle-index`

O Worker continua lendo as credenciais de `LOGIN_SOURCE` apenas quando precisa montar o stream ou obter informações adicionais. O índice não contém credenciais.

## 4. Testes

Depois do primeiro workflow terminar:

`/debug/index`

Depois:

`/debug/search?q=The%20Substance`

A busca direta tenta o título normalizado primeiro. Só se não encontrar nada ela usa tradução PT/EN.
