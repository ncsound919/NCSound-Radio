/**
 * Library pure-module tests (plan phase 4): search/filter/match, crates and
 * export, cache hashing, and the audible-history rule.
 *
 * These run in Node with no DOM and no IndexedDB, which is why the controller
 * keeps all of this in plain functions.
 */
import {
  parseQuery,
  filterTracks,
  matchInfo,
  camelotRank,
  MATCH_PCT,
} from "../src/library/search";
import { enqueue, dequeueAt, nextUp, toM3U8, toHistoryCsv, exportName } from "../src/library/crates";
import { fnv1a, hashBytes, cacheKeyFor, makeId } from "../src/library/hash";
import { AudibleLogger, AUDIBLE_SECONDS } from "../src/library/history";
import type { LibraryTrack } from "../src/library/types";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

function track(over: Partial<LibraryTrack>): LibraryTrack {
  return {
    id: over.id ?? "id",
    source: "files",
    fileName: "file.mp3",
    title: "Title",
    artist: "Artist",
    size: 1,
    lastModified: 0,
    durationSec: 240,
    bpm: 124,
    key: "8A",
    rating: 0,
    status: "ready",
    dateAddedMs: 0,
    ...over,
  };
}

/* ---------- search ---------- */
{
  const p = parseQuery("warehouse bpm:120-126 8a");
  check("parseQuery splits text term", p.terms.includes("warehouse"));
  check("parseQuery reads bpm range", p.bpmMin === 120 && p.bpmMax === 126);
  check("parseQuery reads bare camelot key", p.key === "8A");

  const p2 = parseQuery("124-128");
  check("parseQuery reads bare numeric range", p2.bpmMin === 124 && p2.bpmMax === 128);

  const tracks = [
    track({ id: "a", title: "Warehouse Groove", bpm: 124, key: "8A" }),
    track({ id: "b", title: "Deep Water", artist: "Sublevel", bpm: 140, key: "5A" }),
    track({ id: "c", title: "Night", bpm: 122, key: "9A" }),
  ];

  const byText = filterTracks(tracks, { text: "warehouse", matchesOnly: false, sort: "artist", desc: false });
  check("text search narrows to one", byText.length === 1 && byText[0].track.id === "a");

  const byKey = filterTracks(tracks, { text: "8a", matchesOnly: false, sort: "artist", desc: false });
  check("bare key search matches camelot", byKey.length === 1 && byKey[0].track.id === "a");

  const byBpm = filterTracks(tracks, { text: "120-126", matchesOnly: false, sort: "bpm", desc: false });
  check("bpm range search", byBpm.length === 2 && byBpm[0].track.bpm === 122);

  const target = { bpm: 124, key: "8A" };
  const matched = filterTracks(tracks, { text: "", matchesOnly: true, sort: "artist", desc: false, target });
  // a: same bpm + same key; c: 122 is within 6% and 9A is adjacent; b: 140 far and 5A wide.
  check("matchesOnly keeps near/harmonic tracks", matched.length === 2, `got ${matched.map((m) => m.track.id).join(",")}`);
  check("matchesOnly drops far/wide track", !matched.some((m) => m.track.id === "b"));

  const a = matchInfo(tracks[0], target);
  check("matchInfo within 6% and compatible", a.matches && Math.abs(a.bpmDeltaPct!) <= MATCH_PCT);
  const b = matchInfo(tracks[1], target);
  check("matchInfo rejects a wide key", !b.matches);

  const unknown = matchInfo(track({ key: null }), target);
  check("matchInfo treats unknown key neutrally (not a match claim)", !unknown.matches);

  check("camelotRank orders 8A before 8B", camelotRank("8A") < camelotRank("8B"));
  check("camelotRank puts unknown last", camelotRank(null) > camelotRank("12B"));
}

/* ---------- crates / export ---------- */
{
  let q = enqueue([], "a");
  q = enqueue(q, "b");
  q = enqueue(q, "a");
  check("enqueue is deduped and ordered", q.join(",") === "a,b");
  check("dequeueAt removes the right slot", dequeueAt(q, 0).join(",") === "b");
  check("nextUp returns the head", nextUp(q) === "a");
  check("nextUp empty is null", nextUp([]) === null);

  const m3u = toM3U8([
    { fileName: "a.mp3", path: "Artist/a.mp3", durationSec: 65.4 },
    { fileName: "b.wav", durationSec: null },
  ]);
  check("M3U8 header present", m3u.startsWith("#EXTM3U\n"));
  check("M3U8 uses the path and rounds duration", m3u.includes("#EXTINF:65,Artist/a"));
  check("M3U8 unknown duration is -1", m3u.includes("#EXTINF:-1,b"));

  const csv = toHistoryCsv([
    { trackId: "a", title: 'Title, with comma', artist: 'Quote "x"', fileName: "a.mp3", bpm: 124, key: "8A", startedAtMs: 0, durationSec: 60 },
  ]);
  check("CSV quotes commas", csv.includes('"Title, with comma"'));
  check("CSV escapes quotes", csv.includes('"Quote ""x"""'));

  const name = exportName("crate-house", "m3u8", new Date("2026-10-06T21:30:00Z"));
  check("exportName carries a timestamp", name === "ncsound-crate-house-202610062130.m3u8", name);
}

/* ---------- hash ---------- */
{
  const bytes = new TextEncoder().encode("hello world");
  check("fnv1a is deterministic", fnv1a(bytes) === fnv1a(bytes));
  check("fnv1a differs on different input", fnv1a(bytes) !== fnv1a(new TextEncoder().encode("hello worlx")));
  check("hashBytes is 8 hex chars", /^[0-9a-f]{8}$/.test(hashBytes(bytes)));
  const k1 = cacheKeyFor("a.mp3", 100, 5, "deadbeef");
  check("cacheKey shape", k1 === "a.mp3|100|5|deadbeef");
  check("makeId is stable and prefixed", makeId("file", "x") === makeId("file", "x") && makeId("file", "x").startsWith("file-"));
  check("makeId differs by seed", makeId("file", "x") !== makeId("file", "y"));
}

/* ---------- audible history ---------- */
{
  const logger = new AudibleLogger();
  const info = { trackId: "t1", title: "T", artist: "A", fileName: "t.mp3", bpm: 124, key: "8A", durationSec: 200 };
  let logged = null as ReturnType<AudibleLogger["observe"]>;
  // 29 seconds audible: not yet logged.
  for (let i = 0; i < 29; i++) logged = logger.observe({ slot: 0, playing: true, gain: 0.5, track: info, nowMs: i * 1000 });
  check("not logged before the threshold", logged === null);
  // Cross 30 s.
  for (let i = 29; i <= 32; i++) {
    const e = logger.observe({ slot: 0, playing: true, gain: 0.5, track: info, nowMs: i * 1000 });
    if (e) logged = e;
  }
  check("logged after the threshold", logged !== null && logged.trackId === "t1");
  check("entry records the start time", logged !== null && logged.startedAtMs === 0);

  // A quiet frame resets the accumulator: a new audible run must reach 30 s again.
  const l2 = new AudibleLogger();
  let e2 = null as ReturnType<AudibleLogger["observe"]>;
  for (let i = 0; i < 45; i++) {
    const gain = i % 3 === 2 ? 0 : 0.5; // never audible for a continuous 30 s
    e2 = l2.observe({ slot: 0, playing: true, gain, track: info, nowMs: i * 1000 });
    if (e2) break;
  }
  check("a gap prevents a false log", e2 === null);

  // A single huge dt (backgrounded tab) cannot fake 30 s.
  const l3 = new AudibleLogger();
  l3.observe({ slot: 0, playing: true, gain: 0.5, track: info, nowMs: 0 });
  const big = l3.observe({ slot: 0, playing: true, gain: 0.5, track: info, nowMs: 5 * 60 * 1000 });
  check(`a ${AUDIBLE_SECONDS}s jump in one frame is capped`, big === null);
}

console.log(failures ? `\n${failures} FAILED` : "\nAll library tests passed.");
process.exit(failures ? 1 : 0);
