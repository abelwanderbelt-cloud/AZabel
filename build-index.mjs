run: node build-index.mjs
``` :chatgpt-content-reference{index="1"}


Então **não rode o Action de novo ainda**.

### Substitua `build-index.mjs` inteiro por este

Abra:

`AZabel → build-index.mjs → Edit`

Apague tudo e cole:

```javascript
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const M3U_URL_RAW = process.env.M3U_URL;

const OUTPUT_DIR =
  process.env.OUTPUT_DIR || "eagle-index";

const SHARD_COUNT = 256;
const MAX_TOKEN_ITEMS = 300;
const MAX_RETRIES = 8;

if (!M3U_URL_RAW) {
  throw new Error(
    "M3U_URL não foi configurada como GitHub Secret."
  );
}

/*
 * Corrige URLs que tenham sido coladas com:
 * \&
 * aspas
 * espaços acidentais
 */
const M3U_URL = M3U_URL_RAW
  .trim()
  .replace(/^["']|["']$/g, "")
  .replace(/\\&/g, "&");

/* =========================================================
   NORMALIZAÇÃO
========================================================= */

const STOP_WORDS = new Set([
  "a", "o", "as", "os",
  "um", "uma", "uns", "umas",
  "de", "da", "do", "das", "dos",
  "e", "em", "no", "na", "nos", "nas",
  "por", "para", "com", "sem",
  "the", "an", "of", "and",
  "in", "on", "to", "for",
  "with", "from"
]);

function normalizeCore(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(
      /\((?:[^)]*(?:2160p|1080p|720p|480p|4k|uhd|fhd|hd|sd|dublado|dub|dual|legendado|leg|sub|pt[- ]?br|original)[^)]*)\)/gi,
      " "
    )
    .replace(
      /\b(2160p|2160|4k|uhd|1080p|1080|fhd|720p|720|hd|480p|480|sd)\b/gi,
      " "
    )
    .replace(
      /\b(dual\s*audio|dual|dublado|dub|legendado|leg|subtitled|sub|pt[- ]?br|portugues|portugu[eê]s|original|english)\b/gi,
      " "
    )
    .replace(
      /\b(19|20)\d{2}\b/g,
      " "
    )
    .replace(
      /[^a-z0-9]+/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function tokensOf(text) {
  return [
    ...new Set(
      normalizeCore(text)
        .split(" ")
        .filter(
          x =>
            x.length >= 3 &&
            !STOP_WORDS.has(x)
        )
    )
  ];
}

/* =========================================================
   QUALIDADE / AUDIO / ANO
========================================================= */

function qualityOf(name) {
  const n =
    String(name || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

  if (
    /\b(2160p|2160|4k|uhd)\b/.test(n)
  ) {
    return "4K";
  }

  if (
    /\b(1080p|1080|fhd)\b/.test(n)
  ) {
    return "1080p";
  }

  if (
    /\b(720p|720|hd)\b/.test(n)
  ) {
    return "720p";
  }

  if (
    /\b(480p|480|sd)\b/.test(n)
  ) {
    return "480p";
  }

  return "";
}

function audioOf(name) {
  const n =
    String(name || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

  if (
    /\bdual\s*audio\b/.test(n) ||
    /\bdual\b/.test(n)
  ) {
    return "Dual Áudio";
  }

  if (
    /\bdublado\b/.test(n) ||
    /\bdub\b/.test(n) ||
    /\bpt[- ]?br\b/.test(n) ||
    /\bportugues\b/.test(n)
  ) {
    return "Dublado";
  }

  if (
    /\blegendado\b/.test(n) ||
    /\bleg\b/.test(n) ||
    /\bsubtitled\b/.test(n) ||
    /\bsub\b/.test(n)
  ) {
    return "Legendado";
  }

  if (
    /\boriginal\b/.test(n) ||
    /\benglish\b/.test(n)
  ) {
    return "Original";
  }

  return "";
}

function yearOf(name) {
  return (
    String(name || "")
      .match(/\b(19|20)\d{2}\b/)?.[0] ||
    ""
  );
}

/* =========================================================
   M3U ATTRIBUTES
========================================================= */

function parseAttr(line, name) {
  const match =
    line.match(
      new RegExp(
        `${name}="([^"]*)"`,
        "i"
      )
    );

  return match?.[1] || "";
}

function parseExtinf(line) {
  const comma =
    line.indexOf(",");

  const title =
    comma >= 0
      ? line
          .slice(comma + 1)
          .trim()
      : "";

  return {
    name:
      title ||
      parseAttr(line, "tvg-name") ||
      "Filme",
    poster:
      parseAttr(line, "tvg-logo"),
    group:
      parseAttr(line, "group-title"),
    tvgName:
      parseAttr(line, "tvg-name")
  };
}

/* =========================================================
   ID
========================================================= */

function extractPathInfo(streamUrl) {
  try {
    const u =
      new URL(streamUrl);

    const parts =
      u.pathname
        .split("/")
        .filter(Boolean);

    const movieIndex =
      parts.findIndex(
        x =>
          x.toLowerCase() ===
          "movie"
      );

    if (
      movieIndex < 0 ||
      !parts[movieIndex + 3]
    ) {
      return null;
    }

    const file =
      parts[
        parts.length - 1
      ];

    const match =
      file.match(
        /^(.+?)\.([^.\/]+)$/
      );

    if (!match) {
      return null;
    }

    return {
      id:
        decodeURIComponent(
          match[1]
        ),
      extension:
        match[2].toLowerCase()
    };
  } catch (_) {
    return null;
  }
}

/* =========================================================
   HASH / SHARD
========================================================= */

function fnv1a(value) {
  let hash =
    0x811c9dc5;

  const text =
    String(value || "");

  for (
    let i = 0;
    i < text.length;
    i++
  ) {
    hash ^=
      text.charCodeAt(i);

    hash =
      Math.imul(
        hash,
        0x01000193
      );
  }

  return hash >>> 0;
}

function shardFor(value) {
  return (
    fnv1a(value) & 0xff
  )
    .toString(16)
    .padStart(2, "0");
}

/* =========================================================
   URL VARIANTS
========================================================= */

function buildUrlVariants(
  raw
) {
  const variants = [];

  let base;

  try {
    base =
      new URL(raw);
  } catch (error) {
    throw new Error(
      `M3U_URL inválida: ${error.message}`
    );
  }

  const add =
    u => {
      const value =
        u.toString();

      if (
        !variants.includes(
          value
        )
      ) {
        variants.push(
          value
        );
      }
    };

  /*
   * Original.
   */
  add(
    new URL(
      base.toString()
    )
  );

  /*
   * HTTP / HTTPS alternativos.
   */
  if (
    base.protocol ===
    "http:"
  ) {
    const https =
      new URL(
        base.toString()
      );

    https.protocol =
      "https:";

    add(https);
  } else {
    const http =
      new URL(
        base.toString()
      );

    http.protocol =
      "http:";

    add(http);
  }

  /*
   * Variantes de output.
   */
  for (
    const output
    of [
      "ts",
      "mpegts",
      "m3u8"
    ]
  ) {
    const u =
      new URL(
        base.toString()
      );

    u.searchParams.set(
      "type",
      "m3u_plus"
    );

    u.searchParams.set(
      "output",
      output
    );

    add(u);
  }

  /*
   * Sem output.
   */
  {
    const u =
      new URL(
        base.toString()
      );

    u.searchParams.delete(
      "output"
    );

    add(u);
  }

  return variants;
}

/* =========================================================
   DOWNLOAD DA M3U
========================================================= */

async function downloadM3U() {
  const urls =
    buildUrlVariants(
      M3U_URL
    );

  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36",
    "VLC/3.0.21 LibVLC/3.0.21",
    "curl/8.5.0",
    "EagleClick/3.1"
  ];

  let lastError =
    null;

  for (
    let attempt = 0;
    attempt <
      MAX_RETRIES;
    attempt++
  ) {
    const url =
      urls[
        attempt %
          urls.length
      ];

    const userAgent =
      userAgents[
        attempt %
          userAgents.length
      ];

    console.log(
      `Tentativa M3U ${attempt + 1}/${MAX_RETRIES}`
    );

    try {
      const response =
        await fetch(
          url,
          {
            method:
              "GET",
            redirect:
              "follow",
            headers: {
              accept:
                "application/x-mpegurl,audio/x-mpegurl,text/plain,*/*",
              "user-agent":
                userAgent,
              "cache-control":
                "no-cache",
              pragma:
                "no-cache",
              referer:
                "http://sventank.com/",
              connection:
                "close"
            }
          }
        );

      console.log(
        `HTTP ${response.status}`
      );

      const body =
        await response.text();

      if (
        response.ok &&
        (
          body.includes(
            "#EXTM3U"
          ) ||
          body.includes(
            "#EXTINF:"
          )
        )
      ) {
        console.log(
          `M3U recebida com sucesso: ${(
            body.length /
            1024 /
            1024
          ).toFixed(2)} MB`
        );

        return body;
      }

      /*
       * Loga o corpo sem mostrar credenciais.
       */
      const safeBody =
        body
          .replace(
            /([?&](?:username|password|user|pass)=)[^&\s]+/gi,
            "$1[REDACTED]"
          )
          .slice(
            0,
            1200
          );

      console.log(
        `Resposta não utilizável: ${safeBody}`
      );

      lastError =
        new Error(
          `M3U HTTP ${response.status}`
        );
    } catch (error) {
      lastError =
        error;

      console.log(
        `Erro na tentativa: ${String(
          error?.message ||
            error
        )}`
      );
    }

    if (
      attempt <
      MAX_RETRIES - 1
    ) {
      const wait =
        3000 *
        (attempt + 1);

      console.log(
        `Aguardando ${wait} ms...`
      );

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            wait
          )
      );
    }
  }

  throw (
    lastError ||
    new Error(
      "Não foi possível baixar a M3U."
    )
  );
}

/* =========================================================
   INDEX
========================================================= */

function addToMap(
  map,
  key,
  record,
  limit = Infinity
) {
  if (!key) {
    return;
  }

  let array =
    map.get(key);

  if (!array) {
    array = [];
    map.set(
      key,
      array
    );
  }

  if (
    array.length >=
    limit
  ) {
    return;
  }

  if (
    !array.some(
      x =>
        x.i ===
        record.i
    )
  ) {
    array.push(
      record
    );
  }
}

function compactRecord(
  raw
) {
  return {
    i:
      String(raw.id),
    t:
      "movie",
    n:
      String(raw.name || ""),
    p:
      String(
        raw.poster || ""
      ),
    q:
      String(
        raw.quality || ""
      ),
    a:
      String(
        raw.audio || ""
      ),
    e:
      String(
        raw.extension ||
          "mp4"
      ),
    y:
      String(
        raw.year || ""
      )
  };
}

async function buildIndex(
  playlist
) {
  await rm(
    OUTPUT_DIR,
    {
      recursive:
        true,
      force:
        true
    }
  );

  await mkdir(
    join(
      OUTPUT_DIR,
      "shards"
    ),
    {
      recursive:
        true
    }
  );

  const phraseMaps =
    Array.from(
      {
        length:
          SHARD_COUNT
      },
      () =>
        new Map()
    );

  const tokenMaps =
    Array.from(
      {
        length:
          SHARD_COUNT
      },
      () =>
        new Map()
    );

  const idMaps =
    Array.from(
      {
        length:
          SHARD_COUNT
      },
      () =>
        new Map()
    );

  const catalog =
    [];

  const seenIds =
    new Set();

  let current =
    null;

  let totalLines =
    0;

  let movies =
    0;

  const lines =
    String(
      playlist
    ).split(
      /\r?\n/
    );

  for (
    const rawLine
    of lines
  ) {
    totalLines++;

    const line =
      rawLine.trim();

    if (!line) {
      continue;
    }

    if (
      line
        .toUpperCase()
        .startsWith(
          "#EXTINF:"
        )
    ) {
      current =
        parseExtinf(
          line
        );

      continue;
    }

    if (
      line.startsWith(
        "#"
      )
    ) {
      continue;
    }

    if (!current) {
      continue;
    }

    const pathInfo =
      extractPathInfo(
        line
      );

    if (!pathInfo) {
      current =
        null;

      continue;
    }

    if (
      seenIds.has(
        pathInfo.id
      )
    ) {
      current =
        null;

      continue;
    }

    const name =
      current.name ||
      "Filme";

    const key =
      normalizeCore(
        name
      );

    if (!key) {
      current =
        null;

      continue;
    }

    const record =
      compactRecord({
        id:
          pathInfo.id,
        name,
        poster:
          current.poster,
        quality:
          qualityOf(
            name
          ),
        audio:
          audioOf(
            name
          ),
        extension:
          pathInfo.extension,
        year:
          yearOf(
            name
          )
      });

    seenIds.add(
      record.i
    );

    movies++;

    /*
     * Phrase index.
     */
    const phraseShard =
      fnv1a(key) &
      0xff;

    addToMap(
      phraseMaps[
        phraseShard
      ],
      key,
      record
    );

    /*
     * Token index.
     */
    const tokens =
      tokensOf(
        name
      );

    for (
      const token
      of tokens
    ) {
      const tokenShard =
        fnv1a(token) &
        0xff;

      addToMap(
        tokenMaps[
          tokenShard
        ],
        token,
        record,
        MAX_TOKEN_ITEMS
      );
    }

    /*
     * ID index.
     */
    const idShard =
      fnv1a(
        record.i
      ) &
      0xff;

    idMaps[
      idShard
    ].set(
      record.i,
      record
    );

    /*
     * Catálogo inicial.
     */
    if (
      catalog.length <
      100
    ) {
      catalog.push(
        record
      );
    }

    if (
      movies %
        10000 ===
      0
    ) {
      console.log(
        `Filmes processados: ${movies}`
      );
    }

    current =
      null;
  }

  console.log(
    `Linhas processadas: ${totalLines}`
  );

  console.log(
    `Filmes encontrados: ${movies}`
  );

  /*
   * Grava 256 shards.
   */
  for (
    let shardIndex = 0;
    shardIndex <
      SHARD_COUNT;
    shardIndex++
  ) {
    const p = {};
    const t = {};
    const i = {};

    for (
      const [
        key,
        list
      ]
      of phraseMaps[
        shardIndex
      ]
    ) {
      p[key] =
        list;
    }

    for (
      const [
        key,
        list
      ]
      of tokenMaps[
        shardIndex
      ]
    ) {
      t[key] =
        list;
    }

    for (
      const [
        key,
        record
      ]
      of idMaps[
        shardIndex
      ]
    ) {
      i[key] =
        record;
    }

    const shardName =
      shardIndex
        .toString(16)
        .padStart(
          2,
          "0"
        );

    await writeFile(
      join(
        OUTPUT_DIR,
        "shards",
        `${shardName}.json`
      ),
      JSON.stringify(
        {
          p,
          t,
          i
        }
      ),
      "utf8"
    );
  }

  /*
   * catalog.json
   */
  await writeFile(
    join(
      OUTPUT_DIR,
      "catalog.json"
    ),
    JSON.stringify(
      {
        items:
          catalog
      }
    ),
    "utf8"
  );

  /*
   * manifest.json
   */
  await writeFile(
    join(
      OUTPUT_DIR,
      "manifest.json"
    ),
    JSON.stringify(
      {
        version:
          "3.0.1",
        generatedAt:
          new Date().toISOString(),
        totalEntries:
          movies,
        shards:
          SHARD_COUNT
      },
      null,
      2
    ),
    "utf8"
  );

  /*
   * build-info.json
   */
  await writeFile(
    join(
      OUTPUT_DIR,
      "build-info.json"
    ),
    JSON.stringify(
      {
        generatedAt:
          new Date().toISOString(),
        totalLines,
        totalMovies:
          movies
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(
    "========================================"
  );

  console.log(
    "ÍNDICE GERADO COM SUCESSO"
  );

  console.log(
    `Total de filmes: ${movies}`
  );

  console.log(
    "========================================"
  );
}

/* =========================================================
   EXECUÇÃO
========================================================= */

console.log(
  "========================================"
);

console.log(
  "Eagle Click Index Builder 3.0.1"
);

console.log(
  "========================================"
);

console.log(
  "Baixando M3U..."
);

const playlist =
  await downloadM3U();

console.log(
  "Construindo índice..."
);

await buildIndex(
  playlist
);

console.log(
  "Finalizado."
);
