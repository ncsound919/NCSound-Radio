# Data & databases — plan and status

One register for every place NCSound stores data: what lives where, the schema
of record, and what is configured vs planned. Companion to
`CLOUDFLARE-INTEGRATION.md` (edge products) and
`MOBILE-LISTENER-APP-IMPLEMENTATION.md` (app data).

Principle: **each data domain has exactly one store of record.** No domain is
mirrored into two writable places.

---

## 1. The stores

| Store | What it holds | Access boundary |
|---|---|---|
| **SQLite + Prisma** (`apps/station-web/db/custom.db`) | the operator station: tracks, play logs, shows, sponsors, submissions, artists, requests, settings | private — server-side only, behind the admin cookie |
| **Supabase Postgres** (`xczjyhsibnjbjhpvtotx`) | listener identity: profiles, favorites, devices, push prefs | RLS — the app reads/writes as the signed-in user |
| **Cloudflare R2** (`ncsound-media`) | audio objects, (future) stems/artwork/waveforms | public media, catalogue via the `ncsound-api` Worker |
| **ingest process** (files + memory) | host/guest sessions (hashed), on-air intent, listener samples | loopback / tunnel-token |
| **browser (console)** IndexedDB | per-operator library, analysis cache, favorites | local device |
| **engine cache dir** (`NCSOUND_CACHE_DIR`) | decoded-analysis cache for the headless engine | local disk |

---

## 2. Domain-by-domain status

### 2.1 Operator station data — **built** (SQLite / Prisma)

- Schema of record: `apps/station-web/prisma/schema.prisma`.
- Models: `Artist`, `Submission`, `Sponsor`, `Campaign`, `AdPlay`, `Show`,
  `Track`, `PlayLog`, `TrackRequest`, `StationSetting`.
- **Configured this session:** schema and DB are in sync — `Track.isrc` +
  `Track.label` added (Reports of Use), the removed `RightsLog`/`rightsId`
  dropped, and the Prisma client regenerated (clearing a stale-client typecheck
  error). Snapshot: `db/custom.db.pre-dbplan-sync`.
- **Migration history (baselined this session):** the operator DB now uses
  `prisma migrate` — `prisma/migrations/0_init` (the baseline, marked applied
  without touching data) plus `20261007215118_track_request_user_id`. Future
  changes are reviewable files (`prisma migrate dev`), not inline destructive
  pushes.

### 2.2 Listener identity & social — **built** (Supabase Postgres)

- Project `NCSound Radio`, ref `xczjyhsibnjbjhpvtotx`, us-east-1.
- Tables: `profiles`, `favorites`, `devices`, `push_prefs`; **RLS on all four**,
  user-scoped; `on_auth_user_created` trigger; `on delete cascade` to
  `auth.users`. Source: `supabase/migrations/20261007_init_identity.sql`.
- **delete-account Edge Function deployed + verified:** created a throwaway
  user, signed in, called the function → user is `404` afterwards and their
  `favorites` row cascaded to `0` (App Store 5.1.1(v)).
- **`user_id` columns default to `auth.uid()`**
  (`supabase/migrations/20261007000100_user_id_defaults.sql`), so clients can
  omit them; RLS still enforces ownership.
- **Request attribution wired:** `POST /api/requests` verifies an optional
  Supabase JWT (`apps/station-web/src/lib/supabase-user.ts`) and stores
  `TrackRequest.userId`, falling back to `listenerName` for anonymous web
  listeners. Supabase URL + publishable key are server-side in `.env`.
- **Still open:** enable Apple + Google + email-OTP providers; the app uses the
  **publishable** key only (RLS is the boundary).

### 2.3 Media objects — **built** (R2)

- Bucket `ncsound-media`: 410 objects, public read, bucket CORS set.
- Catalogue + bytes via the `ncsound-api` Worker (`/library`, `/audio/<key>`).
- **Open:** stems/artwork/waveform prefixes when those exist; the transcode
  Container writes derived objects here later.

### 2.4 Analysis cache (track features, waveforms) — **built** (client + engine)

- The console caches analyses in IndexedDB (`analysisCache`); the headless
  engine caches under `NCSOUND_CACHE_DIR`. Not a server DB.
- **Open (phase 3):** to ship Vectorize "similar tracks", these features must be
  **produced server-side** (a Queue consumer or a console-publish with a
  server-held token) — this is the phase-3 blocker, unchanged.

### 2.5 Edge catalogue & embeddings — **planned** (Vectorize / Workers AI)

- Not configured. One index (dimensionality must match the chosen embedding).
- Blocked on 2.4's producer; do not create an empty index that implies a
  capability.

### 2.6 Edge control state — **built now, DO planned**

- Today: ingest holds on-air intent, listener samples, and live keys in memory
  (+ the sessions file). Works.
- Planned: Durable Objects (one per station) when the edge API serves
  now-playing / live keys, per `CLOUDFLARE-INTEGRATION.md` §5.

### 2.7 Host/guest sessions & audit — **sessions built, audit planned**

- Sessions: `SessionStore` (hashed, TTL, revocable), file-backed.
- Audit log: planned in `HOSTS-AND-GUEST-SLOTS-PLAN.md` P1 (append-only file, or
  a table) — not built.

### 2.8 Chat — **built** (transient)

- socket.io relay (`apps/station-web/mini-services/chat-service`); in-memory,
  not durable.

---

## 3. Cloudflare data products — measured

| Product | State |
|---|---|
| R2 | `ncsound-media` (this project). `overlayr2`, `oncology-papers` are other projects. |
| D1 | **none for NCSound.** (`brain-memory` / `truth-chain-ledger` in the roadmap belong to other projects.) |
| KV | none. |
| Hyperdrive | none. Needed only if a Worker queries Supabase Postgres. |
| Vectorize | only `brain-memory` (another project). |
| Queues / DO | none. |

**Decision:** NCSound uses **no D1 and no KV.** SQLite (operator) + Supabase
(listener) cover the relational needs; R2 covers objects. Add **Hyperdrive**
only if/when a Worker must read the operator Postgres, and **Vectorize/DO/Queues**
only when 2.4's producer and the edge API exist. Do not create unused infra.

---

## 4. The one open architectural fork

**Does the operator station move from SQLite to Supabase Postgres?**

- **Recommendation: not now.** The mobile plan already says keep SQLite and do
  not migrate the operator site as part of the app project
  (`MOBILE-LISTENER-APP-IMPLEMENTATION.md` §7). SQLite is the operator's private
  data on one machine; Postgres is for the multi-user listener app. Keeping them
  separate keeps the RLS surface small and the migration out of the critical
  path.
- **Migration path if/when chosen** (a distinct project, not a side task):
  1. `schema.prisma` datasource `sqlite` → `postgresql`; `DATABASE_URL` → the
     Supabase connection string (pooler for the app, direct for migrations).
  2. `prisma migrate` baseline + `db push`/`migrate deploy`; copy rows.
  3. Add **Hyperdrive** for Worker reads; keep Prisma in the Next app.
  - Risks: Prisma type mapping on SQLite→Postgres (e.g. `DateTime`, `Boolean`),
    unique/index parity, and the `db/` snapshots becoming stale.

---

## 5. Secrets (locations only)

| Secret | Location |
|---|---|
| Supabase URL / keys / DB password / PAT | `~/.config/ncsound/supabase.txt` (outside the repo) |
| Icecast / harbor passwords | `infra/icecast/.env` (gitignored) |
| Relay source/admin passwords | `infra/stream/.env` (planned, gitignored) |
| Cloudflare token | env `CLOUDFLARE_API_TOKEN` |
| R2 / transcode Worker tokens | Worker secrets |

Never commit any of these. `supabase.txt` holds the **service-role key** and a
`sbp_` token — full-power; keep them server-side only.

---

## 6. Status summary

| Domain | Store | Status |
|---|---|---|
| Operator station | SQLite/Prisma | **built**, synced, ISRC/label; `prisma migrate` baselined |
| Listener identity | Supabase | **built** (RLS); delete-account deployed + verified; requests attributed |
| Media | R2 | **built** |
| Analysis cache | IndexedDB / engine dir | built (client) |
| Edge embeddings | Vectorize | planned (blocked on a producer) |
| Edge control state | ingest memory → DO | built → planned |
| Sessions / audit | ingest file | sessions built; audit planned |
| Chat | socket.io relay | built |
| D1 / KV / Hyperdrive | — | none; add only on need |
