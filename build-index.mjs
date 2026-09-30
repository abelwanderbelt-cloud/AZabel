import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const M3U_URL = process.env.M3U_URL;
const OUTPUT_DIR = process.env.OUTPUT_DIR || "eagle-index";

if (!M3U_URL) {
  throw new Error("M3U_URL não foi configurada como GitHub Secret.");
}

const MAX_TOKEN_ITEMS = 300;
const SHARD_COUNT = 256;

const STOP_WORDS = new Set([
  "a", "o", "as", "os", "um", "uma", "uns", "umas",
  "de", "da", "do", "das", "dos", "e", "em", "no", "na",
  "nos", "nas", "por", "para", "com", "sem", "the", "an",
  "of", "and", "in", "on", "to", "for", "with", "from"
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
  return (fnv1a(value) & 0xff).toString(16).padStart(2, "0");
}

function parseAttr(line, name) {
  const match = line.match(
    new RegExp(`${name}="([^"]*)"`, "i")
  );
  return match?.[1] || "";
}

function parseExtinf(line) {
  const comma = line.indexOf(",");
  return {
    name:
      (comma >= 0 ? line.slice(comma + 1).trim() : "") ||
      parseAttr(line, "tvg-name") ||
      "Filme",
    poster: parseAttr(line, "tvg-logo"),
    group: parseAttr(line, "group-title")
  };
}

function qualityOf(name) {
  const n = String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (/\b(2160p|2160|4k|uhd)\b/.test(n)) return "4K";
  if (/\b(1080p|1080|fhd)\b/.test(n)) return "1080p";
  if (/\b(720p|720|hd)\b/.test(n)) return "720p";
  if (/\b(480p|480|sd)\b/.test(n)) return "480p";
  return "";
}

function audioOf(name) {
  const n = String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (/\bdual\s*audio\b|\bdual\b/.test(n)) return "Dual Áudio";
  if (/\bdublado\b|\bdub\b|\bpt[- ]?br\b|\bportugues\b/.test(n)) return "Dublado";
  if (/\blegendado\b|\bleg\b|\bsubtitled\b|\bsub\b/.test(n)) return "Legendado";
  if (/\boriginal\b|\benglish\b/.test(n)) return "Original";
  return "";
}

function yearOf(name) {
  const match = String(name || "").match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : "";
}

function extractPathInfo(streamUrl) {
  try {
    const u = new URL(streamUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const file = parts.at(-1) || "";
    const slashIndex = parts.findIndex(x => x.toLowerCase() === "movie");

    if (slashIndex < 0) return null;

    const match = file.match(/^(.+?)\.([^.\/]+)$/);
    if (!match) return null;

    return {
      id: decodeURIComponent(match[1]),
      extension: match[2].toLowerCase()
    };
  } catch (_) {
    return null;
  }
}

function compactRecord(raw) {
  return {
    i: raw.id,
    t: "movie",
    n: raw.name,
    p: raw.poster || "",
    q: raw.quality || "",
    a: raw.audio || "",
    e: raw.extension || "mp4",
    y: raw.year || ""
  };
}

function addToMapOfArrays(map, key, record, limit = Infinity) {
  if (!key) return;
  let array = map.get(key);
  if (!array) {
    array = [];
    map.set(key, array);
  }

  if (!array.some(x => x.i === record.i)) {
    if (array.length < limit) array.push(record);
  }
}

console.log("Baixando M3U...");

const response = await fetch(M3U_URL, {
  headers: {
    accept: "audio/x-mpegurl,text/plain,*/*",
    "user-agent": "Eagle-Click-Index/3.0"
  }
});

if (!response.ok) {
  throw new Error(`M3U HTTP ${response.status}`);
}

const playlist = await response.text();
console.log(`M3U recebida: ${(playlist.length / 1024 / 1024).toFixed(1)} MB`);

await rm(OUTPUT_DIR, { recursive: true, force: true });
await mkdir(join(OUTPUT_DIR, "shards"), { recursive: true });

const phraseMaps = Array.from({ length: SHARD_COUNT }, () => new Map());
const tokenMaps = Array.from({ length: SHARD_COUNT }, () => new Map());
const idMaps = Array.from({ length: SHARD_COUNT }, () => new Map());

const catalog = [];
const seenIds = new Set();

let current = null;
let total = 0;
let movies = 0;

const lines = playlist.split(/\r?\n/);

for (const rawLine of lines) {
  const line = rawLine.trim();
  if (!line) continue;

  if (line.toUpperCase().startsWith("#EXTINF:")) {
    current = parseExtinf(line);
    continue;
  }

  if (line.startsWith("#")) continue;
  if (!current) continue;

  const pathInfo = extractPathInfo(line);
  if (!pathInfo) {
    current = null;
    continue;
  }

  const name = current.name || "Filme";
  const key = normalizeCore(name);
  if (!key) {
    current = null;
    continue;
  }

  const record = compactRecord({
    id: pathInfo.id,
    name,
    poster: current.poster,
    quality: qualityOf(name),
    audio: audioOf(name),
    extension: pathInfo.extension,
    year: yearOf(name)
  });

  total++;
  movies++;

  if (seenIds.has(record.i)) {
    current = null;
    continue;
  }

  seenIds.add(record.i);

  const phraseShard = fnv1a(key) & 0xff;
  addToMapOfArrays(
    phraseMaps[phraseShard],
    key,
    record
  );

  const tokens = key
    .split(" ")
    .filter(x => x && x.length >= 3 && !STOP_WORDS.has(x));

  for (const token of new Set(tokens)) {
    const tokenShard = fnv1a(token) & 0xff;
    addToMapOfArrays(
      tokenMaps[tokenShard],
      token,
      record,
      MAX_TOKEN_ITEMS
    );
  }

  const idShard = fnv1a(record.i) & 0xff;
  idMaps[idShard].set(record.i, record);

  if (catalog.length < 100) {
    catalog.push(record);
  }

  current = null;
}

function sortRecordList(a, b) {
  const qa = a.q === "4K" ? 4 : a.q === "1080p" ? 3 : a.q === "720p" ? 2 : 1;
  const qb = b.q === "4K" ? 4 : b.q === "1080p" ? 3 : b.q === "720p" ? 2 : 1;
  if (qa !== qb) return qb - qa;
  return String(a.n).localeCompare(String(b.n), "pt-BR");
}

for (let shardIndex = 0; shardIndex < SHARD_COUNT; shardIndex++) {
  const p = {};
  const t = {};
  const i = {};

  for (const [key, list] of phraseMaps[shardIndex]) {
    p[key] = list.sort(sortRecordList);
  }

  for (const [key, list] of tokenMaps[shardIndex]) {
    t[key] = list.sort(sortRecordList);
  }

  for (const [key, record] of idMaps[shardIndex]) {
    i[key] = record;
  }

  const content = JSON.stringify({ p, t, i });
  await writeFile(
    join(OUTPUT_DIR, "shards", `${shardIndex.toString(16).padStart(2, "0")}.json`),
    content
  );
}

await writeFile(
  join(OUTPUT_DIR, "manifest.json"),
  JSON.stringify(
    {
      version: "3.0.0",
      generatedAt: new Date().toISOString(),
      totalEntries: total,
      movies,
      shardCount: SHARD_COUNT,
      format: "eagle-click-index-v1"
    },
    null,
    2
  )
);

await writeFile(
  join(OUTPUT_DIR, "catalog.json"),
  JSON.stringify({
    version: "3.0.0",
    generatedAt: new Date().toISOString(),
    items: catalog
  })
);

console.log(`Itens VOD processados: ${total}`);
console.log(`IDs únicos: ${seenIds.size}`);
console.log(`Shards escritos: ${SHARD_COUNT}`);
