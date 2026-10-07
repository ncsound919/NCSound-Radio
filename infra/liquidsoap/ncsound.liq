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
# infra/icecast/.env. They were previously hardcoded here,
# which put three live credentials in a tracked file; gitleaks flagged the two
# curl -u copies but missed these entirely, because a Liquidsoap string literal
# matches none of its credential patterns.
#
# getenv returns null when unset, and `harbor`/`icecast` reject a null password
# at typecheck time, so a missing .env fails the config check in station-up.sh
# rather than starting a station that cannot authenticate. That is the direction
# we want: refuse, do not fall back to a default.

# Is the engine's upload actually feeding us?
#
# This is the authoritative answer to "did audio arrive from the engine", and it
# has to come from Liquidsoap rather than from the uploader: when the daemon was
# restarted the engine's own socket reported connected=true with zero reconnects
# and no error, because writing to a socket whose peer is gone never fails. The
# engine rendered steadily and the mount carried -91 dBFS while every client-side
# field looked healthy. Liquidsoap owns the far end of that socket, so it is the
# only component that can say the truth.
harbor_source_connected = interactive.bool("harbor_source_connected", false)

dj_source = input.harbor(
  "dj",
  port=8008,
  user="engine",
  password=getenv("HARBOR_PASSWORD"),
  buffer=12.,
  timeout=15.,
  # Publish whether the engine is actually feeding us, for ingest to read over
  # telnet. Authoritative: the uploader cannot detect a dead peer, so after a
  # daemon restart it reported `connected` while the mount carried -91 dBFS.
  #
  # `on_connect` receives the connection record and `on_disconnect` takes none in
  # Liquidsoap 2.2, and only one of each may be supplied — a second `on_disconnect`
  # fails with "has no more argument labeled on_disconnect". So the existing log
  # line is folded in here rather than added alongside.
  on_connect=fun (_) -> harbor_source_connected.set(true),
  on_disconnect=fun () ->
    begin
      harbor_source_connected.set(false)
      log.info("DJ engine disconnected")
    end
  ,
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
)

# ---- ingest: the DJ console, live ---------------------------------------
# A second harbor mount on the SAME port. The console streams Opus in WebM to
# ingest, which re-encodes it to MP3 with ffmpeg and feeds it here as an Icecast
# source. It sits FIRST in the fallback, so a live DJ takes priority over
# autopilot; the moment the console disconnects, harbor reports this source not
# ready and the fallback drops back to the engine by itself.
#
# Deliberately NOT wrapped in mksafe(). mksafe makes a source infallible, i.e.
# always "ready", and fallback selects the first ready child — so an mksafe'd
# live mount would win forever and autopilot would never play when no console is
# attached. The raw harbor is ready only while a source is actually connected.
live_harbor_connected = interactive.bool("live_harbor_connected", false)

dj_live = input.harbor(
  "live",
  port=8008,
  user="live",
  password=getenv("LIVE_HARBOR_PASSWORD"),
  # Short buffer and timeout, unlike the engine's 12s/15s: this is the
  # hand-over path, so it must come up and drop out quickly instead of holding
  # a long startup buffer while listeners wait.
  buffer=4.,
  max=10.,
  timeout=8.,
  on_connect=fun (_) -> live_harbor_connected.set(true),
  on_disconnect=fun () ->
    begin
      live_harbor_connected.set(false)
      log.info("DJ console live source disconnected")
    end
  ,
  icy=false,
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
# Priority: console live, then engine/autopilot, then the library. BOTH harbor
# mounts are raw here. mksafe makes a source infallible (always ready), and
# fallback selects the first ready child — so an mksafe'd source ahead of filler
# would win forever and the library would never play when the engine drops. With
# both mounts raw, each is ready only while its source is connected, so a dead
# engine falls through to the library as the dead-air policy intends.
normal = fallback(
  track_sensitive=false,
  [dj_live, dj_source, filler],
  transitions=[
    fun (a, b) -> cross.simple(fade_in=0.5, fade_out=0.5, a, b),
    fun (a, b) -> cross.simple(fade_in=0.5, fade_out=0.5, a, b),
    fun (a, b) -> cross.simple(fade_in=0.5, fade_out=0.5, a, b),
  ],
)
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
  # Stop encoding when the source has nothing to play.
  #
  # Without this, a dead engine left Icecast holding a connected source that
  # carried silence, and `stream.onAir` on the status endpoint read `true` — the
  # station looked live and broadcast nothing. `fallible=true` makes the output
  # stop instead, which is both truthful and what a listener's player expects when
  # a station goes off.
  fallible=true,
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
  fallible=true,
  radio,
)


