# Split & handoff — two agents, zero overlap

Divides `docs/ROADMAP-TO-READY.md` into two workstreams that touch **disjoint
paths**, so two agents can work at once without merge conflicts. Read the
roadmap first; this file says who does what and how not to step on each other.

**Recommended assignment:** Agent A = station/delivery/operators (this session's
context); Agent B = listener app + Supabase.

---

## Step 0 — do this before splitting (Agent A)

The tree is very large and mostly uncommitted. **Commit the current baseline on
`main` first**, then each agent branches. Without this, "our work" is undefined
and neither agent can rebase.

```
# Agent A, on main
git add -A
git commit -m "checkpoint: station, console, workers, supabase identity, plans"
```

Then: **Agent A works on `station/*`; Agent B works on `app/*`.** Each opens PRs
into `main`; A owns merges of `main`.

---

## Ownership (do not edit the other's paths)

| Path | Owner |
|---|---|
| `apps/station-web/**` | **A** |
| `apps/dj-console/**` | **A** |
| `packages/ingest/**`, `packages/dj-engine/**` | **A** |
| `packages/station-core/**` | **A** (frozen for B — see contract) |
| `workers/ncsound-api/**`, `workers/ncsound-transcode/**` | **A** |
| `infra/**` (icecast, liquidsoap, stream, scripts) | **A** |
| `docs/ROADMAP-TO-READY.md`, station/ops docs | **A** |
| root `package.json`, `bun.lock`, `.gitignore`, `tsconfig` | **A** |
| `packages/station-client/**` (new) | **B** |
| `apps/listener-app/**` (new) | **B** |
| `supabase/**` | **B** |
| `infra/cloudflare/**` (new, Access/WAF scripts) | **B** |
| `docs/MOBILE-LISTENER-APP-*.md` | **B** |

Rule: if you need a change on the other side, request it in a PR comment — do
not edit the file.

---

## Frozen contract (changes need both agents' agreement)

- **`packages/station-core` types** — the shared domain contracts
  (`BroadcastStatus`, `LiveSnapshot`, `TrackAnalysis`, the JSON response shapes).
  B's `station-client` and the RN app depend on them. Additions are fine;
  renames/removals must be coordinated.
- **station-web HTTP API** (`apps/station-web/src/app/api/**`, shapes in
  `src/lib/station-types.ts`) — A owns; **changes must be additive**. B consumes
  `/api/nowplaying`, `/api/schedule`, `/api/requests`, `/api/tracks`,
  `/api/artists/detail`, `/api/charts`, `/api/history`, **`/api/stream`**.
- **Supabase schema** (`supabase/`) — B owns. A does not touch it.

---

## Agent A — station, delivery, operators

Ordered; each with acceptance. Blockers noted.

| # | Task | Accept | Blocker |
|---|---|---|---|
| A0 | Commit the baseline; branch `station/*`; own `main` merges | clean `git status`, typecheck green | — |
| A1 | Restart home Icecast (apply the `<mount-name>` fix) | `/status-json.xsl` lists both mounts with settings | — |
| A2 | Provision VPS relay: DNS-only `stream.<domain>`, firewall, run `infra/stream/` | `curl -I https://stream.<domain>/live.mp3` → 200 + TLS | **domain + VPS acct** |
| A3 | Home→VPS source push (`ncsound.liq`); ingest status env; `NEXT_PUBLIC_STREAM_BASE_URL` | phone on cellular plays both mounts; counts from relay | A2 |
| A4 | Host/guest console doors (host build adds `/requests`); serve behind a tunnel hostname | host/guest can load their door, owner-only routes unreachable | A2 |
| A5 | Host/guest **slot windows + audit** in ingest (`Session.notBefore/notAfter`, `producer`, audit log) | arming outside a window is refused; audit rows appear | — |
| A6 | Station-web **Shows & Slots** roster that mints slot-bound sessions | a slot mints a working, time-bounded session | A5 |
| A7 | **Vectorize** producer (Queue consumer or console-publish with a server-held token) + index + `/similar` | "similar tracks" returns neighbours for a real track | — |
| A8 | `ncsound-api` gating decision (`LIBRARY_TOKEN`) | documented; enforced if chosen | — |
| A9 | Ops/release: backups, mount monitoring, **CI** pipeline (typecheck + tests + checks), rotate the OBS password + Stream key, delete `.history-backup-pre-scrub.bundle` | CI red/green on a PR; secrets rotated | — |

A's turnstile/WAF work on the public **request form** (`apps/station-web`) is
also A's, once it exists.

---

## Agent B — listener app + Supabase

Ordered; each with acceptance. B does **not** edit station-web, ingest, the
console, or the workers.

| # | Task | Accept | Blocker |
|---|---|---|---|
| B0 | Branch `app/*` from the committed baseline | clean tree | A0 |
| B1 | `packages/station-client` — typed fetch client over the station-web API, validated with `station-core` schemas | unit tests against a mock server pass | — |
| B2 | Supabase auth: enable **Apple + Google + email OTP**; app deep-link config (`delete-account` already deployed) | a real sign-in round-trips on device | **Apple/Google creds** |
| B3 | RN scaffold: bare RN, New Architecture, `react-native-track-player`; background/lock, reconnect, data saver, sleep timer | audio survives lock/app-switch on both OSes | B2 |
| B4 | Screens: Home / Player / Schedule / Requests / Settings / Sign-in; favorites + devices wired to the live tables | favorites sync across two devices | B3 |
| B5 | Push: FCM + APNs, populate `devices`/`push_prefs`, Edge Function sender | a followed-artist-on-air notification arrives | — |
| B6 | Car: **request CarPlay entitlement early**; RNTP browse/play; Android Auto in v1.1 | browse + play from a car | **Apple approval** |
| B7 | Store gates: `PrivacyInfo.xcprivacy`, App Privacy, demo account, privacy/support URLs, screenshots | both builds reviewed | B6/B2 |
| B8 | Cloudflare **Access** for the host/guest doors B is NOT serving (A serves them) — **coordinate hostnames with A**; **Turnstile** where the listener submission form needs it (request via A) | allowlisted email gets in; others blocked | **Access enabled** |

Legal (SoundExchange + PRO, ISRC population) is a shared **before-public-launch**
gate, owned by the human, not either agent.

---

## Coordination rules

1. **One branch per workstream**, PRs into `main`; A merges.
2. **Never edit the other's paths.** Need a change there → PR comment.
3. **Lockfile:** A owns `bun.lock`. B adds deps under its own new packages; if the
   lockfile conflicts, B rebases and regenerates (`bun install`) — never hand-merges.
4. **Run the full repo typecheck** (`bun run typecheck`) plus the relevant check
   scripts before every PR.
5. **Additive-only** to `station-core` and the station-web API; coordinate
   anything else.
6. `docs/`: A owns the roadmap/station docs; B owns the mobile docs. No shared
   file.

---

## What is already done (neither agent redoes)

Stream config + `/api/stream`; CORS; ISRC/label; Prisma migration baseline;
Supabase identity (RLS, delete-account verified, request attribution);
`ncsound-api` + `ncsound-transcode` (gated) + R2; Cloudflare subdomain + Stream
live input; console OBS start/stop + OBS→Stream + loudness/normalise; the
Icecast mount fix; full repo typecheck green.
