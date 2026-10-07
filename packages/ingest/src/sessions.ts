/**
 * Scoped, expiring credentials for people other than the station owner.
 *
 * The master `INGEST_TOKEN` stays the owner's credential. A session is a second
 * kind of bearer token the owner mints for a morning-show host or a guest DJ:
 * it carries a role, an expiry and a `canLive` flag, and it can be revoked
 * without touching anyone else. The server derives the caller's identity from
 * the token, never from anything the client says about itself.
 *
 * Tokens are shown once, at issue. Only a SHA-256 of each token is kept (in
 * memory, and in `filePath` if given), so a copy of the sessions file cannot be
 * replayed as credentials.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SessionRole = "host" | "guest";

export type Session = {
  id: string;
  role: SessionRole;
  label: string;
  /** May arm the encoder and stream audio to the station. */
  canLive: boolean;
  /** Earliest time this credential may act (ISO), or null for "now". */
  notBefore: string | null;
  /** Latest time this credential may act (ISO), or null for "no slot end". */
  notAfter: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

/**
 * Is the session's scheduled slot open at `at` (ms)? Missing bounds are open.
 * A `notAfter` is also baked into `expiresAt` at issue time, so the live-expiry
 * machinery already drops the air at slot end; this additionally refuses an
 * early arm before `notBefore`.
 */
export function withinSlot(s: Session, at = Date.now()): boolean {
  if (s.notBefore && Number.isFinite(Date.parse(s.notBefore)) && at < Date.parse(s.notBefore)) return false;
  if (s.notAfter && Number.isFinite(Date.parse(s.notAfter)) && at > Date.parse(s.notAfter)) return false;
  return true;
}

type Stored = Session & { tokenHash: string };

export const MAX_SESSION_TTL_MS = 24 * 60 * 60_000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class SessionStore {
  private readonly byHash = new Map<string, Stored>();
  private readonly byId = new Map<string, Stored>();
  private readonly now: () => number;
  private readonly filePath: string | undefined;

  constructor(opts: { now?: () => number; filePath?: string } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.filePath = opts.filePath || undefined;
    this.load();
  }

  issue(input: {
    role: SessionRole;
    label: string;
    ttlMs: number;
    canLive?: boolean;
    /** Earliest time this credential may act (ISO); an earlier arm is refused. */
    notBefore?: string;
    /** Latest time this credential may act (ISO); the session also expires then. */
    notAfter?: string;
  }): { session: Session; token: string } {
    const ttl = Math.min(Math.max(input.ttlMs, 60_000), MAX_SESSION_TTL_MS);
    const token = `ncs_${randomBytes(24).toString("hex")}`;
    const at = this.now();
    // A slot end also ends the credential: clamp expiresAt to notAfter so the
    // existing "lapsed session loses the air" path enforces the slot's end.
    const slotEnd = input.notAfter ? Date.parse(input.notAfter) : NaN;
    const expires = Number.isFinite(slotEnd) ? Math.min(at + ttl, slotEnd) : at + ttl;
    const stored: Stored = {
      id: randomUUID(),
      role: input.role,
      label: input.label,
      canLive: input.canLive ?? true,
      notBefore: input.notBefore ?? null,
      notAfter: input.notAfter ?? null,
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      revokedAt: null,
      tokenHash: hash(token),
    };
    this.byHash.set(stored.tokenHash, stored);
    this.byId.set(stored.id, stored);
    this.save();
    return { session: this.pub(stored), token };
  }

  /** The live session for this token, or null if unknown, expired or revoked. */
  verify(token: string): Session | null {
    if (!token.startsWith("ncs_")) return null;
    const s = this.byHash.get(hash(token));
    if (!s || s.revokedAt || Date.parse(s.expiresAt) <= this.now()) return null;
    return this.pub(s);
  }

  revoke(id: string): boolean {
    const s = this.byId.get(id);
    if (!s || s.revokedAt) return false;
    s.revokedAt = new Date(this.now()).toISOString();
    this.save();
    return true;
  }

  /** Still usable right now (exists, not revoked, not expired). */
  isActive(id: string): boolean {
    const s = this.byId.get(id);
    return !!s && !s.revokedAt && Date.parse(s.expiresAt) > this.now();
  }

  /** Sessions that are still usable, newest first. Never includes tokens. */
  list(): Session[] {
    const at = this.now();
    return [...this.byId.values()]
      .filter((s) => !s.revokedAt && Date.parse(s.expiresAt) > at)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => this.pub(s));
  }

  private pub({ tokenHash: _h, ...session }: Stored): Session {
    return session;
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const rows = JSON.parse(readFileSync(this.filePath, "utf8")) as Stored[];
      const cutoff = this.now() - MAX_SESSION_TTL_MS; // drop long-dead rows
      for (const s of rows) {
        if (Date.parse(s.expiresAt) < cutoff) continue;
        this.byHash.set(s.tokenHash, s);
        this.byId.set(s.id, s);
      }
    } catch {
      /* a corrupt file means no sessions, which is the safe failure */
    }
  }

  private save(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.byId.values()]), { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn(`[ingest] could not persist sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
