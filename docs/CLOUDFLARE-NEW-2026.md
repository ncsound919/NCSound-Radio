# Cloudflare 2026 — what's new, and what it means for NCSound

A pass over Cloudflare's newest Developer Platform features (Birthday Week
2026, Sep 29–Oct 5; plus earlier-2026 GA launches) and which ones change the
plan. Sources at the end. Legend: **adopt** / **later** / **not relevant**.

## The ones that touch NCSound

| Feature | Status | What it is | Relevance to NCSound | Verdict |
|---|---|---|---|---|
| **Workers VPC** | beta, free | Bind a Worker to a private host:port (or a whole network) via Cloudflare **Tunnel / Mesh / WAN**; HTTP + raw TCP. | **Could retire the public ingest tunnel.** Instead of exposing `ingest` on a tunnel hostname, a Worker reaches the home machine as a **VPC Service** (Worker → Tunnel → `127.0.0.1:8137`). The control plane never gets a public name; TCP also reaches Postgres through Hyperdrive. | **adopt (evaluate)** — revises REMOTE-LIVE + hosts plan |
| **MoQ (Media over QUIC)** | beta, free | Live media over QUIC; relays via dashboard/API; publish with `moq-rs` (`ffmpeg | moq-pub`), subscribe with `moq-sub`. | **Low-latency live** without ICY/HLS. But clients are the gate: `AVPlayer`/ExoPlayer don't speak MoQ, and Cloudflare's example is fragmented-MP4 **video**. Not a v1 replacement for the ICY mounts; a candidate for the **OBS→live video** path once clients exist. | **later** |
| **Observability + Notifications + Log Explorer** | GA | Logs, traces, alerts, telemetry export, dashboards. | **This is E4 (monitoring).** Alerts on Worker errors/latency, not on the Icecast mount (local). Pair with the existing mount watchdog; the edge half gets real alerting for free. | **adopt** — implements E4's edge half |
| **AI Search** | GA (billing Nov 1 2026) | Managed RAG: Workers AI + Vectorize + R2 + Browser Run; text + **image** embeddings, PDF OCR, 10 MiB files. **Audio/video ingestion "coming".** | Docs/help RAG now; a future **audio search** over the library — but **audio ingestion does not exist yet**, so it does not replace the D1 feature vectors we just shipped. | **adopt for docs; audio = later** |
| **Basin** (Catalog/SQL/Pipelines) | GA | Query Iceberg tables on R2 (SQL/DuckDB/Spark), no egress. | **Play-log / listener analytics** over R2 without a warehouse. Complements, not replaces, Supabase. | **later** |
| **K2** | new | Durable serverless **event stream**. | Play events, live on/off-air events, request events — a durable log vs ephemeral Queues. Useful when the listener app needs a feed. | **later** |
| **Workers KV Instant** | new | Sub-2 ms p99 reads (Quicksilver). | Cache now-playing / stream descriptor / config at the edge with KV's API. | **later** |
| **Python Workers** | GA | Python first-class; FastAPI/Django/Flask; PyEmscripten; Hyperdrive; Workers AI. | Lighter Python services at the edge. **Not torch** — Demucs still needs the Container. | **not now** |
| **Streamline** | open-source example | Workers + Durable Objects + a containerized media engine for continuous video pipelines. | The architecture for **OBS → Cloudflare (video)**: a durable pipeline in front of Stream, instead of a raw RTMP key. | **later** (video phase) |
| **Flagship** | new | Feature flags evaluated at the edge. | Gate the host/guest doors and the app's new surfaces during rollout. | **later** |
| **Monetization Gateway** | new | Charge visitors for APIs, MCP tools, pages, datasets. | Monetize the station API / catalogue later. | **later** |
| **Agents / Agent Memory / Clef models / Web Search API** | new | Agentic stack; **Clef/Clef-flash** are Cloudflare's open-source **decision models** on Workers AI. | A **decision model** could drive autopilot track choice (energy/transition decisions) — an alternative to hand-coded heuristics. Also an auto-DJ / curation agent. | **later (explore)** |

## Not relevant to NCSound

Cloudflare Mesh/WAN (only matters *through* Workers VPC), OHTTP Relay, Privacy
Pass, Key Transparency, Randomness Beacon (drand), Time Services, Privacy Proxy,
China Network, Multi-Cloud Networking — no bearing on a single-station radio +
listener app.

## What this revises in the plan

1. **Control plane (REMOTE-LIVE / HOSTS plan).** Workers VPC turns "expose ingest
   on `ingest.<domain>` over a tunnel" into "bind a VPC Service; the Worker reaches
   ingest privately." Lower exposure, no public control hostname. **C4** (Access)
   becomes optional for the control path if the VPC path is used.
2. **E4 monitoring.** Replace a bespoke edge-monitoring plan with Cloudflare
   **Observability + Notifications**. The mount watchdog stays local (Cloudflare
   can't see the Icecast internals).
3. **D1 (Vectorize) stands.** We shipped an audio-feature index; AI Search's
   audio ingestion is **not released**, so it is not a substitute today.
4. **Video (Streamline).** When the OBS→video phase happens, prefer the
   **Streamline** pattern (DO + media container) over a bare Stream key.
5. **MoQ stays a watch item**, not a v1 decision — client support is the blocker.

## Account state (measured 2026-10-07)

Read from the account (`a7ce29a9…1722`) with an API token.

| Product | Present |
|---|---|
| Workers | 16 scripts (incl. `ncsound-api`, `ncsound-transcode`) |
| R2 | `ncsound-media` (+ `overlayr2`, `oncology-papers`) |
| Vectorize | `brain-memory` (other), **`ncsound-tracks`** (ours, 32-dim) |
| D1 | `brain-memory`, `truth-chain-ledger` (other projects) |
| AI Gateway | `ecosystem`, `default` |
| AI Search | `overlay` (other project) |
| Stream | 1 live input (`ncsound-obs`, ours) |
| Cloudflare Images | default key |
| KV / Queues / Hyperdrive / MoQ relays | **none** |
| Workers VPC | endpoint not routable for this account/token (beta) — nothing provisioned |

So **AI Gateway and AI Search already exist** and can be reused for NCSound
without provisioning; **Hyperdrive, KV, Queues, MoQ and VPC are empty**.
Hyperdrive remains the missing piece for reading Postgres from a Worker.

## Sources (opened 2026-10-07)

- Everything we launched during Birthday Week 2026 —
  `blog.cloudflare.com/birthday-week-2026-wrap-up/`
- Workers VPC — `developers.cloudflare.com/workers-vpc/` (beta; Tunnel/Mesh/WAN;
  HTTP + TCP)
- Media over QUIC — `developers.cloudflare.com/moq/` (draft-14/16; `moq-rs`;
  fragmented-MP4 example; beta)
- AI Search GA — `blog.cloudflare.com/ai-search-ga/` (text + image embeddings,
  OCR, 10 MiB; audio/video "coming")
- Python Workers GA — `blog.cloudflare.com/python-workers-ga/`
- Worker Previews, Dynamic Workers, Artifacts (open beta), Clef models —
  `developers.cloudflare.com/changelog/`
- Product index — `developers.cloudflare.com/llms.txt`
