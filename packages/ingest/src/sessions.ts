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
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

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

  issue(input: { role: SessionRole; label: string; ttlMs: number; canLive?: boolean }): { session: Session; token: string } {
    const ttl = Math.min(Math.max(input.ttlMs, 60_000), MAX_SESSION_TTL_MS);
    const token = `ncs_${randomBytes(24).toString("hex")}`;
    const at = this.now();
    const stored: Stored = {
      id: randomUUID(),
      role: input.role,
      label: input.label,
      canLive: input.canLive ?? true,
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + ttl).toISOString(),
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
