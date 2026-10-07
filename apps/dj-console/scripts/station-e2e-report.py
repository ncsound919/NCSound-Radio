#!/usr/bin/env python3
"""Correlate station-e2e events with what the listener probe heard.

    python3 station-e2e-report.py events.json probe.jsonl [libraryKilledAtMs]

For each event, reports when the listener first heard the expected tone
afterwards (sustained for 1 s, so a crossfade blip doesn't count).
"""
import json, sys

events = {e["name"]: e for e in json.load(open(sys.argv[1]))}
probe = [json.loads(l) for l in open(sys.argv[2]) if l.strip()]
names = {440: "console", 523: "console marker", 660: "autopilot", 880: "library", 0: "silence", -1: "probe reconnect"}

def first_heard(after_ms, tone, sustain=4):
    run = 0
    for i, p in enumerate(probe):
        if p["t"] < after_ms:
            continue
        run = run + 1 if p["dom"] == tone else 0
        if run >= sustain:
            return probe[i - sustain + 1]["t"]
    return None

STATION = (660, 880)

def first_heard_any(after_ms, tones, sustain=4):
    hits = [t for t in (first_heard(after_ms, x, sustain) for x in tones) if t]
    return min(hits) if hits else None

def line_station(label, start):
    """When the listener got the station's own feed back (autopilot or library)."""
    if start not in events:
        print(f"  {label:<46} event '{start}' missing")
        return None
    t0 = events[start]["t"]
    t = first_heard_any(t0, STATION)
    which = None
    if t:
        which = next((names[x] for x in STATION if first_heard(t0, x) == t), "?")
    print(f"  {label:<46} {('%.1f s' % ((t - t0) / 1000)) if t else 'NOT HEARD'}  ({which or 'station feed'})")
    return t

def line_back(label, start, tone):
    """Console heard again, counted only after the station feed took over."""
    if start not in events:
        return None
    t0 = events[start]["t"]
    t_station = first_heard_any(t0, STATION)
    if not t_station:
        print(f"  {label:<46} n/a (listener never left the console)")
        return None
    t = first_heard(t_station, tone)
    print(f"  {label:<46} {('%.1f s' % ((t - t0) / 1000)) if t else 'NOT HEARD'}  ({names[tone]})")
    return t

def gap(after_ms, until_ms):
    """Longest run of silence (dom 0) between two times, seconds."""
    best = cur = 0
    for p in probe:
        if after_ms <= p["t"] <= until_ms:
            cur = cur + 1 if p["dom"] in (0, -1) else 0
            best = max(best, cur)
    return best * 0.25

def line(label, start, tone):
    if start not in events:
        print(f"  {label:<46} event '{start}' missing")
        return None
    t0 = events[start]["t"]
    t = first_heard(t0, tone)
    print(f"  {label:<46} {('%.1f s' % ((t - t0) / 1000)) if t else 'NOT HEARD'}  ({names[tone]})")
    return t

print("Listener timeline (dominant tone changes):")
last = None
t_start = probe[0]["t"] if probe else 0
for p in probe:
    if p["dom"] != last:
        print(f"  +{(p['t'] - t_start) / 1000:7.2f}s  {names.get(p['dom'], p['dom'])}")
        last = p["dom"]

print("\nMeasured (wall clock, same machine; listener figures include Icecast's burst-on-connect buffer):")
line("Go live pressed -> listener hears console", "go_live_pressed", 440)
if "armed_sending" in events and "console_says_on_air" in events:
    print(f"  {'Audio flowing -> console shows LIVE':<46} {(events['console_says_on_air']['t'] - events['armed_sending']['t']) / 1000:.1f} s")
line("Deck cut to marker -> listener hears it (delay)", "marker_523_cut", 523)
line_station("Stall starts -> listener on station feed", "stall_started")
if "stall_started" in events and "console_says_lost" in events:
    print(f"  {'Stall starts -> console shows LOST':<46} {(events['console_says_lost']['t'] - events['stall_started']['t']) / 1000:.1f} s")
line_back("Stall starts -> listener hears console again", "stall_started", 523)
line_station("Socket dropped -> listener on station feed", "socket_dropped")
line_back("Socket dropped -> listener hears console again", "socket_dropped", 523)
line_station("Hand back -> listener on station feed", "hand_back_pressed")
if "stall_started" in events and "stall_cleared" in events:
    print(f"  {'Longest silence during stall/fallback':<46} {gap(events['stall_started']['t'], events['stall_cleared']['t'] + 15000):.2f} s")
if "socket_dropped" in events:
    print(f"  {'Longest silence around the drop':<46} {gap(events['socket_dropped']['t'], events['socket_dropped']['t'] + 20000):.2f} s")
if len(sys.argv) > 3:
    t0 = int(sys.argv[3])
    t = first_heard(t0, 880)
    print(f"  {'Autopilot feed killed -> listener hears library':<46} {('%.1f s' % ((t - t0) / 1000)) if t else 'NOT HEARD'}")
for k in ("health", "bridge_final", "page_errors", "never_on_air"):
    if k in events:
        print(f"  {k}: {json.dumps({x: y for x, y in events[k].items() if x not in ('name', 't')})}")
