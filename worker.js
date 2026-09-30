const VERSION = "3.0.0";

/*
 * Eagle Click 3.0.0
 *
 * BUSCA:
 * - Não varre a lista IPTV no Worker.
 * - Consulta somente 1 shard pequeno do índice por busca exata.
 * - Usa shards de tokens como fallback para buscas parciais.
 * - Só traduz quando a busca direta não encontra nada.
 * - Filtros 4K/1080p/720p/480p + Dublado/Dual/Legendado/Original.
 *
 * O índice é gerado pelo GitHub Actions e publicado no repositório.
 * O Worker Free só faz operações pequenas.
 */

const INDEX_BASE =
  "https://raw.githubusercontent.com/abelwanderbelt-cloud/AZabel/main/eagle-index";

const LOGIN_SOURCE =
  "https://raw.githubusercontent.com/dregs1/dregs1.github.io/refs/heads/main/xml/topfilms.xml";

const INDEX_TIMEOUT = 5000;
const LOGIN_TIMEOUT = 5000;
const TRANSLATE_TIMEOUT = 5000;
const INFO_TIMEOUT = 5000;
const MAX_RESULTS = 100;
const MAX_TOKEN_REQUESTS = 3;

let credentialsCache = null;

/* =========================================================
   RESPONSE
========================================================= */

function json(data, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": cache
    }
  });
}

/* =========================================================
   STRING / NORMALIZAÇÃO
========================================================= */

const STOP_WORDS = new Set([
  "a", "o", "as", "os", "um", "uma", "uns", "umas",
  "de", "da", "do", "das", "dos", "e", "em", "no", "na",
  "nos", "nas", "por", "para", "com", "sem", "the", "a",
  "an", "of", "and", "in", "on", "to", "for", "with", "from"
]);

function normalizeCore(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\((?:[^)]*(?:2160p|1080p|720p|480p|4k|uhd|fhd|hd|sd|dublado|dub|dual|legendado|leg|sub|pt[- ]?br|original)[^)]*)\)/gi, " ")
    .replace(/\b(2160p|2160|4k|uhd|1080p|1080|fhd|720p|720|hd|480p|480|sd)\b/gi, " ")
    .replace(/\b(dual\s*audio|dual|dublado|dub|legendado|leg|subtitled|sub|pt[- ]?br|portugu(?:e|ê)s|original|english)\b/gi, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function queryInfo(text) {
  const raw = String(text || "");
  const n = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  let quality = "";
  if (/\b(2160p|2160|4k|uhd)\b/.test(n)) quality = "4K";
  else if (/\b(1080p|1080|fhd)\b/.test(n)) quality = "1080p";
  else if (/\b(720p|720|hd)\b/.test(n)) quality = "720p";
  else if (/\b(480p|480|sd)\b/.test(n)) quality = "480p";

  let audio = "";
  if (/\bdual\s*audio\b|\bdual\b/.test(n)) audio = "Dual Áudio";
  else if (/\bdublado\b|\bdub\b|\bpt[- ]?br\b|\bportugu(?:e|ê)s\b/.test(n)) audio = "Dublado";
  else if (/\blegendado\b|\bleg\b|\bsubtitled\b|\bsub\b/.test(n)) audio = "Legendado";
  else if (/\boriginal\b|\benglish\b/.test(n)) audio = "Original";

  return {
    key: normalizeCore(raw),
    quality,
    audio,
    tokens: normalizeCore(raw)
      .split(" ")
      .filter(x => x && !STOP_WORDS.has(x) && x.length >= 3)
  };
}

function displayLabels(item) {
  const labels = [];
  if (item?.q) labels.push(item.q);
  if (item?.a) labels.push(item.a);
  return labels;
}

/* =========================================================
   HASH / SHARD
========================================================= */

function fnv1a(value) {
  let hash = 0x811c9dc5;
  const s = String(value || "");

  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function shardFor(value) {
  return (fnv1a(value) & 0xff)
    .toString(16)
    .padStart(2, "0");
}

/* =========================================================
   FETCH
========================================================= */

async function fetchTimeout(url, timeout, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      redirect: "follow",
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   CREDENTIALS
========================================================= */

function parseCredentials(xml) {
  const urls = String(xml || "").match(/https?:\/\/[^\s"'<>]+/gi) || [];

  for (const raw of urls) {
    try {
      const u = new URL(raw.replace(/&amp;/gi, "&"));
      const username =
        u.searchParams.get("username") ||
        u.searchParams.get("user");
      const password =
        u.searchParams.get("password") ||
        u.searchParams.get("pass");

      if (username && password) {
        return {
          username,
          password,
          base: u.origin
        };
      }
    } catch (_) {}
  }

  throw new Error("Credenciais não encontradas");
}

async function getCredentials() {
  if (credentialsCache) return credentialsCache;

  const response = await fetchTimeout(
    LOGIN_SOURCE,
    LOGIN_TIMEOUT,
    {
      headers: {
        accept: "text/plain, application/xml, */*"
      }
    }
  );

  if (!response.ok) {
    throw new Error(`LOGIN_SOURCE HTTP ${response.status}`);
  }

  credentialsCache = parseCredentials(await response.text());
  return credentialsCache;
}

/* =========================================================
   INDEX
========================================================= */

async function fetchShard(shard) {
  const url = `${INDEX_BASE}/shards/${shard}.json`;

  const response = await fetchTimeout(
    url,
    INDEX_TIMEOUT,
    {
      headers: {
        accept: "application/json"
      },
      cf: {
        cacheTtl: 300,
        cacheEverything: true
      }
    }
  );

  if (!response.ok) {
    return null;
  }

  return await response.json();
}

function compactRecord(record) {
  return {
    id: String(record.i || ""),
    type: record.t || "movie",
    name: String(record.n || ""),
    poster: String(record.p || ""),
    quality: String(record.q || ""),
    audio: String(record.a || ""),
    extension: String(record.e || "mp4"),
    year: record.y || ""
  };
}

function recordMatchesFilters(record, info) {
  if (info.quality && record.q !== info.quality) return false;
  if (info.audio && record.a !== info.audio) return false;
  return true;
}

function scoreRecord(record, queryInfoValue, exact = false) {
  let score = exact ? 1000 : 500;

  if (queryInfoValue.quality === record.q) score += 20;
  if (queryInfoValue.audio === record.a) score += 20;

  return score;
}

function dedupeAndFilter(records, info, exact = false) {
  const map = new Map();

  for (const raw of records || []) {
    const record = compactRecord(raw);
    if (!record.id || !record.name) continue;
    if (!recordMatchesFilters(raw, info)) continue;

    const old = map.get(record.id);
    const score = scoreRecord(raw, info, exact);

    if (!old || score > old._score) {
      map.set(record.id, {
        ...record,
        _score: score
      });
    }
  }

  return [...map.values()]
    .sort((a, b) => b._score - a._score)
    .slice(0, MAX_RESULTS)
    .map(({ _score, ...record }) => record);
}

async function phraseLookup(query, info) {
  if (!info.key) return [];

  const shard = await fetchShard(shardFor(info.key));
  if (!shard?.p) return [];

  return dedupeAndFilter(
    shard.p[info.key] || [],
    info,
    true
  );
}

async function tokenLookup(query, info) {
  const tokens = info.tokens.slice(0, MAX_TOKEN_REQUESTS);
  if (!tokens.length) return [];

  const shardNames = [...new Set(tokens.map(shardFor))];
  const shards = await Promise.all(
    shardNames.map(fetchShard)
  );

  const lists = [];

  for (const token of tokens) {
    const shard = shards[shardNames.indexOf(shardFor(token))];
    const list = shard?.t?.[token];
    if (Array.isArray(list)) lists.push(list);
  }

  if (!lists.length) return [];

  /*
   * Para consultas com vários termos, prioriza itens que aparecem
   * em todos os índices de token. Para uma palavra, usa diretamente.
   */
  const counts = new Map();

  for (const list of lists) {
    const seen = new Set();
    for (const raw of list) {
      const id = String(raw?.i || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }

  const wanted = Math.min(tokens.length, lists.length);
  const candidates = [];

  for (const list of lists) {
    for (const raw of list) {
      const id = String(raw?.i || "");
      if (!id) continue;
      if ((counts.get(id) || 0) < wanted) continue;
      candidates.push(raw);
    }
  }

  return dedupeAndFilter(candidates, info, false);
}

async function searchIndex(query) {
  const info = queryInfo(query);

  let results = await phraseLookup(query, info);
  if (results.length) return { results, info, translated: false };

  results = await tokenLookup(query, info);
  if (results.length) return { results, info, translated: false };

  return { results: [], info, translated: false };
}

/* =========================================================
   TRANSLATION
========================================================= */

async function translate(text, target) {
  const url = new URL(
    "https://translate.googleapis.com/translate_a/single"
  );

  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", target);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  try {
    const response = await fetchTimeout(
      url.toString(),
      TRANSLATE_TIMEOUT,
      {
        headers: {
          accept: "application/json"
        }
      }
    );

    if (!response.ok) return "";

    const data = await response.json();

    return Array.isArray(data?.[0])
      ? data[0].map(x => x?.[0] || "").join("").trim()
      : "";
  } catch (_) {
    return "";
  }
}

async function searchWithTranslation(query) {
  const direct = await searchIndex(query);
  if (direct.results.length) return direct;

  const translated = await Promise.allSettled([
    translate(query, "en"),
    translate(query, "pt")
  ]);

  const queries = [query];

  for (const item of translated) {
    if (item.status !== "fulfilled") continue;
    const value = String(item.value || "").trim();
    if (!value) continue;

    if (
      !queries.some(
        q => normalizeCore(q) === normalizeCore(value)
      )
    ) {
      queries.push(value);
    }
  }

  for (const translatedQuery of queries.slice(1)) {
    const result = await searchIndex(translatedQuery);
    if (result.results.length) {
      return {
        ...result,
        translated: true,
        queries
      };
    }
  }

  return {
    ...direct,
    translated: true,
    queries
  };
}

/* =========================================================
   META / STREAM
========================================================= */

async function findItemById(id) {
  const shard = await fetchShard(shardFor(id));
  return shard?.i?.[id] || null;
}

function movieStreamUrl(credentials, record) {
  return `${credentials.base}/movie/${encodeURIComponent(credentials.username)}/${encodeURIComponent(credentials.password)}/${encodeURIComponent(record.id)}.${record.e}`;
}

async function optionalVodInfo(credentials, id) {
  try {
    const url = new URL("/player_api.php", credentials.base);
    url.searchParams.set("username", credentials.username);
    url.searchParams.set("password", credentials.password);
    url.searchParams.set("action", "get_vod_info");
    url.searchParams.set("vod_id", id);

    const response = await fetchTimeout(
      url.toString(),
      INFO_TIMEOUT,
      {
        headers: {
          accept: "application/json"
        }
      }
    );

    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  }
}

/* =========================================================
   SERIES FALLBACK
========================================================= */

async function searchSeriesApi(
  credentials,
  query
) {
  try {
    const url = new URL("/player_api.php", credentials.base);
    url.searchParams.set("username", credentials.username);
    url.searchParams.set("password", credentials.password);
    url.searchParams.set("action", "get_series");

    const response = await fetchTimeout(
      url.toString(),
      INFO_TIMEOUT,
      {
        headers: {
          accept: "application/json"
        }
      }
    );

    if (!response.ok) return [];

    const data = await response.json();
    if (!Array.isArray(data)) return [];

    const q = normalizeCore(query);
    return data
      .filter(item => {
        const name = normalizeCore(
          item.name || item.title || ""
        );
        return name === q || name.includes(q) || q.includes(name);
      })
      .slice(0, MAX_RESULTS);
  } catch (_) {
    return [];
  }
}

/* =========================================================
   MANIFEST
========================================================= */

const MANIFEST = {
  id: "org.eagleclick.addon",
  version: VERSION,
  name: "Eagle Click",
  description: "Catálogo Eagle Click para Stremio/Nuvio.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: [
    "eagleclick-movie-",
    "eagleclick-series-",
    "eagleclick-episode-"
  ],
  catalogs: [
    {
      type: "movie",
      id: "eagleclick_movies",
      name: "Eagle Click — Filmes",
      extra: [
        { name: "search", isRequired: false }
      ]
    },
    {
      type: "series",
      id: "eagleclick_series",
      name: "Eagle Click — Séries",
      extra: [
        { name: "search", isRequired: false }
      ]
    }
  ]
};

/* =========================================================
   ROUTES
========================================================= */

function getCatalogSearch(url) {
  const direct =
    url.searchParams.get("search") ||
    url.searchParams.get("q");

  if (direct) return direct.trim();

  const match = url.pathname.match(
    /search=([^/]+?)(?:\.json)?$/i
  );

  if (!match) return "";

  try {
    return decodeURIComponent(match[1]).trim();
  } catch (_) {
    return match[1].trim();
  }
}

/* =========================================================
   CATALOG
========================================================= */

async function handleCatalog(url, type) {
  const search = getCatalogSearch(url);
  const credentials = await getCredentials();

  if (type === "movie" && search) {
    const result = await searchWithTranslation(search);

    return json({
      metas: result.results.map(record => ({
        id: `eagleclick-movie-${record.id}`,
        type: "movie",
        name:
          record.year && !/\b\d{4}\b/.test(record.name)
            ? `${record.name} (${record.year})`
            : record.name,
        poster: record.poster || undefined,
        releaseInfo: record.year || undefined
      })),
      cacheMaxAge: result.results.length ? 900 : 300,
      staleRevalidate: 1800,
      eagle: {
        version: VERSION,
        source: "static-index",
        query: search,
        queries: result.queries || [search],
        translated: Boolean(result.translated),
        results: result.results.length
      }
    });
  }

  if (type === "series" && search) {
    const series = await searchSeriesApi(credentials, search);

    return json({
      metas: series.map(item => ({
        id: `eagleclick-series-${item.series_id || item.id}`,
        type: "series",
        name: item.name || item.title || "Série",
        poster: item.cover || item.cover_big || item.stream_icon || undefined
      })),
      cacheMaxAge: 600,
      staleRevalidate: 1800
    });
  }

  /* Home de filmes: arquivo leve gerado pelo indexador. */
  if (type === "movie") {
    try {
      const response = await fetchTimeout(
        `${INDEX_BASE}/catalog.json`,
        INDEX_TIMEOUT,
        {
          headers: { accept: "application/json" },
          cf: { cacheTtl: 300, cacheEverything: true }
        }
      );

      if (response.ok) {
        const data = await response.json();
        return json({
          metas: Array.isArray(data?.items)
            ? data.items.map(record => ({
                id: `eagleclick-movie-${record.id}`,
                type: "movie",
                name: record.name,
                poster: record.poster || undefined,
                releaseInfo: record.year || undefined
              }))
            : [],
          cacheMaxAge: 900,
          staleRevalidate: 1800
        });
      }
    } catch (_) {}

    return json({ metas: [] });
  }

  if (type === "series") {
    const series = await searchSeriesApi(credentials, "");

    return json({
      metas: series.slice(0, 100).map(item => ({
        id: `eagleclick-series-${item.series_id || item.id}`,
        type: "series",
        name: item.name || item.title || "Série",
        poster: item.cover || item.cover_big || item.stream_icon || undefined
      })),
      cacheMaxAge: 600,
      staleRevalidate: 1800
    });
  }

  return json({ metas: [] });
}

/* =========================================================
   META
========================================================= */

async function handleMeta(type, id) {
  const cleanId = String(id || "");

  if (type === "movie") {
    const streamId = cleanId.replace(
      /^eagleclick-movie-/,
      ""
    );

    const record = await findItemById(streamId);

    if (!record) {
      return json({ meta: null });
    }

    /*
     * O índice já contém poster/nome. O VOD info é opcional:
     * só tentamos para conseguir sinopse quando o servidor aceita.
     */
    let info = null;

    try {
      const credentials = await getCredentials();
      info = await optionalVodInfo(
        credentials,
        streamId
      );
    } catch (_) {}

    const vodInfo = info?.info || {};

    return json({
      meta: {
        id: `eagleclick-movie-${streamId}`,
        type: "movie",
        name:
          vodInfo.name ||
          record.name,
        poster:
          vodInfo.movie_image ||
          vodInfo.cover_big ||
          record.poster ||
          undefined,
        background:
          Array.isArray(vodInfo.backdrop_path)
            ? vodInfo.backdrop_path[0]
            : vodInfo.backdrop_path ||
              record.poster ||
              undefined,
        description:
          vodInfo.plot ||
          vodInfo.description ||
          undefined,
        releaseInfo:
          record.year ||
          undefined
      }
    });
  }

  if (type === "series") {
    const seriesId = cleanId.replace(
      /^eagleclick-series-/,
      ""
    );

    const credentials = await getCredentials();
    const url = new URL(
      "/player_api.php",
      credentials.base
    );

    url.searchParams.set("username", credentials.username);
    url.searchParams.set("password", credentials.password);
    url.searchParams.set("action", "get_series_info");
    url.searchParams.set("series_id", seriesId);

    try {
      const response = await fetchTimeout(
        url.toString(),
        INFO_TIMEOUT,
        { headers: { accept: "application/json" } }
      );

      if (response.ok) {
        const data = await response.json();
        const info = data?.info || {};

        return json({
          meta: {
            id: `eagleclick-series-${seriesId}`,
            type: "series",
            name: info.name || `Série ${seriesId}`,
            poster: info.cover || info.cover_big || undefined,
            background: Array.isArray(info.backdrop_path)
              ? info.backdrop_path[0]
              : info.backdrop_path || undefined,
            description: info.plot || info.description || undefined
          }
        });
      }
    } catch (_) {}
  }

  return json({ meta: null });
}

/* =========================================================
   STREAM
========================================================= */

async function handleStream(type, id) {
  const credentials = await getCredentials();

  if (type === "movie") {
    const streamId = String(id || "").replace(
      /^eagleclick-movie-/,
      ""
    );

    const record = await findItemById(streamId);
    if (!record) return json({ streams: [] });

    const labels = displayLabels(record);

    return json({
      streams: [
        {
          name: "Eagle Click",
          title:
            labels.length
              ? `${record.name} • ${labels.join(" • ")}`
              : record.name,
          url: movieStreamUrl(
            credentials,
            record
          )
        }
      ]
    });
  }

  if (type === "series") {
    const episodeId = String(id || "")
      .replace(/^eagleclick-episode-/i, "")
      .replace(/^eagleclick-series-/i, "");

    return json({
      streams: [
        {
          name: "Eagle Click",
          title: `Episódio ${episodeId}`,
          url:
            `${credentials.base}/series/${encodeURIComponent(credentials.username)}/${encodeURIComponent(credentials.password)}/${encodeURIComponent(episodeId)}.mp4`
        }
      ]
    });
  }

  return json({ streams: [] });
}

/* =========================================================
   DEBUG
========================================================= */

async function debugSearch(url) {
  const query =
    url.searchParams.get("q") ||
    url.searchParams.get("search") ||
    "";

  if (!query) {
    return json({
      version: VERSION,
      ok: false,
      error: "Use /debug/search?q=The%20Substance"
    });
  }

  const result = await searchWithTranslation(query);

  return json({
    version: VERSION,
    ok: true,
    indexBase: INDEX_BASE,
    query,
    queries: result.queries || [query],
    translated: Boolean(result.translated),
    results: result.results.map(record => ({
      id: record.id,
      name: record.name,
      quality: record.quality,
      audio: record.audio,
      poster: record.poster,
      year: record.year
    }))
  });
}

async function debugIndex() {
  try {
    const response = await fetchTimeout(
      `${INDEX_BASE}/manifest.json`,
      INDEX_TIMEOUT,
      {
        headers: { accept: "application/json" },
        cf: { cacheTtl: 300, cacheEverything: true }
      }
    );

    if (!response.ok) {
      return json({
        version: VERSION,
        ok: false,
        status: response.status,
        indexBase: INDEX_BASE
      });
    }

    return json({
      version: VERSION,
      ok: true,
      index: await response.json()
    });
  } catch (error) {
    return json({
      version: VERSION,
      ok: false,
      error: String(error?.message || error)
    });
  }
}

/* =========================================================
   MAIN ROUTER
========================================================= */

export default {
  async fetch(request) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, OPTIONS"
          }
        });
      }

      const url = new URL(request.url);
      const pathname = url.pathname.replace(/\/+/g, "/").toLowerCase();

      /* Manifest */
      if (
        pathname === "/" ||
        pathname.endsWith("/manifest.json")
      ) {
        return json(MANIFEST, 200, "public, max-age=300");
      }

      /* Debug */
      if (pathname.includes("/debug/search")) {
        return debugSearch(url);
      }

      if (pathname.includes("/debug/index")) {
        return debugIndex();
      }

      /* Catalog */
      const catalogMatch = pathname.match(
        /\/catalog\/(movie|series)\//i
      );

      if (catalogMatch) {
        return handleCatalog(
          url,
          catalogMatch[1].toLowerCase()
        );
      }

      /* Meta */
      const metaMatch = pathname.match(
        /\/meta\/(movie|series)\/(.+?)(?:\.json)?$/i
      );

      if (metaMatch) {
        return handleMeta(
          metaMatch[1].toLowerCase(),
          decodeURIComponent(metaMatch[2])
        );
      }

      /* Stream */
      const streamMatch = pathname.match(
        /\/stream\/(movie|series)\/(.+?)(?:\.json)?$/i
      );

      if (streamMatch) {
        return handleStream(
          streamMatch[1].toLowerCase(),
          decodeURIComponent(streamMatch[2])
        );
      }

      return json(
        {
          error: "Eagle Click: rota não encontrada",
          version: VERSION,
          path: url.pathname
        },
        404
      );
    } catch (error) {
      return json(
        {
          error: "Eagle Click error",
          detail: String(error?.message || error),
          version: VERSION
        },
        500
      );
    }
  }
};
