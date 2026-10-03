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
settings.log.level.set(3)

# Loopback only. The server protocol has no authentication of its own.
settings.server.telnet := true
settings.server.telnet.bind_addr := "127.0.0.1"
settings.server.telnet.port := 1234
settings.server.socket := false

# ---- ingest: the DJ engine --------------------------------------------
dj_source = input.harbor(
  "dj",
  port=8008,
  user="engine",
  password="REDACTED",
  buffer=12.,
  timeout=15.,
  # The engine interleaves ICY metadata blocks into the upload, which is how a
  # track change reaches listeners on an already-open connection.
  icy=true,
  on_disconnect=fun () -> log.info("DJ engine disconnected"),
)

# ---- dead-air insurance -----------------------------------------------
library = playlist(mode="randomize", "/srv/ncsound/library")

radio = fallback(track_sensitive=false, [dj_source, library])
radio = mksafe(radio)

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
output.icecast(
  %mp3(bitrate=128),
  host="127.0.0.1",
  port=8000,
  user="source",
  password="REDACTED",
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
  port=8000,
  user="source",
  password="REDACTED",
  mount="/mobile.mp3",
  name="NCSound Radio (mobile)",
  genre="Various",
  public=true,
  icy_song=station_title,
  radio,
)