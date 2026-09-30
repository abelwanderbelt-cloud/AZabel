import fs from "node:fs/promises";
import path from "node:path";

/*
 * =========================================================
 * EAGLE CLICK - INDEX BUILDER
 * =========================================================
 *
 * Entrada:
 *   M3U_URL (GitHub Secret)
 *
 * Saída:
 *   eagle-index/
 *   ├── manifest.json
 *   ├── catalog.json
 *   └── shards/
 *       ├── 00.json
 *       ├── 01.json
 *       └── ...
 *       └── ff.json
 *
 * IMPORTANTE:
 * - Não grava username/password no índice.
 * - Guarda apenas o ID Xtream e metadados necessários.
 * - O Worker reconstrói a URL do stream usando as credenciais.
 */

/* =========================================================
   CONFIG
========================================================= */

const M3U_URL =
  process.env.M3U_URL;

if (!M3U_URL) {
  throw new Error(
    "M3U_URL não foi configurada no GitHub Secrets."
  );
}

const OUTPUT_DIR =
  path.resolve(
    "eagle-index"
  );

const SHARDS_DIR =
  path.join(
    OUTPUT_DIR,
    "shards"
  );

const MAX_M3U_RETRIES = 6;

/* =========================================================
   UTILS
========================================================= */

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

function normalizeBaseUrl(
  value
) {
  try {
    const u =
      new URL(
        value
      );

    return u.origin;
  } catch (_) {
    return "";
  }
}

function cleanText(
  value
) {
  return String(
    value || ""
  )
    .replace(
      /<!\[CDATA\[([\s\S]*?)\]\]>/g,
      "$1"
    )
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /&lt;/gi,
      "<"
    )
    .replace(
      /&gt;/gi,
      ">"
    )
    .trim();
}

function normalizeSearch(
  text
) {
  return cleanText(
    text
  )
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .replace(
      /\[[^\]]*\]/g,
      " "
    )
    .replace(
      /\([^)]*(?:2160p|1080p|720p|480p|4k|uhd|fhd|hd|sd|dublado|dub|dual|legendado|leg|sub|original|pt[- ]?br)[^)]*\)/gi,
      " "
    )
    .replace(
      /\b(?:2160p|2160|4k|uhd|1080p|1080|fhd|720p|720|hd|480p|480|sd)\b/gi,
      " "
    )
    .replace(
      /\b(?:dual\s*audio|dual|dublado|dub|legendado|leg|subtitled|sub|original|portugues|portugu[eê]s|english|pt[- ]?br)\b/gi,
      " "
    )
    .replace(
      /\b(?:19|20)\d{2}\b/g,
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

function getTokens(
  text
) {
  return [
    ...new Set(
      normalizeSearch(
        text
      )
        .split(" ")
        .filter(
          token =>
            token.length >= 2
        )
    )
  ];
}

function qualityLabel(
  text
) {
  const n =
    cleanText(
      text
    )
      .normalize("NFD")
      .replace(
        /[\u0300-\u036f]/g,
        ""
      )
      .toLowerCase();

  if (
    /\b(?:2160p|2160|4k|uhd)\b/.test(
      n
    )
  ) {
    return "4K";
  }

  if (
    /\b(?:1080p|1080|fhd)\b/.test(
      n
    )
  ) {
    return "1080p";
  }

  if (
    /\b(?:720p|720|hd)\b/.test(
      n
    )
  ) {
    return "720p";
  }

  if (
    /\b(?:480p|480|sd)\b/.test(
      n
    )
  ) {
    return "480p";
  }

  return "";
}

function audioLabel(
  text
) {
  const n =
    cleanText(
      text
    )
      .normalize("NFD")
      .replace(
        /[\u0300-\u036f]/g,
        ""
      )
      .toLowerCase();

  if (
    /\bdual\s*audio\b/.test(
      n
    ) ||
    /\bdual\b/.test(
      n
    )
  ) {
    return "Dual Áudio";
  }

  if (
    /\bdublado\b/.test(
      n
    ) ||
    /\bdub\b/.test(
      n
    ) ||
    /\bpt[- ]?br\b/.test(
      n
    ) ||
    /\bportugues\b/.test(
      n
    )
  ) {
    return "Dublado";
  }

  if (
    /\blegendado\b/.test(
      n
    ) ||
    /\bleg\b/.test(
      n
    ) ||
    /\bsubtitled\b/.test(
      n
    ) ||
    /\bsub\b/.test(
      n
    )
  ) {
    return "Legendado";
  }

  if (
    /\boriginal\b/.test(
      n
    ) ||
    /\benglish\b/.test(
      n
    )
  ) {
    return "Original";
  }

  return "";
}

function parseAttribute(
  line,
  attribute
) {
  const regex =
    new RegExp(
      `${attribute}="([^"]*)"`,
      "i"
    );

  return cleanText(
    line.match(
      regex
    )?.[1] || ""
  );
}

function parseExtInf(
  line
) {
  const comma =
    line.indexOf(
      ","
    );

  let name =
    comma >= 0
      ? line
          .slice(
            comma + 1
          )
          .trim()
      : "";

  if (!name) {
    name =
      parseAttribute(
        line,
        "tvg-name"
      );
  }

  return {
    name:
      cleanText(
        name
      ),
    tvgName:
      parseAttribute(
        line,
        "tvg-name"
      ),
    logo:
      parseAttribute(
        line,
        "tvg-logo"
      ),
    group:
      parseAttribute(
        line,
        "group-title"
      ),
    tvgId:
      parseAttribute(
        line,
        "tvg-id"
      )
  };
}

/* =========================================================
   HASH
========================================================= */

function fnv1a(
  value
) {
  let hash =
    0x811c9dc5;

  const text =
    String(
      value || ""
    );

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

function shardFor(
  value
) {
  return (
    fnv1a(
      value
    ) & 0xff
  )
    .toString(16)
    .padStart(
      2,
      "0"
    );
}

/* =========================================================
   STREAM ID
========================================================= */

function extractStreamId(
  streamUrl
) {
  try {
    const u =
      new URL(
        streamUrl
      );

    /*
     * /movie/user/pass/12345.mp4
     */
    const parts =
      u.pathname
        .split("/")
        .filter(Boolean);

    const movieIndex =
      parts.findIndex(
        p =>
          p.toLowerCase() ===
          "movie"
      );

    if (
      movieIndex >= 0 &&
      parts[movieIndex + 3]
    ) {
      return parts[
        movieIndex + 3
      ].replace(
        /\.[^.]+$/,
        ""
      );
    }

    /*
     * Fallback: último segmento numérico.
     */
    const last =
      parts.at(-1) || "";

    const numeric =
      last.match(
        /^(\d+)/
      );

    if (
      numeric
    ) {
      return numeric[1];
    }

    /*
     * Último recurso:
     * hash da URL.
     */
    return String(
      fnv1a(
        streamUrl
      )
    );
  } catch (_) {
    return String(
      fnv1a(
        streamUrl
      )
    );
  }
}

/* =========================================================
   YEAR
========================================================= */

function extractYear(
  name
) {
  const match =
    String(
      name || ""
    ).match(
      /\b((?:19|20)\d{2})\b/
    );

  return match
    ? match[1]
    : "";
}

/* =========================================================
   M3U URL VARIANTS
========================================================= */

function makeUrlVariants(
  original
) {
  const variants = [];

  try {
    const originalUrl =
      new URL(
        original
      );

    variants.push(
      originalUrl.toString()
    );

    /*
     * HTTPS
     */
    if (
      originalUrl.protocol ===
      "http:"
    ) {
      const https =
        new URL(
          originalUrl.toString()
        );

      https.protocol =
        "https:";

      variants.push(
        https.toString()
      );
    }

    /*
     * Remove output.
     */
    const noOutput =
      new URL(
        originalUrl.toString()
      );

    noOutput.searchParams.delete(
      "output"
    );

    variants.push(
      noOutput.toString()
    );

    /*
     * MPEGTS.
     */
    const mpegts =
      new URL(
        originalUrl.toString()
      );

    mpegts.searchParams.set(
      "output",
      "mpegts"
    );

    variants.push(
      mpegts.toString()
    );

    /*
     * M3U8.
     */
    const m3u8 =
      new URL(
        originalUrl.toString()
      );

    m3u8.searchParams.set(
      "output",
      "m3u8"
    );

    variants.push(
      m3u8.toString()
    );

    /*
     * TS.
     */
    const ts =
      new URL(
        originalUrl.toString()
      );

    ts.searchParams.set(
      "output",
      "ts"
    );

    variants.push(
      ts.toString()
    );

  } catch (_) {
    variants.push(
      original
    );
  }

  return [
    ...new Set(
      variants
    )
  ];
}

/* =========================================================
   DOWNLOAD
========================================================= */

async function downloadM3U() {
  const variants =
    makeUrlVariants(
      M3U_URL
    );

  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36",
    "VLC/3.0.21 LibVLC/3.0.21",
    "curl/8.5.0"
  ];

  let lastError =
    null;

  for (
    let round = 0;
    round <
      MAX_M3U_RETRIES;
    round++
  ) {
    const url =
      variants[
        round %
          variants.length
      ];

    const userAgent =
      userAgents[
        round %
          userAgents.length
      ];

    console.log(
      `Tentativa ${round + 1}/${MAX_M3U_RETRIES}`
    );

    console.log(
      `Endpoint: ${new URL(url).origin}/get.php`
    );

    try {
      const controller =
        new AbortController();

      const timer =
        setTimeout(
          () =>
            controller.abort(),
          120000
        );

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
                "application/x-mpegURL,audio/x-mpegurl,text/plain,*/*",
              "user-agent":
                userAgent,
              connection:
                "keep-alive"
            },
            signal:
              controller.signal
          }
        );

      clearTimeout(
        timer
      );

      console.log(
        `HTTP ${response.status}`
      );

      if (
        response.ok
      ) {
        const body =
          await response.text();

        if (
          body &&
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
            `M3U recebida: ${body.length} bytes`
          );

          return body;
        }

        console.log(
          `Resposta HTTP ${response.status}, mas não parece M3U.`
        );

        console.log(
          `Início da resposta: ${body.slice(0, 500)}`
        );

        lastError =
          new Error(
            "Resposta não parece uma playlist M3U."
          );
      } else {
        let body =
          "";

        try {
          body =
            await response.text();
        } catch (_) {}

        console.log(
          `Corpo do erro: ${body.slice(0, 1000)}`
        );

        lastError =
          new Error(
            `M3U HTTP ${response.status}: ${body.slice(0, 500)}`
          );
      }
    } catch (error) {
      lastError =
        error;

      console.log(
        `Erro de conexão: ${String(error?.message || error)}`
      );
    }

    if (
      round <
      MAX_M3U_RETRIES - 1
    ) {
      const wait =
        3000 *
        (round + 1);

      console.log(
        `Aguardando ${wait} ms antes da próxima tentativa...`
      );

      await sleep(
        wait
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
   PARSE M3U
========================================================= */

function parseM3U(
  content
) {
  const lines =
    String(
      content || ""
    ).split(
      /\r?\n/
    );

  const entries =
    [];

  let current =
    null;

  let totalLines =
    lines.length;

  let movieCount =
    0;

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {
    const line =
      lines[i].trim();

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
        parseExtInf(
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

    if (
      !current
    ) {
      continue;
    }

    const streamUrl =
      line;

    /*
     * Só filmes.
     */
    if (
      !/\/movie\//i.test(
        streamUrl
      )
    ) {
      current =
        null;

      continue;
    }

    if (
      !current.name
    ) {
      current =
        null;

      continue;
    }

    const id =
      extractStreamId(
        streamUrl
      );

    const quality =
      qualityLabel(
        current.name
      );

    const audio =
      audioLabel(
        current.name
      );

    const normalized =
      normalizeSearch(
        current.name
      );

    const tokens =
      getTokens(
        current.name
      );

    const year =
      extractYear(
        current.name
      );

    const record = {
      i:
        String(id),
      n:
        current.name,
      o:
        current.tvgName ||
        "",
      k:
        normalized,
      z:
        tokens,
      p:
        current.logo ||
        "",
      q:
        quality ||
        "",
      a:
        audio ||
        "",
      e:
        (
          streamUrl.match(
            /\.([a-zA-Z0-9]+)(?:\?|$)/
          )?.[1]
        ) ||
        "mp4",
      y:
        year ||
        "",
      g:
        current.group ||
        ""
    };

    entries.push(
      record
    );

    movieCount++;

    current =
      null;

    if (
      movieCount %
        10000 ===
      0
    ) {
      console.log(
        `Filmes processados: ${movieCount}`
      );
    }
  }

  console.log(
    `Linhas lidas: ${totalLines}`
  );

  console.log(
    `Filmes encontrados: ${movieCount}`
  );

  return entries;
}

/* =========================================================
   BUILD INDEX
========================================================= */

function addToArrayMap(
  map,
  key,
  record
) {
  if (!key) {
    return;
  }

  let arr =
    map[key];

  if (!arr) {
    arr = [];
    map[key] =
      arr;
  }

  arr.push(
    record
  );
}

async function buildIndex(
  entries
) {
  await fs.rm(
    OUTPUT_DIR,
    {
      recursive:
        true,
      force:
        true
    }
  );

  await fs.mkdir(
    SHARDS_DIR,
    {
      recursive:
        true
    }
  );

  /*
   * Inicializa 256 shards.
   *
   * Cada shard contém:
   *
   * p = phrase index
   * t = token index
   * i = ID lookup
   */
  const shards =
    new Map();

  for (
    let i = 0;
    i < 256;
    i++
  ) {
    const shard =
      i.toString(16)
        .padStart(
          2,
          "0"
        );

    shards.set(
      shard,
      {
        p: {},
        t: {},
        i: {}
      }
    );
  }

  const catalog =
    [];

  for (
    let i = 0;
    i < entries.length;
    i++
  ) {
    const record =
      entries[i];

    /*
     * Compact record para o índice.
     */
    const compact = {
      i:
        record.i,
      n:
        record.n,
      o:
        record.o,
      p:
        record.p,
      q:
        record.q,
      a:
        record.a,
      e:
        record.e,
      y:
        record.y
    };

    catalog.push(
      compact
    );

    /*
     * ----------------
     * ID SHARD
     * ----------------
     */
    const idShard =
      shards.get(
        shardFor(
          record.i
        )
      );

    idShard.i[
      record.i
    ] = compact;

    /*
     * ----------------
     * PHRASE
     * ----------------
     */
    if (
      record.k
    ) {
      const phraseShard =
        shards.get(
          shardFor(
            record.k
          )
        );

      addToArrayMap(
        phraseShard.p,
        record.k,
        compact
      );
    }

    /*
     * ----------------
     * TOKENS
     * ----------------
     */
    for (
      const token
      of record.z
    ) {
      const tokenShard =
        shards.get(
          shardFor(
            token
          )
        );

      addToArrayMap(
        tokenShard.t,
        token,
        compact
      );
    }
  }

  /*
   * Deduplica arrays.
   */
  for (
    const [
      shardName,
      shard
    ]
    of shards
  ) {
    for (
      const key
      of Object.keys(
        shard.p
      )
    ) {
      shard.p[key] =
        dedupeCompact(
          shard.p[key]
        );
    }

    for (
      const key
      of Object.keys(
        shard.t
      )
    ) {
      shard.t[key] =
        dedupeCompact(
          shard.t[key]
        );
    }

    await fs.writeFile(
      path.join(
        SHARDS_DIR,
        `${shardName}.json`
      ),
      JSON.stringify(
        shard
      ),
      "utf8"
    );
  }

  /*
   * ----------------
   * CATALOG
   * ----------------
   */

  await fs.writeFile(
    path.join(
      OUTPUT_DIR,
      "catalog.json"
    ),
    JSON.stringify(
      {
        items:
          catalog
            .slice(
              0,
              100
            )
      }
    ),
    "utf8"
  );

  /*
   * ----------------
   * MANIFEST
   * ----------------
   */

  const manifest = {
    version:
      "3.0.0",
    generatedAt:
      new Date().toISOString(),
    totalEntries:
      entries.length,
    shards:
      256,
    source:
      "sventank"
  };

  await fs.writeFile(
    path.join(
      OUTPUT_DIR,
      "manifest.json"
    ),
    JSON.stringify(
      manifest,
      null,
      2
    ),
    "utf8"
  );

  /*
   * Informações extras para debug.
   */
  await fs.writeFile(
    path.join(
      OUTPUT_DIR,
      "build-info.json"
    ),
    JSON.stringify(
      {
        generatedAt:
          new Date().toISOString(),
        totalEntries:
          entries.length,
        sourceHost:
          normalizeBaseUrl(
            M3U_URL
          )
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
    `Total de filmes: ${entries.length}`
  );

  console.log(
    `Diretório: ${OUTPUT_DIR}`
  );

  console.log(
    "========================================"
  );
}

function dedupeCompact(
  records
) {
  const map =
    new Map();

  for (
    const record
    of records
  ) {
    if (
      !record?.i
    ) {
      continue;
    }

    if (
      !map.has(
        record.i
      )
    ) {
      map.set(
        record.i,
        record
      );
    }
  }

  return [
    ...map.values()
  ];
}

/* =========================================================
   MAIN
========================================================= */

console.log(
  "========================================"
);

console.log(
  "Eagle Click Index Builder"
);

console.log(
  "========================================"
);

console.log(
  "Baixando M3U..."
);

const m3u =
  await downloadM3U();

console.log(
  "Processando M3U..."
);

const entries =
  parseM3U(
    m3u
  );

console.log(
  "Construindo índice..."
);

await buildIndex(
  entries
);

console.log(
  "Finalizado."
);
