/**
 * Transcode service (Cloudflare integration, phase 4).
 *
 * The ffmpeg Container measures EBU R128 loudness and normalises a file. The
 * console reaches it through its own server's `/transcode` proxy, which injects
 * the Worker token, so the token never reaches the browser (same pattern as
 * the ingest token in vite.config.ts).
 */
export type Loudness = {
  ok: boolean;
  integratedLufs: number | null;
  truePeakDbfs: number | null;
  lra: number | null;
  durationSec: number | null;
  error?: string;
};

export async function measureLoudness(bytes: Blob | ArrayBuffer): Promise<Loudness> {
  const res = await fetch("/transcode/loudness", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  const body = (await res.json().catch(() => null)) as (Loudness & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error ?? `Loudness measure failed (${res.status}).`);
  return body;
}

/** Re-encode to MP3 at `kbps` and return the bytes. */
export async function normalizeTrack(bytes: Blob | ArrayBuffer, kbps = 192): Promise<Blob> {
  const res = await fetch(`/transcode/transcode?kbps=${kbps}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Normalize failed (${res.status}).`);
  }
  return res.blob();
}
