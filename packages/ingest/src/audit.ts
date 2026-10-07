/**
 * Append-only audit trail for the access plane.
 *
 * Records who minted/revoked a host/guest credential and who armed/killed the
 * live encoder — the events an operator needs when a slot misbehaves. Disabled
 * unless `INGEST_AUDIT_FILE` is set, so nothing changes for a station that does
 * not want it. Never records a token or a key.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class AuditLog {
  private readonly filePath: string | undefined;

  constructor(filePath: string | undefined = process.env.INGEST_AUDIT_FILE) {
    this.filePath = filePath || undefined;
  }

  get enabled(): boolean {
    return Boolean(this.filePath);
  }

  record(action: string, actor: string, role: string, detail: Record<string, unknown> = {}): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(
        this.filePath,
        JSON.stringify({ at: new Date().toISOString(), action, actor, role, ...detail }) + "\n",
        { mode: 0o600 },
      );
    } catch (e) {
      console.warn(`[ingest] audit write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
