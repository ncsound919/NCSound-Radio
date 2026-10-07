# Public stream relay (VPS) — P0

The listener-facing Icecast. A **dumb relay**: the home Liquidsoap pushes its
two mounts here as a source client, and this VPS re-serves them over TLS.
Sequencing, failover, the harbor buffer and ICY titles all stay on the home
engine — nothing about `ncsound.liq`'s logic moves. See
`docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md` §4 (decisions **D9–D11**).

**Not Cloudflare.** Cloudflare's Service-Specific Terms bar serving a
disproportionate share of audio over the free CDN, and Cloudflare does not cache
ICY streams, so the listener host is this VPS on a **DNS-only** subdomain.

Files here:

| File | Purpose |
|---|---|
| `icecast.xml` | the relay config: TLS on 443, source on 8000, the two mounts |
| `.env.example` | the source/admin passwords + host + home IP (rendered into the config) |
| this file | the runbook |

---

## 1. Provision

A small VPS near the audience — **Hetzner** (EU) or **DigitalOcean/Vultr** (US),
1 vCPU / 1 GB, Debian or Ubuntu (D12). 100 concurrent at 128 kbps is roughly
500 GB/month, well inside any of these plans.

## 2. DNS

Create `stream.<domain>` as an **A record to the VPS IP**, **DNS-only** (grey
cloud — not proxied through Cloudflare). This is required for Let's Encrypt and
for the audio path, which must not traverse Cloudflare's CDN.

## 3. Firewall

- **80** — open (Let's Encrypt HTTP challenge).
- **443** — open (listeners + TLS status).
- **8000** — source upload; **allow only your home IP**. Everything else must
  not reach it. (`ufw allow from <home-ip> to any port 8000`, default deny.)

## 4. Run Icecast with TLS

Rendering the passwords first (whatever image you use):

```sh
cd infra/stream
set -a; . ./.env; set +a
sed -e "s/__ICECAST_SOURCE_PASSWORD__/${ICECAST_SOURCE_PASSWORD}/" \
    -e "s/__ICECAST_ADMIN_PASSWORD__/${ICECAST_ADMIN_PASSWORD}/" \
    -e "s/stream.example.com/${NCSOUND_STREAM_HOST}/" \
    icecast.xml > /home/icecast/config/icecast.xml
```

**Option A — the `icecast-ssl` image (D11, auto Let's Encrypt).**
Per <https://github.com/MediaRealm/icecast-ssl>: build the image, mount a config
dir and a `/etc/letsencrypt` dir owned by `nobody`, publish 80 and 443, then run
its `icecast-setup` on stdin to obtain the certificate for `stream.<domain>`:

```sh
docker build -t icecast-ssl . --file Dockerfile     # from the icecast-ssl repo
docker run -d --name icecast-ssl --restart unless-stopped \
  --mount type=bind,source=/home/icecast/config,target=/config/ \
  --mount type=bind,source=/home/icecast/letsencrypt,target=/etc/letsencrypt/ \
  -p 80:80 -p 443:443 -p 8000:8000 icecast-ssl
docker exec -it icecast-ssl /usr/bin/icecast-setup   # subdomain, confirm DNS, email
```
Match the image's config path and `<ssl-certificate>` path to the image you run
(the relay `icecast.xml` assumes `/etc/icecast2/bundle.pem`).

**Option B — `libretime/icecast:2.5.0` + certbot (documented paths).** Icecast
2.5.0 is SSL-capable; Debian/Ubuntu's packaged Icecast is not (licensing).
Obtain a cert (`certbot certonly`), concatenate it, and mount it:

```sh
cat /etc/letsencrypt/live/${NCSOUND_STREAM_HOST}/fullchain.pem \
    /etc/letsencrypt/live/${NCSOUND_STREAM_HOST}/privkey.pem \
    > /home/icecast/config/bundle.pem
docker run -d --name icecast-relay --restart unless-stopped \
  -v /home/icecast/config/icecast.xml:/etc/icecast2/icecast.xml \
  -v /home/icecast/config/bundle.pem:/etc/icecast2/bundle.pem \
  -e ICECAST_SOURCE_PASSWORD -e ICECAST_ADMIN_PASSWORD \
  -p 80:80 -p 443:443 -p 8000:8000 ghcr.io/libretime/icecast:2.5.0
```

Add a cert **renewal** hook that re-concatenates the PEM and restarts the
container, or the stream's TLS will expire in 90 days.

## 5. Point the home source at the relay (push)

In `infra/liquidsoap/ncsound.liq`, the two `output.icecast(...)` blocks currently
target `host="127.0.0.1", port=8010`. Change both to the relay:

- `host="stream.<domain>"`, `port=8000` (plain source port, IP-restricted), or
  `port=443` with Icecast's source TLS if the image accepts sources on the TLS
  socket — **confirm the exact Liquidsoap 2.2 TLS option against the docs**
  before relying on it; the IP-restricted 8000 path is the low-risk default.
- `password=getenv("ICECAST_SOURCE_PASSWORD")` must equal the relay's source
  password. Consider a distinct `RELAY_SOURCE_PASSWORD` for the home→relay leg.

Nothing else in `ncsound.liq` changes: the harbor mounts, the fallback chain,
the dead-air filler and the `icy_song` callback stay as they are.

## 6. Point the station's listener counts at the relay

Public counts must come from the Icecast the listeners actually connect to. On
the ingest process set:

```
ICECAST_STATUS_HOST=stream.<domain>
ICECAST_STATUS_PORT=443
ICECAST_STATUS_TLS=1
ICECAST_STATUS_USER=admin
ICECAST_STATUS_PASSWORD=<the relay admin password>
```

The code already supports this (`packages/ingest/src/icecast.ts` +
`main.ts`, decision D10); leave them unset to keep polling the home `:8010`.

## 7. station-web

Set the public stream base so `GET /api/stream` and the web player use the
relay:

```
NEXT_PUBLIC_STREAM_BASE_URL=https://stream.<domain>
# or the server-only NCSOUND_STREAM_BASE_URL
```

`GET /api/stream` then returns `{ baseUrl, live, mobile, hls, updatedAt }` with
the real absolute URLs.

## Acceptance (P0)

- `curl -I https://stream.<domain>/live.mp3` and `/mobile.mp3` → `200` with a
  valid TLS chain.
- A phone on **cellular** plays both mounts.
- `GET /api/stream` returns the two real URLs.
- Pulling the home source does **not** 404 the listener (the relay holds the
  mount; the home `ncsound.liq` failover still governs what is *in* it).
- Listener counts in the station UI come from the relay (step 6), not `:8010`.

## Still open

- **The domain** for `stream.<domain>` (the only unresolved input).
- Region/provider pick (D12).
- Whether the home→relay source leg is TLS or an IP-restricted plain port.
