const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','*');
  res.setHeader('Cache-Control','no-store');
  next();
});

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36';
const TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT_MS || 9000);

// Backends que o OnePlay Matrix 3.4.1 consulta como providers Stremio.
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

const manifest = {
  id: 'com.azabel.oneplay.bridge',
  version: '3.2.0',
  name: 'OnePlay • Azabel',
  description: 'Bridge do OnePlay para Stremio/Nuvio: SuperStream + Cotonet e TV ao vivo em catálogo de filmes.',
  resources: [
    {name:'stream', types:['movie','series'], idPrefixes:['tt','tmdb:','live:']},
    {name:'catalog', types:['movie']},
    {name:'meta', types:['movie'], idPrefixes:['live:']}
  ],
  types: ['movie','series'],
  idPrefixes: ['tt','tmdb:','live:'],
  catalogs: [{ type:'movie', id:'oneplay-live', name:'OnePlay • TV ao vivo' }],
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
  // Mantém o contrato Stremio original (URL, torrent, externalUrl, behaviorHints etc.).
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

// ---------------- TV AO VIVO (mesma fonte usada pelo OnePlay Live) ----------------
const LIVE_API='https://embedtv.lat/api/channels';
const LIVE_REFERER='https://w7.embedtv.lat/';
const API_REFERER='https://embedtv.lat/';
const CAT_NAMES={1:'Esportes',2:'Infantil',3:'Documentários',4:'Filmes e Séries',5:'Notícias',6:'TV Aberta',7:'Variedades',9:'Portugal'};
let liveCache={at:0,channels:[]};

function normalizeLivePayload(payload){
  if(!payload || !Array.isArray(payload.channels)) return [];
  const cmap={};
  for(const c of (payload.categories||[])){
    const n=Number(c?.id); if(n) cmap[n]=CAT_NAMES[n] || safeText(c?.name);
  }
  return payload.channels.map(ch=>{
    const id=safeText(ch?.id); if(!id) return null;
    let category='Outros';
    if(id.startsWith('24h_')) category='24 Horas';
    else if(id.startsWith('pt_')) category='Portugal';
    else if(['playboy','sexyhot'].includes(id)) category='Adulto';
    else {
      const first=(ch?.categories||[]).map(Number).find(x=>cmap[x]);
      if(first) category=cmap[first];
    }
    return {
      id:`live:${id}`,
      sourceId:id,
      name:safeText(ch?.name)||id,
      category,
      image:safeText(ch?.image)||safeText(ch?.preview),
      apiUrl:safeText(ch?.url)
    };
  }).filter(Boolean);
}

async function getLiveChannels(){
  if(Date.now()-liveCache.at < 5*60*1000 && liveCache.channels.length) return liveCache.channels;
  try{
    const r=await fetchWithTimeout(LIVE_API,{headers:{Referer:API_REFERER,Accept:'application/json'}});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const channels=normalizeLivePayload(await r.json());
    if(channels.length) liveCache={at:Date.now(),channels};
  }catch(e){ console.error('live catalog:',e.message); }
  return liveCache.channels;
}

function unescapeHtmlText(text){
  return safeText(text)
    .replace(/\\\//g,'/').replace(/\\u002[fF]/g,'/').replace(/\\u003[aA]/g,':')
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}

function absolutize(base,target){
  try { return new URL(target,base).toString(); } catch { return ''; }
}

function mediaCandidates(base,text){
  const clean=unescapeHtmlText(text); const found=[];
  const push=v=>{ v=safeText(v).replace(/[);,\]]+$/,''); if(v && !found.includes(v)) found.push(v); };
  for(const m of clean.matchAll(/https?:\/\/[^\s"'<>]+/gi)) push(m[0]);
  for(const m of clean.matchAll(/(?<!:)\/\/[^\s"'<>]+/gi)) push('https:'+m[0]);
  for(const m of clean.matchAll(/["'](\/[^"']+)["']/gi)) push(absolutize(base,m[1]));
  const scored=found.map((u,i)=>{
    let p; try{p=new URL(u)}catch{return null}
    const host=p.hostname.toLowerCase(), path=p.pathname.toLowerCase();
    const file=path.endsWith('file.txt'); const m3u8=path.endsWith('.m3u8')||u.toLowerCase().includes('.m3u8?');
    let rank=99;
    if(file && host.endsWith('cloudfront-net.lat')) rank=0;
    else if(m3u8 && host.endsWith('cloudfront-net.lat')) rank=1;
    else if(m3u8 && host.endsWith('embedtv.lat')) rank=2;
    else if(m3u8) rank=3;
    return rank<99?{u,rank,i}:null;
  }).filter(Boolean).sort((a,b)=>a.rank-b.rank||a.i-b.i);
  return scored.slice(0,12).map(x=>x.u);
}

function iframeCandidates(base,text){
  const clean=unescapeHtmlText(text), out=[];
  for(const m of clean.matchAll(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/gi)){
    const u=absolutize(base,m[1]);
    try{ const h=new URL(u).hostname.toLowerCase(); if(h==='embedtv.lat'||h.endsWith('.embedtv.lat')) out.push(u); }catch{}
  }
  return [...new Set(out)].slice(0,4);
}

async function resolveLiveUrl(channel){
  const headers={Referer:LIVE_REFERER,Origin:'https://w7.embedtv.lat',Accept:'*/*'};
  const starts=[];
  if(channel.apiUrl) starts.push(channel.apiUrl);
  starts.push(`https://w7.embedtv.lat/${encodeURIComponent(channel.sourceId)}`);
  const visited=new Set();
  async function probe(url,depth=0){
    if(!url || visited.has(url) || depth>2) return null; visited.add(url);
    try{
      const r=await fetchWithTimeout(url,{headers});
      if(!r.ok) return null;
      const final=r.url||url;
      const ct=(r.headers.get('content-type')||'').toLowerCase();
      const text=await r.text();
      if(text.includes('#EXTM3U') || final.toLowerCase().includes('.m3u8') || final.toLowerCase().endsWith('file.txt')){
        return {url:final,headers};
      }
      for(const candidate of mediaCandidates(final,text)){
        // Não baixa segmentos; apenas seleciona o endpoint que o player abrirá.
        try{
          const cr=await fetchWithTimeout(candidate,{headers});
          if(!cr.ok) continue;
          const body=await cr.text();
          if(body.includes('#EXTM3U') || candidate.toLowerCase().includes('.m3u8') || candidate.toLowerCase().endsWith('file.txt'))
            return {url:cr.url||candidate,headers};
        }catch{}
      }
      for(const page of iframeCandidates(final,text)){
        const nested=await probe(page,depth+1); if(nested) return nested;
      }
    }catch{}
    return null;
  }
  for(const u of starts){ const got=await probe(u); if(got) return got; }
  return null;
}

app.get('/',(_req,res)=>res.type('html').send(`
<h2>OnePlay • Azabel v3.2 online</h2>
<p><a href="/manifest.json">manifest.json</a></p>
<p><a href="/health">health</a></p>`));

app.get('/health',async (_req,res)=>{
  res.json({ok:true,version:'3.2.0',providers:PROVIDERS.map(p=>p.key),liveApi:LIVE_API});
});
app.get('/manifest.json',(_req,res)=>res.json(manifest));

app.get('/stream/:type/:id.json',async (req,res)=>{
  const {type,id}=req.params;

  // Os canais são anunciados como "movie" só para o Stremio exibir o catálogo.
  // IDs live:* continuam sendo resolvidos como transmissão ao vivo.
  if((type==='movie'||type==='channel'||type==='tv') && id.startsWith('live:')){
    const channels=await getLiveChannels();
    const ch=channels.find(x=>x.id===id);
    if(!ch) return res.json({streams:[]});
    const resolved=await resolveLiveUrl(ch);
    if(!resolved) return res.json({streams:[]});
    return res.json({streams:[{
      name:'OnePlay • TV ao vivo',
      title:`${ch.name} • ${ch.category}`,
      url:resolved.url,
      behaviorHints:{
        notWebReady:true,
        proxyHeaders:{request:resolved.headers}
      }
    }]});
  }

  if(type==='movie'||type==='series'){
    const data=await aggregateStreams(type,id);
    console.log(type,id,data.diagnostics);
    return res.json({streams:data.streams});
  }
  res.json({streams:[]});
});

async function liveCatalog(_req,res){
  const channels=await getLiveChannels();
  res.json({metas:channels.map(ch=>({
    id:ch.id,type:'movie',name:ch.name,poster:ch.image||undefined,posterShape:'square',
    description:`TV ao vivo • ${ch.category}`,genres:[ch.category]
  }))});
}
app.get('/catalog/movie/oneplay-live.json', liveCatalog);
// Aliases mantidos para teste/compatibilidade, embora o manifest anuncie movie.
app.get('/catalog/channel/oneplay-live.json', liveCatalog);
app.get('/catalog/tv/oneplay-live.json', liveCatalog);

async function liveMeta(req,res){
  const channels=await getLiveChannels();
  const ch=channels.find(x=>x.id===req.params.id);
  res.json({meta:ch?{
    id:ch.id,type:'movie',name:ch.name,poster:ch.image||undefined,posterShape:'square',
    description:`TV ao vivo • ${ch.category}`,genres:[ch.category],
    behaviorHints:{defaultVideoId:ch.id}
  }:null});
}
app.get('/meta/movie/:id.json', liveMeta);
app.get('/meta/channel/:id.json', liveMeta);
app.get('/meta/tv/:id.json', liveMeta);

// Diagnóstico opcional: mostra quantas fontes cada provider retornou sem expor URLs.
app.get('/debug/:type/:id',async (req,res)=>{
  if(!['movie','series'].includes(req.params.type)) return res.status(400).json({error:'tipo inválido'});
  const data=await aggregateStreams(req.params.type,req.params.id);
  res.json({id:req.params.id,type:req.params.type,total:data.streams.length,providers:data.diagnostics});
});

app.listen(PORT,'0.0.0.0',()=>console.log(`OnePlay Azabel v3.2 listening on ${PORT}`));
