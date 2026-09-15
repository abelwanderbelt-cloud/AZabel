# Azabel Streams v2 — Stremio / Nuvio

This is a dynamic Stremio-compatible bridge for **sources you are authorized to use**.

## What changed from v1

v1 only read local example JSON files. v2 can query a real upstream stream API dynamically and can build a Live TV catalog from a remote M3U playlist.

## Render setup

Replace the files in your GitHub repo with this folder and push. Render should redeploy automatically.

### Environment variables

In Render -> your service -> Environment, add what you use:

- `STREAM_PROVIDER_URL` — HTTPS endpoint for your authorized stream provider. The bridge calls it with `?type=movie&id=tt...` or `?type=series&id=tt...:season:episode`.
- `STREAM_PROVIDER_TOKEN` — optional bearer token for that API.
- `LIVE_M3U_URL` — optional HTTPS URL to an M3U playlist you are authorized to access.
- `UPSTREAM_TIMEOUT_MS` — optional; default `12000`.
- `LIVE_CACHE_SECONDS` — optional; default `300`.

The stream provider may return either:

```json
{"streams":[{"name":"Minha fonte","title":"1080p","url":"https://example.com/video.m3u8"}]}
```

or simply an array of those objects.

## Install

After deploy, open:

`https://YOUR-SERVICE.onrender.com/health`

Then install:

`https://YOUR-SERVICE.onrender.com/manifest.json`

## Important

This repository does not include scraping/resolution code for unlicensed third-party streaming sites. Plug in an API/M3U you own or are authorized to use.
