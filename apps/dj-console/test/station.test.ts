import assert from "node:assert/strict";
import { matchRequest } from "../src/radio/station";

console.log("=== Requests: library matching ===");
const lib = [
  { id: "a", title: "Midnight  Warehouse", artist: "Sublevel 808" },
  { id: "b", title: "Midnight Warehouse", artist: "Someone Else" },
  { id: "c", title: "Gold", artist: "" },
];
assert.equal(matchRequest({ title: "midnight warehouse", artist: "SUBLEVEL 808" }, lib)?.id, "a", "case and spacing ignored, artist breaks ties");
assert.equal(matchRequest({ title: "Midnight Warehouse", artist: "Someone Else" }, lib)?.id, "b");
assert.equal(matchRequest({ title: "Midnight Warehouse", artist: "Unknown Artist" }, lib), null, "a wrong artist is no match, not a guess");
assert.equal(matchRequest({ title: "Gold", artist: "" }, lib)?.id, "c", "no artist on the request matches by title");
assert.equal(matchRequest({ title: "", artist: "Sublevel 808" }, lib), null, "no title never matches");
assert.equal(matchRequest({ title: "Not Here", artist: "" }, lib), null);
console.log("Requests matching tests passed");
