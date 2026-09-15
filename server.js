const express = require('express');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Cache-Control','no-store');
  if(req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36';
const TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT_MS || 12000);

// Providers VOD mantidos da v4.
const PROVIDERS = [
  {
    key:'super', name:'OnePlay • SuperStream', types:['movie','series'],
    root:'https://da5f663b4690-superstream.baby-beamup.club', mode:'any'
  },
  {
    key:'cotonet', name:'OnePlay • Cotonet', types:['movie'],
    root:'https://cotonetnet-cotonet.hf.space', mode:'imdb'
  }
];

// Fonte M3U usada pelo OnePlay Matrix 3.4.1.
const LIVE_MASTER = process.env.LIVE_MASTER_URL || 'https://oneplayhd.com/listas_oneplay/master.txt';
const LIVE_CACHE_MS = Number(process.env.LIVE_CACHE_MS || 10 * 60 * 1000);
const MAX_LISTS = Number(process.env.LIVE_MAX_LISTS || 40);
const MAX_CHANNELS = Number(process.env.LIVE_MAX_CHANNELS || 2500);

const manifest = {
  id: 'com.azabel.oneplay.bridge',
  version: '4.1.0',
  name: 'OnePlay • Azabel',
  description: 'Bridge do OnePlay para Stremio/Nuvio: SuperStream + Cotonet e canais M3U.',
  resources: [
    {name:'stream', types:['movie','series','channel'], idPrefixes:['tt','tmdb:','live:']},
    {name:'catalog', types:['channel']},
    {name:'meta', types:['channel'], idPrefixes:['live:']}
  ],
  types: ['movie','series','channel'],
  idPrefixes: ['tt','tmdb:','live:'],
  catalogs: [{ type:'channel', id:'oneplay-live', name:'OnePlay • Canais ao vivo' }],
  behaviorHints: { configurable:false }
};

function safeText(v){ return String(v ?? '').trim(); }
function isImdb(v){ return /^tt\d{5,}$/i.test(v); }
function isTmdb(v){ return /^tmdb:\d+$/i.test(v); }

function parseStremioId(type, rawId){
  const id = safeText(rawId);
  if(type === 'movie') return {base:id, season:null, episode:null};
  if(type !== 'series') return {base:id, season:null, episode:null};
  const m = id.match(/^(.*):(\d+):(\d+)$/);
  if(!m) return {base:id, season:null, episode:null};
  return {base:m[1], season:Number(m[2]), episode:Number(m[3])};
}

async function fetchWithTimeout(url, opts={}){
  const ctl = new AbortController();
  const timer = setTimeout(()=>ctl.abort(), TIMEOUT);
  try{
    return await fetch(url, {
      redirect:'follow',
      ...opts,
      signal:ctl.signal,
      headers:{'User-Agent':UA,'Accept':'*/*',...(opts.headers||{})}
    });
  } finally { clearTimeout(timer); }
}

function providerUrl(p, type, parsed){
  if(!p.types.includes(type)) return null;
  const base = parsed.base;
  if(p.mode === 'imdb' && !isImdb(base)) return null;
  if(p.mode === 'any' && !(isImdb(base) || /^\d+$/.test(base) || isTmdb(base))) return null;
  let ident = base;
  if(p.key === 'super' && isTmdb(base)) ident = base.slice(5);
  if(type === 'movie') return `${p.root}/stream/movie/${encodeURIComponent(ident)}.json`;
  if(parsed.season == null || parsed.episode == null) return null;
  return `${p.root}/stream/series/${encodeURIComponent(ident)}:${parsed.season}:${parsed.episode}.json`;
}

function streamKey(s){
  if(s.url) return 'url:'+s.url;
  if(s.infoHash) return 'bt:'+safeText(s.infoHash).toLowerCase()+':'+safeText(s.fileIdx);
  if(s.externalUrl) return 'ext:'+s.externalUrl;
  return JSON.stringify(s);
}

function normalizeProviderStream(raw, provider, idx){
  if(!raw || typeof raw !== 'object') return null;
  const s = {...raw};
  const originalName = safeText(raw.name);
  const originalTitle = safeText(raw.title || raw.description);
  s.name = originalName ? `${provider.name}\n${originalName}` : provider.name;
  s.title = originalTitle || `${provider.name} • Fonte ${idx+1}`;
  if(!s.url && !s.infoHash && !s.externalUrl) return null;
  return s;
}

async function queryProvider(provider, type, parsed){
  const url = providerUrl(provider,type,parsed);
  if(!url) return {provider:provider.key, ok:false, streams:[], reason:'id/tipo incompatível'};
  try{
    const r = await fetchWithTimeout(url,{headers:{Accept:'application/json'}});
    if(!r.ok) return {provider:provider.key,ok:false,streams:[],reason:`HTTP ${r.status}`};
    const data = await r.json();
    const arr = Array.isArray(data?.streams) ? data.streams : [];
    const streams = arr.slice(0,32).map((x,i)=>normalizeProviderStream(x,provider,i)).filter(Boolean);
    return {provider:provider.key,ok:true,streams};
  }catch(e){
    return {provider:provider.key,ok:false,streams:[],reason:e?.name || 'erro'};
  }
}

async function aggregateStreams(type, rawId){
  const parsed = parseStremioId(type,rawId);
  const results = await Promise.all(PROVIDERS.map(p=>queryProvider(p,type,parsed)));
  const out=[]; const seen=new Set();
  for(const result of results){
    for(const s of result.streams){
      const key=streamKey(s);
      if(seen.has(key)) continue;
      seen.add(key); out.push(s);
    }
  }
  return {streams:out, diagnostics:results.map(x=>({provider:x.provider,ok:x.ok,count:x.streams.length,reason:x.reason||''}))};
}

// ---------------- TV AO VIVO via master.txt -> M3U ----------------
let liveCache = { at:0, lists:[], channels:[], byId:new Map(), errors:[] };

function attr(line, name){
  const re = new RegExp(`${name}="([^"]*)"`, 'i');
  const m = line.match(re);
  return m ? safeText(m[1]) : '';
}

function stableLiveId(group, name, streamUrl){
  const raw = `${group}\x1f${name}\x1f${streamUrl}`;
  return 'live:' + crypto.createHash('sha256').update(raw).digest('base64url').slice(0,24);
}

function splitKodiHeaders(raw){
  const line = safeText(raw);
  const pos = line.indexOf('|');
  if(pos < 0) return {url:line, headers:{}};
  const url = line.slice(0,pos);
  const query = line.slice(pos+1);
  const headers = {};
  for(const part of query.split('&')){
    const eq = part.indexOf('=');
    if(eq < 1) continue;
    let k = part.slice(0,eq), v = part.slice(eq+1);
    try{k=decodeURIComponent(k)}catch{}
    try{v=decodeURIComponent(v)}catch{}
    if(k && v) headers[k]=v;
  }
  return {url,headers};
}

function parseM3U(text, sourceUrl){
  const out=[];
  let current=null;
  for(const raw of String(text||'').split(/\r?\n/)){
    const line=raw.trim();
    if(!line) continue;
    if(line.startsWith('#EXTINF')){
      const comma=line.lastIndexOf(',');
      const name=safeText(comma>=0 ? line.slice(comma+1) : '') || attr(line,'tvg-name') || 'Canal';
      current={
        name,
        group:attr(line,'group-title') || 'Outros',
        logo:attr(line,'tvg-logo'),
        tvgId:attr(line,'tvg-id'),
        tvgName:attr(line,'tvg-name') || name,
        sourceUrl
      };
      continue;
    }
    if(current && /^https?:\/\//i.test(line)){
      const {url,headers}=splitKodiHeaders(line);
      if(url){
        current.streamUrl=url;
        current.headers=headers;
        current.id=stableLiveId(current.group,current.tvgId || current.tvgName || current.name,line);
        out.push(current);
      }
      current=null;
    }
  }
  return out;
}

async function fetchText(url){
  const r=await fetchWithTimeout(url,{headers:{Accept:'text/plain,application/x-mpegURL,application/vnd.apple.mpegurl,*/*'}});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

async function refreshLive(force=false){
  if(!force && liveCache.channels.length && Date.now()-liveCache.at < LIVE_CACHE_MS) return liveCache;
  const errors=[];
  let lists=[];
  try{
    const master = await fetchText(LIVE_MASTER);
    lists = master.split(/\r?\n/).map(x=>x.trim()).filter(x=>/^https?:\/\//i.test(x));
    lists = [...new Set(lists)].slice(0,MAX_LISTS);
  }catch(e){
    errors.push(`master: ${e.message}`);
    if(liveCache.channels.length) return liveCache;
    liveCache={at:Date.now(),lists:[],channels:[],byId:new Map(),errors};
    return liveCache;
  }

  const results = await Promise.allSettled(lists.map(async url=>({url,text:await fetchText(url)})));
  const channels=[];
  for(const r of results){
    if(r.status==='fulfilled'){
      channels.push(...parseM3U(r.value.text,r.value.url));
      if(channels.length>=MAX_CHANNELS) break;
    }else{
      errors.push(safeText(r.reason?.message || r.reason || 'erro M3U'));
    }
  }

  const dedup=[]; const seen=new Set();
  for(const ch of channels.slice(0,MAX_CHANNELS)){
    const key=`${ch.name}|${ch.streamUrl}`;
    if(seen.has(key)) continue;
    seen.add(key); dedup.push(ch);
  }
  const byId=new Map(dedup.map(ch=>[ch.id,ch]));
  liveCache={at:Date.now(),lists,channels:dedup,byId,errors};
  return liveCache;
}

function channelMeta(ch){
  return {
    id:ch.id,
    type:'channel',
    name:ch.name,
    poster:ch.logo || undefined,
    posterShape:'square',
    description:`Canal ao vivo • ${ch.group}`,
    genres:[ch.group],
    behaviorHints:{defaultVideoId:ch.id}
  };
}

app.get('/',(_req,res)=>res.type('html').send(`
<h2>OnePlay • Azabel v4.1 online</h2>
<p><a href="/manifest.json">manifest.json</a></p>
<p><a href="/health">health</a></p>
<p><a href="/debug/live">debug live</a></p>`));

app.get('/health',async (_req,res)=>{
  res.json({ok:true,version:'4.1.0',providers:PROVIDERS.map(p=>p.key),liveMaster:LIVE_MASTER});
});
app.get('/manifest.json',(_req,res)=>res.json(manifest));

app.get('/stream/:type/:id.json',async (req,res)=>{
  const {type,id}=req.params;

  if(type==='channel' && id.startsWith('live:')){
    const live=await refreshLive(false);
    const ch=live.byId.get(id);
    if(!ch) return res.json({streams:[]});
    const behaviorHints={notWebReady:true};
    if(ch.headers && Object.keys(ch.headers).length){
      behaviorHints.proxyHeaders={request:ch.headers};
    }
    return res.json({streams:[{
      name:'OnePlay • Ao vivo',
      title:`${ch.name} • ${ch.group}`,
      url:ch.streamUrl,
      behaviorHints
    }]});
  }

  if(type==='movie'||type==='series'){
    const data=await aggregateStreams(type,id);
    console.log(type,id,data.diagnostics);
    return res.json({streams:data.streams});
  }
  res.json({streams:[]});
});

app.get('/catalog/channel/oneplay-live.json',async (_req,res)=>{
  const live=await refreshLive(false);
  res.json({metas:live.channels.map(channelMeta)});
});

app.get('/meta/channel/:id.json',async (req,res)=>{
  const live=await refreshLive(false);
  const ch=live.byId.get(req.params.id);
  res.json({meta:ch ? channelMeta(ch) : null});
});

app.get('/debug/:type/:id',async (req,res)=>{
  if(!['movie','series'].includes(req.params.type)) return res.status(400).json({error:'tipo inválido'});
  const data=await aggregateStreams(req.params.type,req.params.id);
  res.json({id:req.params.id,type:req.params.type,total:data.streams.length,providers:data.diagnostics});
});

app.get('/debug/live',async (_req,res)=>{
  const live=await refreshLive(true);
  res.json({
    ok:live.channels.length>0,
    master:LIVE_MASTER,
    lists:live.lists.length,
    channels:live.channels.length,
    groups:[...new Set(live.channels.map(x=>x.group))].slice(0,100),
    errors:live.errors.slice(0,10),
    sample:live.channels.slice(0,5).map(x=>({id:x.id,name:x.name,group:x.group,hasLogo:!!x.logo,hasHeaders:Object.keys(x.headers||{}).length>0}))
  });
});

app.listen(PORT,'0.0.0.0',()=>console.log(`OnePlay Azabel v4.1 listening on ${PORT}`));
