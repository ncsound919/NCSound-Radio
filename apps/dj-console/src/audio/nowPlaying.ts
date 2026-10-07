/**
 * Now-playing bridge for the OBS overlay (plan 6.4).
 *
 * The overlay is a separate page (an OBS Browser Source) and cannot see the
 * console's in-memory decks, so the console publishes what is audible to a
 * same-origin BroadcastChannel and the overlay renders it. This keeps the
 * local-deck path working for Party without the station engine.
 */
export type NowPlaying = {
  /** Deck slot that is audible, or null when nothing is playing. */
  slot: 0 | 1 | null;
  title: string;
  artist: string;
  djName: string;
  mode: "party" | "radio";
  /** Station on-air, when the engine reports it (Phase 5). */
  onAir: boolean | null;
  at: number;
};

export const NOW_PLAYING_CHANNEL = "ncsound.nowplaying";

/** The line the overlay shows: "Artist — Title", or just one of them. */
export function formatNowPlaying(np: Pick<NowPlaying, "title" | "artist">): string {
  const t = np.title.trim();
  const a = np.artist.trim();
  if (a && t) return `${a} — ${t}`;
  return t || a || "";
}

type Channel = { postMessage(data: unknown): void; close(): void; onmessage: ((e: MessageEvent) => void) | null };

export function publishNowPlaying(np: NowPlaying): void {
  const Ctor = (globalThis as { BroadcastChannel?: new (name: string) => Channel }).BroadcastChannel;
  if (!Ctor) return;
  try {
    const ch = new Ctor(NOW_PLAYING_CHANNEL);
    ch.postMessage(np);
    ch.close();
  } catch {
    /* channel unavailable: the overlay shows "waiting" */
  }
}

/** Subscribe to now-playing. Returns an unsubscribe. */
export function subscribeNowPlaying(fn: (np: NowPlaying) => void): () => void {
  const Ctor = (globalThis as { BroadcastChannel?: new (name: string) => Channel }).BroadcastChannel;
  if (!Ctor) return () => {};
  const ch = new Ctor(NOW_PLAYING_CHANNEL);
  ch.onmessage = (e: MessageEvent) => {
    const d = e.data as Partial<NowPlaying> | null;
    if (d && typeof d === "object" && typeof d.title === "string") fn(d as NowPlaying);
  };
  return () => ch.close();
}
