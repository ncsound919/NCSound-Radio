# Hosts & guest DJ slots — access plan

Status: **plan** (nothing here is built unless marked). Companion to
`docs/REMOTE-LIVE.md` (tunnel model) and `docs/CLOUDFLARE-INTEGRATION.md`.

Goal in one line: **let a morning-show team and scheduled guest DJs run
their slots on the station without ever holding full station access**, and make
that safe to operate (identity, scope, time windows, revocation, audit).

---

## 1. The two populations

| Who | Cadence | Needs | Must not have |
|---|---|---|---|
| **Morning show** (a small recurring team: co-hosts + a producer) | same weekly slot(s), repeated | talk (mic), play/mix music, take requests, play imaging, go live and hand back | ops/automation control, other people's access, the master credential, sponsor/submission/finance data |
| **Guest DJ** (one-off or recurring) | a specific booked slot | go live, play music, maybe take requests | everything above, and only *during* their window |

The owner (you) keeps everything: kill anyone mid-show, mint/revoke, touch
automation, see the books.

> Terminology note: this plan is about *roles and slots*, not identity traits.
> The morning-show team is modeled exactly like any other host group.

---

## 2. What "full station access" actually is (the owner-only core)

Anything here that a host/guest can reach is a breach:

1. **The ingest master token** (`INGEST_TOKEN`) — grants every command, every
   read (including `/requests` with listener names and `/crate`), and
   `/sessions`, `/live/kill`, `/live/unlock`.
2. **Ops control commands** — `transport.stop/offAir`, `mix.panic`,
   `mix.setMasterGain`, `autopilot.*`, `library.*`, `sync.*`, `scratch.*`
   (`packages/ingest/src/permissions.ts` already denies these to host/guest).
3. **The station owner's access plane** — minting/revoking sessions,
   `/sessions`, `/live/kill`, `/live/unlock`.
4. **The station-web admin cookie** (`ncsound_admin`) and everything behind it:
   submissions review, sponsors, ad-sync, library sync, stats.
5. **Infra secrets** — Icecast/Liquidsoap/harbor passwords, the OBS websocket
   password, the Cloudflare Stream key, the R2/Worker secrets, the tunnel
   credentials.

---

## 3. What already exists (the foundation — build on this, don't replace it)

You have a real, minimal multi-user layer in `packages/ingest`:

- **Scoped, expiring sessions.** `SessionStore` issues `host`/`guest` bearer
  tokens with a TTL (capped 24 h), a `canLive` flag and revocation; only the
  SHA-256 of a token is stored, in memory and (optionally) in a file —
  `packages/ingest/src/sessions.ts:19-30, 36, 50-84, 120-129`.
- **Deny-by-default role allowlists.** `host` may steer the rotation
  (`imaging.play`, `cue.request`, `cue.track`, `mix.skip`, `mix.mixNext`);
  `guest` may only `imaging.play` + `cue.request`; anything not listed is
  refused — `packages/ingest/src/permissions.ts:19-42`.
- **Server-side enforcement, not UI hiding.** A caller's identity comes from
  the token, never the request body (spoofing is refused); reads are scoped by
  role; owner-only routes 403 for sessions; a live key is bound to the person
  who armed it; revoking or expiring a session drops them off the air. Pinned
  by `packages/ingest/test/multiuser.test.ts` (see the "guest cannot claim a
  higher role", "live key belongs to the user", "a lapsed session loses the
  air" cases).
- **Console identity by invite link.** The token rides in the URL fragment,
  is moved to `sessionStorage`, stripped from the address bar, and sent as a
  bearer; the UI only *hides* what ingest will refuse —
  `apps/dj-console/src/app/session.ts:41-67, 78-85, 93-115`.
- **Owner mint/revoke UI.** `apps/dj-console/src/ui/views/invites.ts`
  (role = Guest DJ / Morning show host, TTL 2/4/8/24 h, "may go live",
  revoke) calls ingest `/sessions`.
- **A separate guest door.** `vite.guest.config.ts` serves the same console
  build with **no master-token injection** and an explicit path allowlist
  (`/ingest/(whoami|status|health|imaging|requests|command|ws|live|live/arm)`)
  so owner-only routes are unreachable from the public door even with a stolen
  master token — `apps/dj-console/vite.guest.config.ts:34-46`; run with
  `npm run guest`.
- **Tunnels already exist** on `overlay365.com` (`~/.cloudflared/config.yml`),
  and `docs/REMOTE-LIVE.md` defines the ingest tunnel + 401 acceptance test.

This is a strong base. The plan is mostly closing five gaps on top of it.

---

## 4. Gaps to close

| # | Gap | Evidence |
|---|---|---|
| G1 | **Identity is a bearer in a URL**, not a login. Whoever holds the link *is* that person; no per-person sign-in for recurring staff; a forwarded link is a leak. | `session.ts:41-58` |
| G2 | **No slot window.** TTL is flat 2/4/8/24 h; a "morning show" 4 h invite works at 3 am. No link to a show or time-of-day. | `sessions.ts:50-51`; `invites.ts:75-82` |
| G3 | **The guest console is not deployed anywhere reachable**, and there is no separate *host* build (hosts get the same guest UI). | no deploy config; `vite.guest.config.ts` only |
| G4 | **No audit.** Nothing records who armed, who played what, who was revoked when. | no audit store |
| G5 | **Coarse roles.** Only host/guest. No "producer" (requests + imaging, never live), no per-show scoping. | `permissions.ts:19-28` |
| G6 | **Security prerequisites on the public site** (see §7). | verified below |
| G7 | **Console wiring pending**: the ffmpeg container (`/loudness`, `/transcode`) and OBS→Cloudflare Stream are not surfaced in the console. | this session's work |

---

## 5. Options for the identity layer

| Option | What it is | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Extend ingest sessions only** | Keep invite-link bearer + roles; add slot windows | smallest change; matches the codebase | a link is a person; no audit identity | necessary, not sufficient |
| **B. Cloudflare Access outer gate + existing sessions** | Enable Zero Trust Access on the operator hostnames (email OTP + email/domain policies + rule groups); keep ingest sessions for command scope | real per-person identity, Access audit logs, no new app DB, free ≤50 users, fits the existing tunnels | one more vendor surface; needs Access enabled (currently 403 "not enabled") | **recommended** |
| **C. Supabase Auth + RLS** | Real accounts, magic-link/OAuth, roles/rows in the DB, RLS | strongest identity + self-service + audit; matches the planned Supabase move | the app is SQLite today — a migration + new dependency | upgrade path, not now |
| **D. Managed IdP (Clerk/Auth0)** | Hosted login with orgs/roles | fast, polished | another bill; still needs the command-scope layer; overkill for <50 people | no |

**Recommendation: B layered on A.** Cloudflare Access answers "may this person
load an operator console at all, and who are they?"; the ingest session answers
"what may they *do*?". C stays on the roadmap if/when station-web moves to
Supabase.

Cloudflare Access facts this rests on (vendor primary docs, `cited`):
- OTP email login with policies keyed on `Emails` / `Emails ending in`, and
  **`Require` rule groups** for AND/OR combos
  (`developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/`).
- OTP must be paired with an email allowlist or anyone with an email gets in
  (`.../identity-providers/one-time-pin/`).
- Service tokens / Service Auth for machine access, and
  `Access: Organizations, Identity Providers, and Groups Write` for
  provisioning (`.../integrations/identity-providers/`).

---

## 6. Recommended architecture (four layers)

```
                     ┌──────────────────────── Cloudflare Access (L1) ───────────────────────┐
 owner / host / guest │  email-OTP (or Google)  -> policy: who may load THIS console hostname │
                     └───────────────────────────────┬───────────────────────────────────────┘
                                                     ▼
   owner console (full)        host console (reduced)        guest console (minimal)
        │                            │                            │
        │  (L2) ingest session: role + slot window + canLive ───────┘
        ▼
   ingest 127.0.0.1:8099  ──► ffmpeg ──► Liquidsoap "live" ──► Icecast
        │
        └─ (L3) live key: single-use, 60 s, owner-bound, one live source at a time
             (L4) owner kill switch: /live/kill, /sessions/revoke -> off air + close socket
```

- **L1 Identity & entry (Access).** Access policies on three hostnames so the
  *door* is per-person, not per-link:
  - `guest.overlay365.com` → guest console. Policy: Allow `Emails` = the
    booked guest's address (or a temporary list), Require `Login method:
    One-time PIN`.
  - `host.overlay365.com` → host console. Policy: Allow the morning-show
    group (a rule group of emails), Require email domain / OTP.
  - `ingest.overlay365.com` → ingest. Machine-only: Service Auth token from the
    console servers; **never** a user login.
- **L2 Role scope (ingest sessions).** Unchanged mechanics, extended with a
  **slot window** and (optionally) a `showId`, plus a `producer` role. The
  server enforces the window on `/live/arm` and on non-`query.*` commands.
- **L3 Live-slot control.** Already correct: one live source, a single-use key
  bound to the arm-er, expiry/revoke drops the feed, autopilot resumes. Add a
  maximum live duration per session for guests.
- **L4 Owner kill switch.** `/live/kill` + `/sessions/revoke` (existing),
  surfaced prominently, plus an audit row.

### Identity → role mapping (pragmatic now, clean later)

- **Now:** the owner mints a session per person (host) or per slot (guest) as
  today, but longer-lived for recurring hosts (e.g. 30 days needs a TTL cap
  bump or a refresh). Access limits *who can load the console*; the session
  limits *what they can do*. Two independent factors.
- **Better (next):** a tiny token broker that exchanges a validated Access JWT
  (`Cf-Access-Jwt-Assertion`, verified against Cloudflare's JWKS) for an ingest
  session, so recurring hosts never hold a URL link. This needs `jose` + a
  JWKS fetch, or a Worker that calls ingest `/sessions` with the master token
  held server-side.

---

## 7. Security prerequisites (do first; verified this session)

These are real, present today, and directly relevant to "don't give people
access to more than their slot":

1. **`GET /api/submissions/[id]` has no auth and returns the full submission
   DTO** (email, `agreementIp`, notes, review notes, file name). The list route
   is admin-gated; the by-id route is not — an IDOR on the public site.
   `apps/station-web/src/app/api/submissions/[id]/route.ts:18-31` (verified).
2. **`GET /api/stats` has no auth** and returns MRR, submission pipeline and
   readiness internals — `apps/station-web/src/app/api/stats/route.ts:32`.
3. **`GET /api/adplays` has no auth** — proof-of-play with sponsor/campaign
   names (`apps/station-web/src/app/api/adplays/route.ts:13`).
4. **Worker gating (P0 — done).** The transcode Worker was reachable and
   ungated **in production** (verified: `POST /loudness` returned 200 with no
   token). It now requires `TRANSCODE_TOKEN`: fail-closed `503` when the secret
   is unset, `401` on a bad token, `405` on a non-POST work route — verified
   `401` without and `200` with the token. `ncsound-api` is **deliberately left
   open**: it serves the same public media the `r2.dev` bucket already exposes
   (its `LIBRARY_TOKEN` gate is fail-open by default). Set `LIBRARY_TOKEN` as
   well if the catalogue itself should stop being public.
5. **Cloudflare Access is not enabled** on the account (API returned
   "Access is not enabled") — enabling it is a one-time dashboard step.

---

## 8. Concrete changes

### ingest (`packages/ingest`)
- Extend `Session` (`sessions.ts:21-30`) with: `notBefore`, `notAfter`
  (ISO), `showId?`, `email?` (Access identity), `maxLiveMinutes?`.
- Enforce the window in the `/live/arm` path and the command dispatcher
  (alongside `rolePermits`); report "outside your slot" clearly.
- Add `producer` to `SessionRole` and to `permissions.ts` (requests + imaging,
  never live) if the morning-show producer needs it.
- Append an **audit log** (actor id/label/role, action, at, result) — a small
  append-only file mirroring the sessions file, or rows in station-web later.

### dj-console (`apps/dj-console`)
- A **host build** (like `vite.guest.config.ts`) whose allowlist adds
  `/requests`, and a **guest build** as today. Gate the invite panel so it only
  shows in the owner build.
- Show the caller's role + slot + time-left in the top bar; refuse
  out-of-slot arming client-side as a courtesy (server still enforces).
- **Console wiring (G7) — done.** Library rows have **LUFS** (measure EBU R128
  loudness) and **Norm** (download a normalized MP3) actions; both call the
  ffmpeg Container through the console server's `/transcode` proxy, which
  injects the Worker token (never in the page). Settings gained **Cloudflare
  Stream (OBS → Stream)**: enter the RTMPS server + live-input key and **Send to
  OBS** (`SetStreamServiceSettings` via obs-websocket). Verified: `/transcode`
  round-trip returns LUFS; OBS flips to `rtmp_custom` @
  `rtmps://live.cloudflare.com:443/live/`.

### station-web (`apps/station-web`)
- Fix §7.1–3 (add `requireAdmin` to `GET /api/submissions/[id]`; gate `/api/stats`
  and `/api/adplays` or trim their payloads).
- Later: a **Shows & Slots** roster (the `Show` model already has
  `dayOfWeek/startHour/durationMin/kind` — `prisma/schema.prisma:93-107`) that
  mints slot-bound sessions.

### Cloudflare
- Enable Zero Trust Access; create identity provider (OTP) + three Access apps
  + policies/rule groups (`Access: … Write` scope on the API token).
- Add tunnel ingress hostnames (guest/host/ingest) to `~/.cloudflared/config.yml`.
- Add a bearer token to the transcode Worker (and decide ncsound-api gating).
  **[done]** the transcode Worker is `TRANSCODE_TOKEN`-gated; `ncsound-api` stays
  open by decision (public media).
- **Workers VPC (2026, beta):** the lower-exposure control-plane option — bind
  home ingest as a **VPC Service** so a Worker reaches it privately; then
  **Access is optional** for the control path. Reuse the existing AI Gateway /
  AI Search in the account. See `docs/REMOTE-LIVE.md` + `docs/CLOUDFLARE-NEW-2026.md`.

---

## 9. Flows

**Morning show (recurring).** Owner sets a rule group of the team's emails and
a `host.overlay365.com` Access policy; mints a session per co-host bound to the
show's weekly window. On show day each co-host loads `host.overlay365.com`,
passes Access OTP, gets a host session; one arms the live feed; the producer
(if any) has `producer` scope. Outside the window, arming is refused.

**Guest DJ slot.** Owner books a slot and mints a guest session
`notBefore..notAfter` with `canLive`, then adds the guest's email to the
`guest.overlay365.com` Access policy for the day. Guest loads the door, passes
OTP, goes live for their window. At `notAfter`, ingest drops the feed and
autopilot resumes (already the behavior for a lapsed session).

**Mid-show revocation.** Owner hits revoke → `/sessions/revoke` closes the
socket and takes them off air (`multiuser.test.ts` "Revoking A while live drops
them off the air"); autopilot takes over. Add the audit row.

---

## 10. Rollout phases & acceptance

- **P0 — Prereqs.** Fix §7.1–4; enable Access. *Accept:* by-id submission
  401s unauthenticated; stats/adplays gated; transcode rejects a tokened-off
  caller.
- **P1 — Slot windows + audit** in ingest (`sessions.ts`, service). *Accept:*
  a session armed before/after its window is refused; audit rows appear.
- **P2 — Host/guest doors behind Access.** Deploy the two console builds
  (Pages or a tunnel hostname), add Access apps + policies. *Accept:* loading
  the host door from a non-allowlisted email is blocked; allowlisted gets in;
  the guest door cannot reach `/sessions` (allowlist) even with a stolen token.
- **P3 — Console wiring.** Loudness/transcode + OBS→Stream, role-aware.
  *Accept:* a host can measure a track's LUFS and start the OBS stream; a guest
  cannot reach owner-only controls.
- **P4 — (optional) Access-JWT→session broker**, so recurring hosts stop
  holding links. *Accept:* a host with no invite link gets a scoped session from
  their Access identity.

**P0 status (2026-10-07): done except Access enablement.** `/api/submissions/[id]`
now `requireAdmin`; `/api/stats` returns a public projection (listeners +
library) to non-admins and the full rollup to admins; the transcode Worker is
token-gated (`TRANSCODE_TOKEN`, fail-closed) and verified `401` without / `200`
with. `/api/adplays` is **left public by design** (it backs the public Sponsors
tab, like `/api/sponsors`). Enabling Cloudflare Access remains.

---

## 11. Open questions (decisions you need to make)

1. **One live source at a time.** The station has a single mount, so two
   co-hosts can't both go live; do additional hosts act as producers (requests/
   imaging) while one is on the mic? This decides whether `producer` exists.
2. **Guest machines.** Do guests run the console on their own laptops (needs a
   public hostname + Access) or on a studio machine (needs only local scope)?
3. **TTL for recurring hosts.** 24 h cap is too short for weekly staff; raise
   the cap, or add the Access-JWT broker (P4)?
4. **Consent/recording.** Guest slots imply recorded listen-back
   (`/api/shows/listenback`); do guests get a copy, and is there a consent line?
5. **Which domain.** `overlay365.com` tunnels exist; do the radio doors live
   there (`host/guest/ingest.overlay365.com`) or on a radio-specific domain?
6. **Supabase now or later.** Station-web is SQLite; the Cloudflare plan wants
   Postgres. This plan works either way, but a DB move changes P1/P4 storage.
