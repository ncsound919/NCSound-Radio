# NCSound Radio — deployed runbook

- **Deployed:** 2026-10-11 · **Host:** Ubuntu (WSL2) on the operator's PC, via `infra/station-up.sh`
- **Where it runs:** Icecast `:8010` + Liquidsoap (engine ingest `:8008`, control `:1234`), inside WSL Ubuntu. Nothing here runs on Windows directly.

## Verify on-air in 30 seconds

```sh
# from WSL (or any shell in Ubuntu). The one command that answers "is it live":
curl -s --max-time 6 http://127.0.0.1:8010/live.mp3 -o /tmp/p.mp3 \
  && ffmpeg -hide_banner -i /tmp/p.mp3 -af volumedetect -f null - 2>&1 | grep mean_volume
```

- `mean_volume` with a real level (e.g. **-25 dB**) = on air, non-silent.
- A tiny file (≈119 bytes) or `Duration: N/A` = **not** on air, even if Icecast looks up.
- `curl -s http://127.0.0.1:8010/status-json.xsl` → a `source` entry for `/live.mp3` means a source is attached.

**A 200 on `/live.mp3` is not proof.** A mount can answer while carrying silence (that is the failure this stack has hit before). Decode a few seconds and read the level.

## Silent-failure triage (in order)

1. **Is the mount carrying audio?** Decode-and-measure above. If 119 bytes → go to 2.
2. **Liquidsoap clock:** `grep -E 'must catchup|Broken pipe' /tmp/liquidsoap.log | tail`.
   A growing `must catchup N seconds` with `clock.main` means the guest clock is
   wrong (see **WSL2 clock** below). A spike of `Broken pipe` = Icecast dropped
   the source (source-timeout vs a stall).
3. **Which source is selected?** `grep -E 'Connecting mount|successful' /tmp/liquidsoap.log`.
4. **Icecast has the mount?** `curl -s -u admin:<pw> http://127.0.0.1:8010/admin/listmounts`.
   `<pw>` is `ICECAST_ADMIN_PASSWORD` in `infra/icecast/.env` — do not print it.

## WSL2 clock (this is the one that bit us)

Liquidsoap paces realtime off the **system clock**. WSL2's default clocksource
(`hyperv_clocksource_tsc_page`) can run **fast** (measured 2026-10-11: ~18×),
making the clock chase forever → `We must catchup N seconds` → Icecast drops the
source. Fixes, both applied here:

```sh
# 1. use the stable paravirt clock for THIS boot
echo hyperv_clocksource_msr > /sys/devices/system/clocksource/clocksource0/current_clocksource
# 2. persist it across WSL restarts (already written to /etc/wsl.conf here)
#    [boot]
#    systemd=true
#    command=/bin/sh -c "echo hyperv_clocksource_msr > /sys/devices/system/clocksource/clocksource0/current_clocksource"
```

Check the **rate** (offset doesn't matter): `date +%s; sleep 15; date +%s` should
differ by ~15. If it is still fast, run `wsl --shutdown` once and re-apply.

## Restart (order matters)

```sh
sh "infra/station-down.sh"     # always down first — leaves no half-started ingest
sh "infra/preflight.sh"        # validates the RENDERED configs before any restart
sh "infra/station-up.sh"
```

`preflight.sh` must say **PREFLIGHT OK** first. If it fails, **do not restart** —
you would leave Icecast up with no authenticated source (mounts "healthy", silent).

## What NOT to touch

- **`infra/icecast/.env`** — four live credentials. Rendered at start into
  `/etc/icecast2/icecast.xml` and `/run/ncsound/ncsound.rendered.liq` (mode 600).
  Never put a real value into the tracked `icecast.xml` / `ncsound.liq`; both use
  placeholders and `preflight.sh` fails if a placeholder survives.
- **The tracked configs while the station is live** — edit, then preflight, then restart.

## Known limits (honest)

- **The DJ engine is wired in.** It runs in-process in `packages/ingest` on
  **Windows** (needs `bun` + `C:/Users/User/Music/music`), started with
  `infra/engine-up.sh`; it reads `HARBOR_PASSWORD` from `infra/icecast/.env` and
  uploads to Liquidsoap `:8008`. Confirm it took over:
  `grep -a 'Switch to input.harbor' /tmp/liquidsoap.log`, and
  `curl -s http://127.0.0.1:8137/status`. Stop it with the ingest PID
  (`/tmp/ncsound-ingest.pid`). If it stops, Liquidsoap falls back to the library
  filler — that is the dead-air policy working, not a fault.
- **ICY now-playing shows "NCSound Radio", not the track.** The engine sends the
  title as an `icy-name` harbour header with ICY framing off; Liquidsoap does not
  surface it as source metadata. Listeners hear the right track but don't see it.
- **WSL2, not a server.** The station is a daemon on this PC; it stops when the PC or
  WSL stops. There is no boot persistence wired (a scheduled task needs elevation).
- **Not exposed publicly.** Icecast binds `127.0.0.1`; the public stream path is a
  separate task (Cloudflare CDN is barred for radio audio — see the wiki).
- Small transient clock catchups (~3s) still appear; the `buffer()` on the output
  absorbs them so the mount no longer drops.
