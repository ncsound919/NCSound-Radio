# Going live from a club (remote live)

The station runs on the home PC: Icecast, Liquidsoap, ingest (the engine). From a club you run the DJ console on your laptop, and it reaches ingest through a Cloudflare Tunnel. Only ingest goes through the tunnel. Icecast's source port, the harbor (8008) and Liquidsoap's telnet (1234) never leave the home PC.

```
laptop browser ──► console server (vite, 127.0.0.1:3102, holds INGEST_TOKEN)
                         │  https / wss, Authorization: Bearer …
                         ▼
                 Cloudflare Tunnel  ingest.<your-domain>
                         │
home PC          ingest 127.0.0.1:8099 ──► ffmpeg ──► Liquidsoap harbor "live" ──► Icecast
```

## What protects it

> **This tunnel carries the control plane, not the listener stream.** It moves
> the DJ console's commands and its live audio *upload* to ingest on the home
> PC. It does **not** serve the public stream: Cloudflare's Service-Specific
> Terms bar pushing a disproportionate share of audio over the free CDN, and
> Cloudflare does not cache ICY streams, so listeners are served by a **VPS
> Icecast relay over TLS on a DNS-only subdomain** instead. See
> `docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md` §4 (decisions D9–D11).

- **ingest treats anything that came through the tunnel as remote.** cloudflared connects from 127.0.0.1, so by peer address the whole internet would look local. ingest checks the proxy headers Cloudflare adds (`cf-connecting-ip`, `cf-ray`, `x-forwarded-for`, `x-real-ip`, `forwarded`):
  - With no `INGEST_TOKEN` set, every tunnelled request is refused (401) except `/health`.
  - With a token, every tunnelled request needs `Authorization: Bearer <token>`, reads included, because `/requests` carries listener names.
  - Crate audio is never served through the tunnel, even with the token.
  - Covered by `packages/ingest/test/remote-auth.test.ts`.
- **The token never reaches the browser.** The console's own server (vite) reads `INGEST_TOKEN` from its environment and adds the header to every proxied request, WebSocket upgrades included. ingest accepts the bearer on the upgrade in place of the token in the frame.
- **Each live session needs its own key.** It is single use, expires after 60 s, and is issued at Arm.
- **ingest still checks Origin on what the proxy forwards**, so a foreign web page that reaches your laptop's console port is refused.

## Home PC (once)

1. Pick a long random token and give it to ingest:
   ```
   INGEST_TOKEN=<64 hex chars>      # e.g. node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   ingest stays bound to 127.0.0.1. Do not bind it to 0.0.0.0; the tunnel is the only way in.
2. Make sure `LIVE_HARBOR_PASSWORD` is in `infra/icecast/.env`. `station-up.sh` fails closed without it.
3. Create the tunnel (cloudflared is already installed):
   ```
   cloudflared tunnel login
   cloudflared tunnel create ncsound-ingest
   cloudflared tunnel route dns ncsound-ingest ingest.<your-domain>
   ```
   `%USERPROFILE%\.cloudflared\config.yml`:
   ```yaml
   tunnel: <tunnel-UUID>
   credentials-file: C:\Users\User\.cloudflared\<tunnel-UUID>.json
   ingress:
     - hostname: ingest.<your-domain>
       service: http://127.0.0.1:8099
     - service: http_status:404
   ```
   Run it with `cloudflared tunnel run ncsound-ingest`, or install it as a service with `cloudflared service install`. WebSockets pass through Cloudflare by default.
4. Check it from your phone's mobile data. `https://ingest.<your-domain>/status` must answer **401**. If it answers 200, stop: the token isn't set.

## Laptop at the club

```
cd apps/dj-console
INGEST_URL=https://ingest.<your-domain> INGEST_TOKEN=<same token> npm start
```
On Windows PowerShell: `$env:INGEST_URL="https://…"; $env:INGEST_TOKEN="…"; npm start`.

Open `http://127.0.0.1:3102`, switch to **Radio**, open **Broadcast**, then press **Go live**. Preflight shows each check:

- "ingest requires a token…" means `INGEST_TOKEN` is missing or wrong on the laptop.
- "origin not allowed" means you opened the console on a non-loopback address. Use 127.0.0.1, or add that origin to `INGEST_ALLOWED_ORIGINS` on ingest.

## Bandwidth

192 kbps Opus needs about 250 kbps of sustained upload. If **Queued s** climbs or **Behind s** keeps rising, the uplink can't keep up: hand back, pick **128 kbps**, and go live again. After 3 s behind, the console treats it as a drop and the station falls back to autopilot by itself.

## What has and hasn't been tested

- **Tested locally:** a real Icecast 2.4.4, Liquidsoap 2.0.2 and ingest, with the console in Chromium. Takeover, hand-back, a dropped socket, a stalled feed and the delay are measured; see `REDESIGN-PLAN.md` (Phase 5, station chain).
- **Tested:** the tunnel auth rules (header-based, in `remote-auth.test.ts`), and the token held only by the console server (`live-check` with ingest requiring a token).
- **Not tested:** a real Cloudflare Tunnel and a real venue network. Do the step-4 check, then one test broadcast from mobile data before the gig.
