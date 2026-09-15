const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', file), 'utf8'));
  } catch {
    return fallback;
  }
};

const manifest = {
  id: 'com.example.stremio.nuvio.bridge',
  version: '1.0.0',
  name: 'Meu Bridge',
  description: 'Bridge pessoal para Stremio/Nuvio usando apenas fontes autorizadas.',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series', 'tv'],
  idPrefixes: ['tt', 'tmdb:', 'tv:'],
  catalogs: [
    { type: 'tv', id: 'legal-live', name: 'TV ao vivo' }
  ]
};

app.get('/', (_req, res) => {
  res.type('html').send('<h2>Stremio/Nuvio Bridge online</h2><p>Use <code>/manifest.json</code>.</p>');
});

app.get('/manifest.json', (_req, res) => res.json(manifest));

app.get('/catalog/tv/legal-live.json', (_req, res) => {
  const channels = readJson('channels.json', []);
  res.json({
    metas: channels.map(ch => ({
      id: ch.id,
      type: 'tv',
      name: ch.name,
      poster: ch.poster || undefined,
      posterShape: 'square',
      description: ch.description || undefined
    }))
  });
});

app.get('/meta/tv/:id.json', (req, res) => {
  const channels = readJson('channels.json', []);
  const ch = channels.find(x => x.id === req.params.id);
  if (!ch) return res.json({ meta: null });
  res.json({
    meta: {
      id: ch.id,
      type: 'tv',
      name: ch.name,
      poster: ch.poster || undefined,
      background: ch.background || undefined,
      description: ch.description || undefined
    }
  });
});

app.get('/stream/:type/:id.json', (req, res) => {
  const { type, id } = req.params;
  const streamsMap = readJson('streams.json', {});
  const channels = readJson('channels.json', []);

  if (type === 'tv') {
    const ch = channels.find(x => x.id === id);
    if (!ch || !ch.url) return res.json({ streams: [] });
    return res.json({ streams: [{ name: ch.name, title: ch.title || 'Ao vivo', url: ch.url }] });
  }

  // Chaves aceitas em streams.json:
  // "movie:tt1234567"
  // "series:tt1234567:1:2"
  const key = `${type}:${id}`;
  const streams = Array.isArray(streamsMap[key]) ? streamsMap[key] : [];
  res.json({ streams });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bridge ouvindo na porta ${PORT}`);
});
