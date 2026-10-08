/**
 * Publish an analysed track's audio-feature vector to the Vectorize index.
 *
 * The console is the feature producer: it already computes `TrackAnalysis`
 * (bpm, key, bands, energy curve) while indexing. This posts that fingerprint to
 * `ncsound-api`'s `/index`, through the console server's `/vectorize` proxy,
 * which injects the Worker's INDEX_TOKEN so the token never reaches the page.
 *
 * Best-effort: a publish failure must never block indexing or playback.
 */
import { trackFeatureVector, type TrackAnalysis } from "@ncsound/station-core";

export async function publishFeatureVector(
  key: string,
  analysis: TrackAnalysis,
  metadata: Record<string, string | number>,
): Promise<void> {
  const res = await fetch("/vectorize/index", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, vector: trackFeatureVector(analysis), metadata }),
  });
  if (!res.ok) throw new Error(`vector index failed (${res.status})`);
}
