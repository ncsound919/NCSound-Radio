# NCSound Radio - Liquidsoap 2.2 radio delivery.
#
# Division of responsibility (see ../README.md):
#   dj-engine  owns the timeline  - track choice, beat matching, key locks,
#                                  energy curves, transitions, scratch drops
#   liquidsoap owns delivery      - encoding, Icecast ingest, ICY metadata,
#                                  dead-air fallback
#
# Liquidsoap therefore ingests exactly ONE input: the engine, over an
# Icecast-compatible HTTP source endpoint (input.harbor). It never sequences
# music itself.
#
#   start:  sh infra/station-up.sh
#   ctrl :  telnet 127.0.0.1 1234
#
# Targets Liquidsoap 2.2.x. Settings use := , not =.

# ---- logging / control ------------------------------------------------
settings.log.stdout.set(true)
# 3 shows the "Switch to input.harbor" line that proves the engine is on air.
# Raise to 4 when debugging harbor ingestion: that is where the codec errors
# (Unknown_codec, "Unable to find a decoder for stream mime-type") appear.
settings.log.level.set(5)

# Loopback only. The server protocol has no authentication of its own.
settings.server.telnet := true
settings.server.telnet.bind_addr := "127.0.0.1"
settings.server.telnet.port := 1234
settings.server.socket := false

# ---- ingest: the DJ engine --------------------------------------------
# Passwords come from the environment, populated by infra/station-up.sh from
# infra/icecast/.env. They were previously hardcoded here ("REDACTED", "ingest"),
# which put three live credentials in a tracked file; gitleaks flagged the two
# curl -u copies but missed these entirely, because a Liquidsoap string literal
# matches none of its credential patterns.
#
# getenv returns null when unset, and `harbor`/`icecast` reject a null password
# at typecheck time, so a missing .env fails the config check in station-up.sh
# rather than starting a station that cannot authenticate. That is the direction
# we want: refuse, do not fall back to a default.
dj_source = input.harbor(
  "dj",
  port=8008,
  user="engine",
  password=getenv("HARBOR_PASSWORD"),
  buffer=12.,
  timeout=15.,
  # The engine interleaves ICY metadata blocks into the upload, which is how a
  # track change reaches listeners on an already-open connection.
  # ICY metadata framing is OFF. It was on, and it is why the station never
  # actually reached air: interleaving 255-byte blocks and metadata length bytes
  # into the upload desynchronised the WAV stream, so harbor's ffmpeg decoder
  # produced frames at roughly 700 bytes a second instead of 192 KB/s. Harbor sat
  # at "need more buffering" forever, the switch never selected it, and
  # listeners got the dead-air fallback tone while every counter read healthy.
  #
  # Now-playing titles reach listeners through the output.icecast `icy_song`
  # callback instead, which reads whatever the engine last published.
  icy=false,
  on_disconnect=fun () -> log.info("DJ engine disconnected"),
)

# ---- dead-air insurance & the off-air switch -----------------------------
# Three distinct states, which used to be collapsed into two:
#
#   on air   -> the engine is publishing; this is what listeners should hear
#   filler   -> the engine dropped; keep the mount alive with the library
#               rather than handing listeners a dead socket
#   off air  -> an operator said stop; TRUE SILENCE
#
# The old chain was `fallback([dj_source, library])`, so stopping the engine
# quietly promoted the library playlist. An operator hitting "TAKE OFF AIR"
# heard the backup playlist come up instead. That is a defensible
# never-dead-air policy, but it is not an off-air switch, and the control room
# has to be able to mean it.
#
# `on_air` is an interactive variable: flip it over the telnet server with
#   var.set on_air = false
# and the output goes to `blank()` â€” real silence, mount still connected, so
# listeners stay connected instead of being dropped mid-track.
library = playlist(mode="randomize", "/srv/ncsound/library")
filler = fallback(track_sensitive=false, [library, blank()])
live = mksafe(dj_source)
normal = fallback(track_sensitive=false, [live, filler])

on_air = interactive.bool("on_air", true)
radio = switch(track_sensitive=false, [(on_air, normal), ({true}, blank())])

# NOTE: `interactive.persistent()` was tried here and is deliberately NOT used.
# It reads and writes an undocumented internal format that
# `interactive.bool` cannot round-trip (the loader wants a float map, and the
# error is an uncaught runtime crash at boot, so a station that had been off air
# could not start). The ingest service owns this state instead: it persists the
# operator's intent and re-asserts it over telnet once Liquidsoap is up. See
# packages/ingest/src/liquidsoap.ts.

# ---- ICY now-playing ---------------------------------------------------
# Turns whatever metadata the engine pushes into an ICY StreamTitle.
# With no engine attached, falls back to the station ident.
def station_title(m) =
  title = m["title"]
  artist = m["artist"]
  if title != "" and artist != "" then
    artist ^ " - " ^ title
  elsif title != "" then
    title
  else
    "NCSound Radio"
  end
end

# ---- outputs -----------------------------------------------------------
# Icecast listens on 8010, not its default 8000: an unrelated Windows service
# holds 127.0.0.1:8000 and WSL2's localhost relay loses to a Windows listener.
output.icecast(
  %mp3(bitrate=128),
  host="127.0.0.1",
  port=8010,
  user="source",
  password=getenv("ICECAST_SOURCE_PASSWORD"),
  mount="/live.mp3",
  name="NCSound Radio",
  description="Independent hip-hop radio",
  genre="Various",
  url="https://ncsound.example",
  public=true,
  icy_song=station_title,
  radio,
)

output.icecast(
  %mp3(bitrate=64),
  host="127.0.0.1",
  port=8010,
  user="source",
  password=getenv("ICECAST_SOURCE_PASSWORD"),
  mount="/mobile.mp3",
  name="NCSound Radio (mobile)",
  genre="Various",
  public=true,
  icy_song=station_title,
  radio,
)


