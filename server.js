const express = require('express');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','*');
  res.setHeader('Cache-Control','no-store');
  next();
});

const manifest = {
  id: 'com.azabel.dynamic.bridge',
  version: '2.0.0',
  name: 'Azabel Streams',
  description: 'Dynamic stream bridge for Stremio/Nuvio. Connects only to sources you configure and are authorized to use.',
  resources: ['stream','catalog','meta'],
  types: ['movie','series','tv'],
  idPrefixes: ['tt','tmdb:','tv:'],
  catalogs: [{ type:'tv', id:'live-tv', name:'TV ao vivo' }],
  behaviorHints: { configurable: false }
};

function normalizeStream(x, i=0){
  if(!x) return null;
  if(typeof x === 'string') return { name:'Fonte', title:`Fonte ${i+1}`, url:x };
  const url = x.url || x.stream || x.link;
  if(!url) return null;
  return {
    name: x.name || x.provider || 'Fonte',
    title: x.title || x.quality || x.label || `Fonte ${i+1}`,
    url,
    behaviorHints: x.behaviorHints || undefined
  };
}

async function fetchJson(url, opts={}){
  const ctl = new AbortController();
  const t = setTimeout(()=>ctl.abort(), Number(process.env.UPSTREAM_TIMEOUT_MS || 12000));
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal, headers:{'user-agent':'AzabelBridge/2.0', ...(opts.headers||{})} });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

function providerUrl(type,id){
  const base = (process.env.STREAM_PROVIDER_URL || '').trim();
  if(!base) return null;
  const u = new URL(base);
  u.searchParams.set('type', type);
  u.searchParams.set('id', id);
  return u.toString();
}

async function dynamicStreams(type,id){
  const u = providerUrl(type,id);
  if(!u) return [];
  try {
    const data = await fetchJson(u, process.env.STREAM_PROVIDER_TOKEN ? { headers:{authorization:`Bearer ${process.env.STREAM_PROVIDER_TOKEN}`} } : {});
    const arr = Array.isArray(data) ? data : (Array.isArray(data.streams) ? data.streams : []);
    return arr.map(normalizeStream).filter(Boolean);
  } catch(e){
    console.error('provider error', e.message);
    return [];
  }
}

function parseM3u(text){
  const lines = text.replace(/\r/g,'').split('\n');
  const out=[];
  let info=null;
  for(const raw of lines){
    const line=raw.trim();
    if(line.startsWith('#EXTINF:')){
      const attrs={};
      const re=/([\w-]+)="([^"]*)"/g; let m;
      while((m=re.exec(line))) attrs[m[1]]=m[2];
      const comma=line.indexOf(',');
      info={name: comma>=0 ? line.slice(comma+1).trim() : (attrs['tvg-name']||'Canal'), attrs};
    } else if(info && line && !line.startsWith('#')){
      const key=(info.attrs['tvg-id']||info.name||line).toLowerCase();
      const hash=crypto.createHash('sha1').update(key).digest('hex').slice(0,16);
      out.push({
        id:`tv:${hash}`,
        name:info.attrs['tvg-name']||info.name,
        poster:info.attrs['tvg-logo']||undefined,
        group:info.attrs['group-title']||undefined,
        url:line
      });
      info=null;
    }
  }
  return out;
}

let liveCache={at:0, channels:[]};
async function getLiveChannels(){
  const ttl=Number(process.env.LIVE_CACHE_SECONDS || 300)*1000;
  if(Date.now()-liveCache.at < ttl) return liveCache.channels;
  const url=(process.env.LIVE_M3U_URL||'').trim();
  if(!url) return [];
  try{
    const r=await fetch(url,{headers:{'user-agent':'AzabelBridge/2.0'}});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const channels=parseM3u(await r.text());
    liveCache={at:Date.now(),channels};
    return channels;
  }catch(e){
    console.error('m3u error',e.message);
    return liveCache.channels || [];
  }
}

app.get('/',(_req,res)=>res.type('html').send(`
<h2>Azabel Streams v2 online</h2>
<p><a href="/manifest.json">manifest.json</a></p>
<p>Dynamic provider: ${process.env.STREAM_PROVIDER_URL ? 'configured' : 'not configured'}<br>
Live M3U: ${process.env.LIVE_M3U_URL ? 'configured' : 'not configured'}</p>`));

app.get('/health',(_req,res)=>res.json({ok:true,version:'2.0.0',providerConfigured:!!process.env.STREAM_PROVIDER_URL,liveConfigured:!!process.env.LIVE_M3U_URL}));
app.get('/manifest.json',(_req,res)=>res.json(manifest));

app.get('/stream/:type/:id.json', async (req,res)=>{
  const {type,id}=req.params;
  if(type==='tv'){
    const channels=await getLiveChannels();
    const ch=channels.find(x=>x.id===id);
    return res.json({streams: ch ? [{name:'TV ao vivo',title:ch.name,url:ch.url}] : []});
  }
  return res.json({streams:await dynamicStreams(type,id)});
});

app.get('/catalog/tv/live-tv.json', async (_req,res)=>{
  const channels=await getLiveChannels();
  res.json({metas:channels.map(ch=>({id:ch.id,type:'tv',name:ch.name,poster:ch.poster,posterShape:'square',description:ch.group?`Categoria: ${ch.group}`:undefined}))});
});
app.get('/meta/tv/:id.json', async (req,res)=>{
  const channels=await getLiveChannels();
  const ch=channels.find(x=>x.id===req.params.id);
  res.json({meta:ch?{id:ch.id,type:'tv',name:ch.name,poster:ch.poster,posterShape:'square',description:ch.group?`Categoria: ${ch.group}`:undefined}:null});
});

app.listen(PORT,'0.0.0.0',()=>console.log(`Azabel Streams v2 listening on ${PORT}`));
