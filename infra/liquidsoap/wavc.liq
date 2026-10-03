# WAVC 91.3 - Liquidsoap 2.2 radio delivery.
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
  on_disconnect=fun () -> log.info("DJ engine disconnected"),
)

# ---- dead-air insurance -----------------------------------------------
library = playlist(mode="randomize", "/srv/wavc/library")

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
    "WAVC 91.3 Carolina Waves"
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
  name="WAVC 91.3 Carolina Waves",
  description="Independent hip-hop radio",
  genre="Various",
  url="https://wavc.example",
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
  name="WAVC 91.3 Carolina Waves (mobile)",
  genre="Various",
  public=true,
  icy_song=station_title,
  radio,
)