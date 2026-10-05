/**
 * Serve crate audio to the DJ console.
 *
 * The console runs a booth mixer in the browser, which meant it needed audio to
 * play — and the only audio it had was a synthesised crate of invented tracks
 * ("Midnight Warehouse" by "Sublevel 808"). The DJ was therefore preparing
 * sets from music the station does not own, while the station site listed the
 * engine's real library. Two truths, one booth.
 *
 * Closing that properly means the booth can load the station's actual files.
 * They live on this machine's disk, decoded here by the same `materialize` the
 * engine uses, and shipped as WAV — the one format the browser decodes without
 * a codec.
 *
 * Deliberate limits, because this hands a file to a browser:
 *  - **Loopback only.** The route is on the same service as the control plane,
 *    which already refuses a non-loopback bind without `INGEST_TOKEN`.
 *  - **Crate membership only.** The id must already be in `engine.library`, so
 *    this cannot be used to read arbitrary paths off the machine.
 *  - **Bounded cache.** Decoded PCM is large; a station library is small.
 */

import { materialize } from "@ncsound/dj-engine";
import type { DecodedTrack } from "@ncsound/dj-engine";

const BITS = 16;

/** Roughly a dozen tracks of stereo 48k PCM. */
const MAX_CACHE_ENTRIES = 12;

/** 16-bit is the format; anything else would need resampling first. */
function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const ch = channels.length;
  const frames = ch > 0 ? channels[0]!.length : 0;
  const blockAlign = (ch * BITS) / 8;
  const dataBytes = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);

  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) v.setUint8(offset + i, s.charCodeAt(i));
  };

  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, (sampleRate * blockAlign) | 0, true); // byte rate
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, BITS, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < ch; c += 1) {
      const s = Math.max(-1, Math.min(1, channels[c]![i]!));
      v.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(buf);
}

export type CrateAudioDeps = {
  /**
   * The crate, by id. Membership is the authorisation.
   *
   * A getter, not an array. `HeadlessEngine.start()` REPLACES `engine.library`
   * with the scanned crate, so a reference captured at construction time is
   * the empty array the engine booted with — and every lookup silently misses.
   */
  library: () => DecodedTrack[];
  /** Decode settings; must match the crate scan or the cache is wasted. */
  decode: { sampleRate?: number; cacheDir?: string };
  context: BaseAudioContext;
  logger?: (message: string) => void;
};

export class CrateAudio {
  private readonly cache = new Map<string, { wav: Uint8Array; mime: string }>();

  constructor(private readonly deps: CrateAudioDeps) {}

  /**
   * WAV bytes for a crate track, or null when the id is not in the crate.
   *
   * Null rather than an error for "not in the crate": the caller distinguishes
   * that from a decode failure and tells the operator which happened.
   */
  async wav(trackId: string): Promise<{ wav: Uint8Array; mime: string } | null> {
    const hit = this.cache.get(trackId);
    if (hit) {
      // Refresh recency.
      this.cache.delete(trackId);
      this.cache.set(trackId, hit);
      return hit;
    }

    const track = this.deps.library().find((t) => t.id === trackId);
    // Membership check. This is the only thing standing between the endpoint
    // and an arbitrary read of the server's filesystem.
    if (!track) return null;

    let decoded: DecodedTrack;
    try {
      decoded = await materialize(track, this.deps.context, this.deps.decode);
    } catch (err) {
      this.deps.logger?.(
        `crate audio: decode failed for ${track.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (!decoded.buffer) return null;

    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.buffer.numberOfChannels; c += 1) {
      channels.push(decoded.buffer.getChannelData(c));
    }
    const wav = encodeWav(channels, decoded.buffer.sampleRate);

    const entry = { wav, mime: "audio/wav" };
    this.cache.set(trackId, entry);
    // Evict least-recently-used.
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return entry;
  }

  clear(): void {
    this.cache.clear();
  }
}
