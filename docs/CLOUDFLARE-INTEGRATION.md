# NCSound on Cloudflare + Supabase — integration plan

Goal: the music library and its derivatives live in **Cloudflare R2**, the
relational data lives in **Supabase (Postgres)**, and the edge APIs, AI and
heavy jobs run on **Cloudflare Workers, Containers and AI**. This removes the
home PC as a single point of failure for everything except the live encoder
(until that moves too), and uses the products Cloudflare shipped in 2025–2026.

Account in play: `tap4500@gmail.com` (account `a7ce29a9…1722`). Already present:
Workers (`vec-memory`, `py-ai`, `browser-run`), R2 (`overlayr2`,
`oncology-papers`), D1 (`brain-memory`, `truth-chain-ledger`), Vectorize
(`brain-memory`, 384-dim cosine). Wrangler 4.147 is authenticated on this PC.

## 1. Product mapping

| Need | Cloudflare product | Why this one |
|---|---|---|
| Music files, stems, artwork, waveforms | **R2** | Zero egress; $0.015/GB-mo, 10 GB free |
| Serve music fast, worldwide | **R2 custom domain + Cache Rules** | Free egress, CDN edge cache |
| Query the catalog for analytics | **Basin Catalog** (Iceberg on R2, GA) | SQL/Spark/DuckDB over the bucket with no egress |
| Relational DB (tracks, shows, requests, users) | **Supabase Postgres** | Already the source of truth; Auth/Realtime included |
| Reach Supabase from Workers, fast | **Hyperdrive** | Global Postgres pooling + query caching |
| Edge API (search, signed URLs, now-playing) | **Workers** | Cheap, global, binds R2/Hyperdrive/Vectorize/AI |
| Live state (listeners, autopilot, live key) | **Durable Objects** (SQLite) | Strongly consistent, one object per station |
| Background jobs (index, transcode, stems) | **Queues + Workflows** | Retries, fan-out, long-running orchestration |
| **Stems (Demucs)** and ffmpeg transcodes | **Containers** (GA) | Any Docker image; Python + torch fits here |
| Music similarity / crates / recommendation | **Vectorize** | Vector index; feed it engine audio features |
| Embeddings, tagging, show transcription | **Workers AI** | 50+ models (embeddings, Whisper, Llama), GA |
| LLM observability / rate limits / cache | **AI Gateway** | In front of every model call |
| Docs/help RAG | **AI Search** | Managed hybrid + rerank index |
| Live/on-demand video (OBS) | **Stream** | RTMP/WHIP in, adaptive HLS out, DVR |
| Operator auth (console, Ops) | **Access** (Zero Trust) | SSO in front of admin surfaces, free ≤50 users |
| Bot protection on requests/submissions | **Turnstile** | Drop-in CAPTCHA alternative |
| Remote ingest reachability | **Cloudflare Tunnel** | Already configured (`overlay365.com`) |
| Scheduled tasks (charts, backups) | **Cron Triggers** | Native to Workers |

## 2. Target architecture

```
                          ┌────────────────────────── Cloudflare ──────────────────────────┐
 listener / DJ            │  Workers (edge API)   Vectorize   Workers AI   AI Gateway        │
   │  HTTPS              │   ncsound-api            │           │            │            │
   ▼                     │   bind: R2, Hyperdrive,  │           │            │            │
 station site / console ──┤         Vectorize, AI,   │           │            │            │
                          │         Queues, DO       │           │            │            │
                          │        │                 │           │            │            │
                          │  R2 ncsound-media ◄──────┘           │            │            │
                          │   originals, stems, waveform, art   │            │            │
                          │   + Basin Catalog (Iceberg)         │            │            │
                          │        ▲                            │            │            │
                          │  Containers: ncsound-stems (Demucs) │            │            │
                          │              ncsound-transcode(ffmpeg) ◄─ Queues (jobs)         │
                          │              ncsound-station (opt: Liquidsoap+Icecast+ingest)   │
                          └────────┬────────────────────────────────────────────────────────┘
                                   │ Hyperdrive (Pg pool, cached)
                                   ▼
                          Supabase (Postgres)  + Auth  + Realtime
```

## 3. Storage: R2

- **Bucket `ncsound-media`** (Standard tier). Key layout:
  - `originals/<trackId>.<ext>` — the uploaded file.
  - `analysis/<trackId>.json` — BPM, first beat, key, waveform bands, cues (already computed by the engine).
  - `stems/<trackId>/{vocals,drums,bass,other}.wav` — from the stems container.
  - `artwork/<album>.jpg`, `recordings/<setId>.webm` (set recordings from the console).
- **Serving:** attach a custom domain (e.g. `media.<domain>`); public read for
  playback, **signed URLs** for anything private. Range requests work (needed
  for seek). Free tier is 10 GB; the whole 410-file library plus stems is well
  under a few dollars/month at $0.015/GB-mo with **free egress**.
- **Migration in:** `wrangler r2 object put` for a folder is slow; use the **S3
  API** (`rclone` or a small script) or **Super Slurper** if the source is
  another bucket. From a local disk, `rclone copy` to R2 over S3 is the tool.
- **Analytics:** turn on **Basin Catalog** on the bucket and query play counts /
  genre trends with DuckDB/Spark without moving data.

## 4. Database: Supabase

- Supabase stays the relational source of truth (the station site already uses
  Prisma + Supabase). No migration needed for the schema; the change is how
  **Workers** reach it.
- **Hyperdrive** binds a connection to the Supabase Postgres endpoint
  (pooler). Workers then `new Client({ connectionString: env.HYPERDRIVE... })`
  and query directly, with caching for hot reads (catalog listings, show
  schedules). This is what makes "DB in Supabase + edge Workers" fast.
- Keep Prisma in the Next.js site as-is; Workers are additive for the edge
  paths (search, signed URLs, now-playing, requests).

## 5. Compute

**Workers (`ncsound-api`)** — the edge surface:
- `GET /library/search` (Hyperdrive), `GET /library/:id/url` (R2 signed),
  `GET /now-playing` (Durable Object), `POST /requests`, `POST /stems/:id`
  (enqueue), OAuth/JWT checks against Supabase.
- **Cron**: nightly chart refresh, R2 lifecycle, Vectorize reindex of changed tracks.

**Containers** — the heavy jobs a Worker cannot do:
- **`ncsound-stems`** — a Docker image with Python + `demucs` + `torch`,
  invoked from a Queue message. This is Phase 7B **Path B, in the cloud**: no
  Python on the operator's PC, and it uses Cloudflare's CPU instead of a home
  machine. Instance `standard-3` (2 vCPU / 8 GB) is a reasonable start; scale to
  zero between jobs. (A 4-minute track separated at ~2× realtime is ~8 vCPU-min,
  inside the 375 vCPU-min/month included.)
- **`ncsound-transcode`** — ffmpeg: normalise formats to a playback codec, write
  waveform peaks and EBU R128 loudness, so the console always gets a
  known-good file.
- **`ncsound-station` (optional, later)** — Liquidsoap + Icecast + the ingest
  bridge in a container. This is the move that removes the *home PC* dependency
  the plan flags as the station's biggest risk. Egress from Containers is
  $0.025/GB with 1 TB/month included in NA/EU, which covers listeners.

**Durable Objects** — one object per station: now-playing, listener count,
autopilot/live state, and the single-use live keys the console redeems.

**Queues + Workflows** — `index` (analysis), `stems`, `transcode`; a Workflow
for "import album → transcode → analyse → embed → publish".

## 6. AI: Workers AI + Vectorize + AI Gateway

- **Embeddings**: Workers AI `bge-*` for text; for **music similarity**, embed
  the engine's own feature vector (BPM, key, energy curve, 3-band balance,
  spectral centroid/rolloff) — either store it directly in Vectorize or hash it
  through an embedding model. Index `ncsound-tracks` (pick one dimensionality:
  `bge-small` 384, `bge-m3` 1024; keep it consistent with the model).
- **Features it unlocks**: "more like this", auto-crate a set at a target BPM
  + harmonic key path, suggest the next track, find duplicates.
- **Whisper** transcribes shows (already recorded) into searchable logs and
  auto show notes. **Llama** writes metadata/bios, tags genres, drafts sweeps.
- **AI Gateway** in front of all of it for caching, per-key rate limits,
  retries and cost/latency analytics.

## 7. Video and live

- **Stream** takes OBS via RTMP/WHIP (one stream key), delivers adaptive HLS
  with DVR, and embeds on the site. This replaces "send OBS to a platform" with
  your own endpoint, and pairs with the R2-hosted audio.
- Radio audio is **not** served through Cloudflare. Cloudflare's
  Service-Specific Terms bar pushing a disproportionate share of audio through
  the free CDN, and Cloudflare does not cache ICY streams, so a tunnel would buy
  nothing and risk the account. Listeners are served by a **small VPS running
  Icecast over TLS on a DNS-only subdomain**, fed by the home Liquidsoap as a
  source client (push). Moving the whole chain into a `ncsound-station`
  container later stays additive. See
  `docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md` §4 (decisions D9–D11).

## 8. Security

- **Access** gates the console, Ops and any admin route (SSO, free ≤50 seats).
- **Turnstile** on the public request/submission forms.
- WAF + rate-limiting rules on `/requests` and the API.
- Tokens: `INGEST_TOKEN` (already), Supabase service role only server-side,
  R2 access only via short-lived signed URLs.

## 9. Cost sketch (Workers Paid, $5/mo)

| Item | Assumption | Rough cost |
|---|---|---|
| Workers Paid | base | $5 |
| R2 storage | ~5 GB originals + ~20 GB stems | ~$0.38/mo |
| R2 egress | free | $0 |
| R2 ops | << free tier (10M Class B) | $0 |
| Workers requests/CPU | a small radio site | within included |
| Containers (stems) | ~40 tracks/mo on standard-3 | within included vCPU/mem, watch egress |
| Workers AI | embeddings + occasional Llama/Whisper | cents, 10k neurons/day free |
| Vectorize | tens of thousands of vectors | small |
| Supabase | existing plan | unchanged |

Net: the platform runs comfortably inside the $5 plan plus a few dollars of R2
for the whole library and its stems. The two figures to watch are **Container
egress** once the station itself moves, and **Workers AI neurons** if you
transcribe every show.

## 10. Phased rollout

1. **R2 media** — create `ncsound-media`, custom domain, upload the library
   (rclone over S3), enable Basin Catalog. Point the console's station source at
   R2 signed URLs.
2. **Workers API** — `ncsound-api` with R2 + Hyperdrive bindings; move search
   and stream-URL signing off the local ingest.
3. **Vectorize** — backfill feature vectors via a Queue consumer; ship
   "similar tracks" and auto-crate.
4. **Containers** — `ncsound-transcode`, then `ncsound-stems` (Phase 7B Path B).
5. **Stream** — OBS → Stream live, embed HLS on the site.
6. **Station container (optional)** — Liquidsoap + Icecast + ingest, retiring
   the home-PC dependency.
7. **Access + Turnstile + WAF + AI Gateway + observability**.

## 11. Open questions / to verify on the account

- Vectorize dimensionality must match the chosen embedding model; pick text vs
  audio-feature embedding deliberately (audio features are the right signal for
  "sounds like").
- Container image size limits and whether a torch+demucs image fits comfortably;
  check `containers/platform/limits`.
- Hyperdrive against Supabase's pooler (transaction mode) — confirm the driver
  and prepared-statement settings.
- Basin Catalog auth from DuckDB/Spark (Iceberg REST + token).
- Supabase free/pro tier limits versus R2-backed storage (avoid double-hosting).

## Status — 2026-10-07

- **`ncsound-media` R2 bucket created** (account `a7ce29a9…1722`).
- **Public read enabled** at `https://pub-60151c96c0f94efda750ddb57bb5c41c.r2.dev`
  (the `r2.dev` dev URL — rate-limited, for testing; a custom domain is the
  production path). Verified: an uploaded MP3 returns 200 `audio/mpeg`.
- **Library uploaded** with `infra/r2-upload.mjs` (wrangler OAuth token, no S3
  keys, concurrency 6), keys mirroring `C:\Users\User\Music`: `music/<album>/<file>`
  plus any top-level files. **410/410 files, 2.17 GB.**
- **Key sanitization:** R2's API returns **403** for any object key containing a
  `..` run (path-traversal guard), so names like `A.R.T..mp3` and
  `Presents... The` cannot be stored verbatim. The uploader collapses each run of
  two-plus dots to one, per path segment. This fixed the 15 initially-failed
  files; all are now public and fetchable.
- **Note:** an object uploaded *without* `--remote` goes to wrangler's local
  simulated R2, not the bucket (a probe object 404'd until this was understood).
  The uploader always passes `--remote`.
- **R2 API token:** the wrangler OAuth token cannot mint tokens (403 on
  `user/tokens`). For the faster, resumable `rclone` path, create an **R2 API
  token** (R2 → Manage API Tokens → Object Read & Write on `ncsound-media`) and
  add an rclone remote with endpoint
  `https://a7ce29a9eb21fc83bf09dd954b861722.r2.cloudflarestorage.com`.
- **Next:** point the console's station/library source at R2 (signed URLs or a
  custom domain + CORS), and wire OBS.

## Status — 2026-10-07 (phase 2, done and verified)

- **Bucket CORS set** on `ncsound-media`: `GET/HEAD`, origins `*`, exposes
  `content-length`, `content-range`, `accept-ranges`, `etag`. Before this the
  r2.dev response carried **no** `Access-Control-Allow-Origin`, so a browser
  fetch was blocked. Verified: `curl -H "Origin: …"` now returns
  `Access-Control-Allow-Origin: *`.
- **Worker `ncsound-api` deployed** at
  `https://ncsound-api.tap4500.workers.dev` (source `workers/ncsound-api/`,
  R2 binding `MEDIA -> ncsound-media`). Endpoints:
  - `GET /health`
  - `GET /library` — the full catalog from R2 `list()` (410 objects measured)
  - `GET /library/manifest` — keys only
  - `GET /audio/<key>` — bytes with Range support (verified `206`,
    `Content-Range: bytes 0-99/869376`), CORS `*`
- **No static manifest was uploaded.** R2 cannot list objects publicly, so the
  catalog must come from the Worker; a static manifest would be a second copy
  that desyncs. `GET /library` reads ground truth live instead.
- **Console R2 source added** (`apps/dj-console/src/library/sources/r2.ts`,
  `source: "r2"`): an **R2** button in the Library toolbar imports the catalog
  and streams bytes from the bucket. Verified with `scripts/r2-check.mjs`:
  **410 rows imported, a track loads from R2, 0 page errors.** Console
  typecheck + full test suite green.
- **Worker inventory measured (read-only):** zones `overlay365.online` and
  `truckbuddy.online`; Vectorize only `brain-memory`. The wrangler OAuth token
  **cannot** reach AI Gateway or Stream (`403 Authentication error` — those
  scopes are absent). Turnstile, Hyperdrive and Queues endpoints answer.

### What each remaining phase needs (measured blockers, not guesses)

| Phase | Blocker |
|---|---|
| 3 Vectorize | No audio-feature backfill exists: features live in the browser's IndexedDB, not on disk. Needs a producer (console-publish with a server-held token, or offline analysis) before an index means anything. |
| 4 Containers (transcode/stems) | **Docker Desktop 29.8.2 installed 2026-10-07; engine running.** Unblocked (image build is the only cost). |
| 5 Stream (OBS video) | The wrangler OAuth cannot request a `stream` scope at all (`wrangler login --scopes-list`, measured). Needs a dashboard **API token** with Account → Stream Edit, passed as `CLOUDFLARE_API_TOKEN`. Stream is billed separately. |
| 6 Station container | Docker is now installed; same path as phase 4. |
| 7 Access/WAF/AI Gateway | The OAuth token has only `zone:read` (no DNS/zone write and `POST /workers/domains` → 405), and no `access`/`agw` scopes; `wrangler login --scopes-list` cannot grant them. Needs a dashboard **API token** with the Access and AI Gateway permission groups. Turnstile (`challenge-widgets.write`) and Queues are already reachable. |
| Hyperdrive → Supabase | Needs the Supabase Postgres connection string (a secret; not present here). |



## Status — 2026-10-07 (evening): hardening and offline, **code done, not yet deployed**

What changed in the repo (the live Workers still run the old code until you deploy):

- **`ncsound-api` token lock (optional).** Set the `LIBRARY_TOKEN` secret and
  `/library*` and `/audio/*` need `Authorization: Bearer <token>` (or `?t=`).
  `/health` stays open. With no secret it behaves exactly as before. Also fixed:
  a malformed `%` key returned 500 (now 400); an out-of-range byte range returned
  500 (now 416); audio responses carry `Cache-Control`. 14 tests in
  `workers/ncsound-api/test/api.test.ts` against a **fake** R2 bucket, so range
  behaviour on real R2 is not proven by them.
- **`ncsound-transcode` fails closed.** It was a public POST endpoint that feeds
  up to 200 MB into billed container compute, and nothing in the console calls
  it. Now `/loudness` and `/transcode` need the `TRANSCODE_TOKEN` secret and
  answer **503 until it is set**, then 401 without the right bearer, POST only.
  `/health` stays open. 4 tests.
- **Console streams audio through the Worker**, not the rate-limited `r2.dev`
  URL (`src/library/sources/r2.ts`). A token field is in Settings.
- **Importing R2 no longer downloads the bucket.** It used to queue all 410
  tracks for background analysis, which fetched ~2.17 GB. R2 tracks are now
  analysed when loaded or saved offline.
- **Offline cache** (`src/library/sources/r2Cache.ts`, Cache Storage, keyed by
  object key). Every track you load is kept; the Library **Offline** key saves
  the Up Next queue's R2 tracks ahead of a gig and analyses them. Incomplete
  downloads are never stored. 8 tests (fake Cache Storage).

### Deploy and lock down (run on the PC; wrangler is Windows-only there)

Shortcut: `powershell -ExecutionPolicy Bypass -File infra\cloudflare-lockdown.ps1` does steps 2 to 6 below, verifies the 401/200 on the live Worker before it offers to disable `r2.dev`, and prints the token once. **That script has never been run** (no Windows shell was available to test it); read it first. The manual steps:

1. Deploy the new console build first, so it has the token field.
2. `cd workers/ncsound-api` then `bunx wrangler secret put LIBRARY_TOKEN` then `bunx wrangler deploy`.
3. In the console: Settings -> R2 library token -> paste it. Click R2 and load a track.
4. `cd ../ncsound-transcode` then `bunx wrangler secret put TRANSCODE_TOKEN` then `bunx wrangler deploy`.
5. Turn off public `r2.dev` access (the console no longer needs it):
   `bunx wrangler r2 bucket dev-url disable ncsound-media` (check with `--help`; the dashboard toggle does the same).
6. From any other device with no token: `curl -i https://ncsound-api.tap4500.workers.dev/library` must return **401**, and the old `pub-…r2.dev` URL must stop serving files.

**Why step 5 matters:** the bucket currently holds 410 commercial tracks
(albums and mixtapes) behind a public URL. Anyone who has the address can
download them, and public hosting of copyrighted recordings is the kind of thing
that gets a Cloudflare account actioned. Leaving `ALLOWED_ORIGINS` at `*` is
harmless once the token is on; with the token off it is not.

## Status — 2026-10-07 (phase 4 done; phase 5 live input created)

- **Docker Desktop 29.8.2** installed; engine running (its pipe flips between
  `docker_engine` and `dockerDesktopLinuxEngine` across restarts — set the
  context or PATH before `wrangler deploy`).
- **`ncsound-transcode` deployed**: Worker `https://ncsound-transcode.tap4500.workers.dev`
  with a Container built from `workers/ncsound-transcode/Dockerfile`
  (`node:22-bookworm-slim` + `ffmpeg 5.1.9`, instance `lite`, max 2). Endpoints
  `GET /health`, `POST /loudness`, `POST /transcode`.
- **Verified end to end:** a 1 kHz sine at −6 dBFS reads **−9.0 LUFS / −6.0
  dBTP**; a real ambient MP3 reads −70 LUFS / −17 dBTP; `/transcode?kbps=192`
  returns a valid 192 kbps MP3 (652653 bytes from an 869376-byte source) with
  `x-loudness-*` headers and CORS. Note: ebur128 reports **LRA 20.0 LU for a
  constant tone** — a documented degenerate value, not a bug.
  (A real bug was found and fixed: the parser took the *first* ebur128 line, the
  running gate floor, so every track read −70 LUFS. See the lessons folder.)
- **Subdomain created:** `ncsound-api.overlay365.online` → proxied CNAME to
  `ncsound-api.tap4500.workers.dev` **plus** a Worker route
  `ncsound-api.overlay365.online/*` → `ncsound-api`. Verified: `GET
  https://ncsound-api.overlay365.online/health` serves the Worker. (The
  `workers/domains` API returns 405 for this token; DNS + route works instead.)
- **Stream live input `ncsound-obs`** created (uid `92f086306cebc22c7ce3a0e6d546db7f`):
  RTMPS `rtmps://live.cloudflare.com:443/live/`, SRT `srt://live.cloudflare.com:778`,
  HLS playback manifest. **The stream key is a secret; it lives in the dashboard /
  API, never in this repo.**
- **Token:** an account API token is now used via `CLOUDFLARE_API_TOKEN`. It
  grants DNS edit, Worker routes, Stream and AI Gateway. **Access is not enabled
  on the account** (`403 Access is not enabled`).
- **Remaining:** phase 3 (Vectorize backfill), the stems container (phase 4b),
  console wiring of `/loudness` + `/transcode` and OBS → Stream (set OBS's
  Stream settings to the RTMPS URL + key), the station container (phase 6), and
  Access/Turnstile/AI Gateway wiring (phase 7).

## Sources (opened 2026-10-07)

- R2 overview + pricing (`developers.cloudflare.com/r2/`, `/r2/pricing/`) —
  primary.
- Basin Catalog (`developers.cloudflare.com/basin-catalog/`) — primary.
- Containers overview + pricing (`developers.cloudflare.com/containers/`,
  `/containers/platform/pricing/`) — primary.
- Hyperdrive (`developers.cloudflare.com/hyperdrive/`) — primary.
- Workers AI (`developers.cloudflare.com/workers-ai/`) — primary.
- Stream (`developers.cloudflare.com/stream/`) — primary.
- Workers & Pages pricing (`cloudflare.com/plans/developer-platform/`) — primary.
- Existing account state: `wrangler r2/d1/vectorize/kv list`, `wrangler whoami` — measured.
