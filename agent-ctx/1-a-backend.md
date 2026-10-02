# Task 1-a — Backend API routes + broadcast engine

Agent: backend (Z.ai Code) · Status: COMPLETE

## Files owned / created
- `src/lib/broadcast.ts`
- `src/app/api/nowplaying/route.ts`
- `src/app/api/history/route.ts`
- `src/app/api/schedule/route.ts`
- `src/app/api/submissions/route.ts`
- `src/app/api/submissions/[id]/route.ts`
- `src/app/api/rights/route.ts`
- `src/app/api/rights/[id]/route.ts`
- `src/app/api/sponsors/route.ts`
- `src/app/api/adplays/route.ts`
- `src/app/api/ops/ad-sync/route.ts`
- `src/app/api/stats/route.ts`

No other files touched. `src/lib/station-types.ts` unchanged (imported, never extended).

## Contract status
All 11 endpoints implemented exactly to `station-types.ts`. All routes: `dynamic = 'force-dynamic'`, zod-validated mutations, try/catch → 500 JSON, 404-safe dynamic routes, Next 16 `params: Promise<{id}>` convention.

## Key implementation notes for other agents
- **Nowplaying** is deterministic from wall clock (anchor 2025-01-01Z, slot = duration + 12s gap, non-Imaging tracks by seedOrder). Poll-friendly: 60s rotation cache, one idempotent PlayLog insert per slot (unique trackId+playedAt, P2002 swallowed). Song history fills as it's polled.
- **Submissions POST** accepts JSON *and* multipart/form-data (optional `file` ≤15MB, metadata only). `agreementAccepted` must be literal true else 400 "Agreement must be accepted". Returns HTTP 201.
- **APPROVED pipeline** auto-issues `RightsLog` id `R{String(n).padStart(4,'0')}` where n = max numeric suffix of `/^R\d+$/` ids ≥ 100, +1 → `R0100` on a clean library. Note: seeded `R9001/R9002` demo rows push the next id to `R9003` (per contract's "max ≥ 100" rule).
- **ad-sync** is idempotent: even 24h spread of `spotsPerDay` slots (hash-offset), 90s-tolerance dedupe + P2002 swallow. Second run inserts 0.
- **playsToday** counters use America/New_York local midnight (DST-safe via `Intl` longOffset), not UTC.
- Deviations (minor): `socials` maps to `Artist.instagram` on artist upsert; `adplays` total/last7Days respect the `campaignId` filter when present.

## Verification
- `bunx tsc --noEmit`: **0 errors in all owned files** (remaining project errors live in `examples/`, `skills/`, and `src/components/station/app-shell.tsx` — Tasks 2-a/2-b territory).
- ESLint: clean on all owned files.
- Every handler smoke-tested directly via bun (JSON + FormData paths, 400/404 cases, APPROVED rights issuance, rights PATCH round-trip, ad-sync idempotency, stats/sponsors/adplays shapes). Test rows deleted afterwards — DB back to seed state.

## Known environment note
While `app-shell.tsx` imports not-yet-created components, Next dev serves its compile-error page for **all** requests (including `/api/*`) — this is a dev-server-wide gate, not a backend bug; it self-resolves when Task 2-a/2-b component files land.
