/**
 * Station calls from the console (plan 5.6, 5.7): commands, listener
 * requests and the imaging list, all through the console server's `/ingest`
 * proxy (which adds INGEST_TOKEN server-side when it is set).
 *
 * Every function reports failure as a value with a reason; nothing here
 * throws or pretends a command worked.
 */
import type { DjCommand } from "@ncsound/station-core";
import { authHeaders } from "../app/session";

export type CommandOutcome = { ok: true; result: unknown } | { ok: false; error: string };

const ACTOR = { id: "console", role: "console", label: "dj console" } as const;

async function call(path: string, init?: RequestInit, timeoutMs = 5000): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(`/ingest${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      ...init,
      headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

export async function stationCommand(command: DjCommand): Promise<CommandOutcome> {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `c${Date.now()}${Math.random()}`;
  const r = await call("/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, issuedAt: new Date().toISOString(), actor: ACTOR, command }),
  }, 15000);
  const b = r.body as { ok?: boolean; error?: string; result?: unknown } | null;
  if (r.status === 0) return { ok: false, error: "the station engine is not reachable" };
  if (r.status === 401) return { ok: false, error: "ingest wants a token: start the console with INGEST_TOKEN set, or ask for a new invite link" };
  if (b && b.ok === true) return { ok: true, result: b.result };
  return { ok: false, error: b?.error ?? `ingest answered ${r.status}` };
}

export type ListenerRequest = {
  id: string;
  title: string;
  artist: string;
  listenerName: string;
  note: string | null;
  createdAt: string;
};

/** Null when ingest is unreachable; `reason` set when the request store is unavailable. */
export async function fetchRequests(): Promise<{ requests: ListenerRequest[]; reason: string | null } | null> {
  const r = await call("/requests");
  if (r.status !== 200 || !r.body) return null;
  const b = r.body as { requests?: ListenerRequest[]; reason?: string | null };
  return { requests: Array.isArray(b.requests) ? b.requests : [], reason: b.reason ?? null };
}

export async function fetchImaging(): Promise<{ items: Array<{ id: string; file: string }>; reason: string | null } | null> {
  const r = await call("/imaging");
  if (r.status !== 200 || !r.body) return null;
  const b = r.body as { items?: Array<{ id: string; file: string }>; reason?: string | null };
  return { items: Array.isArray(b.items) ? b.items : [], reason: b.reason ?? null };
}

/** Title/artist match against the console's own library (case- and space-insensitive). */
export function matchRequest<T extends { id: string; title: string; artist: string }>(req: { title: string; artist: string }, tracks: T[]): T | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const title = norm(req.title);
  const artist = norm(req.artist);
  if (!title) return null;
  return (
    tracks.find((t) => norm(t.title) === title && (!artist || norm(t.artist) === artist)) ??
    null
  );
}
