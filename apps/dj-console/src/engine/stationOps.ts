/**
 * Station ops, in the DJ console.
 *
 * The station site already has a control room: submissions review, the rights
 * gate, ad sync, and a stats endpoint. All of it is PIN-gated and all of it
 * lives in station-web's database. Rather than reimplement those decisions
 * against a second connection — two copies of one record, disagreeing — this
 * module reads them over the `/station` proxy and reuses the site's own PIN
 * contract.
 *
 * Deliberate design points:
 *
 *  - **The PIN is never logged or echoed.** It lives in `sessionStorage` for
 *    the tab's lifetime, exactly as station-web's `use-ops-pin` does, and is
 *    sent only as the `x-ops-pin` header on mutating calls.
 *  - **"Unavailable" is never rendered as "none".** If the station site is down
 *    or the database is missing, the panel says so. A review queue that
 *    silently shows an empty list looks identical to a queue that is genuinely
 *    clear, which is the failure mode that lets a clearance slip through.
 *  - **Every write re-reads.** The optimistic "done" state is discarded in
 *    favour of what the database actually says afterwards.
 */

const STATION = "/station";
const PIN_KEY = "ncsound.ops.pin";

type SubmissionStatus = "PENDING" | "IN_REVIEW" | "APPROVED" | "DECLINED";

type Submission = {
  id: string;
  artistName: string;
  trackTitle: string;
  genre: string;
  explicit: boolean;
  city: string | null;
  notes: string | null;
  status: SubmissionStatus;
  createdAt: string;
};

type RightsRecord = {
  id: string;
  trackTitle: string;
  artistName: string;
  sampleStatus: "PENDING" | "CLEARED" | "UNCLEARED";
  status: "PENDING" | "IN_REVIEW" | "CLEARED" | "BLOCKED";
  source: "SUBMISSION" | "CORE";
};

type Stats = {
  library: { tracks: number; cleared: number; pendingRights: number; blocked: number };
  submissions: { pending: number; inReview: number; approved: number; declined: number };
  sponsors: { active: number; monthlyMRR: number };
  adplays: { last7Days: number; today: number };
  listeners: { current: number | null; peak24h: number | null };
};

export type OpsUnavailable = { ok: false; reason: string };

export class StationOps {
  private pin: string | null = null;

  constructor(private readonly onChange: () => void) {
    // Cleared when the tab closes; never written to localStorage, where it would
    // outlive the session and be readable by anything else on the machine.
    try {
      this.pin = sessionStorage.getItem(PIN_KEY);
    } catch {
      this.pin = null;
    }
  }

  get unlocked(): boolean {
    return this.pin !== null;
  }

  authHeaders(): Record<string, string> {
    return this.pin ? { "x-ops-pin": this.pin } : {};
  }

  async unlock(pin: string): Promise<{ ok: boolean; configured?: boolean; error?: string }> {
    try {
      const res = await fetch(`${STATION}/api/ops/auth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; configured?: boolean; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        return { ok: false, error: body?.error ?? `unlock failed (${res.status})` };
      }
      this.pin = pin;
      try {
        sessionStorage.setItem(PIN_KEY, pin);
      } catch {
        /* still unlocked for this tab's lifetime, just not across a reload */
      }
      this.onChange();
      return { ok: true, configured: body.configured };
    } catch {
      return { ok: false, error: "station site is not reachable" };
    }
  }

  lock(): void {
    this.pin = null;
    try {
      sessionStorage.removeItem(PIN_KEY);
    } catch {
      /* nothing to clean up */
    }
    this.onChange();
  }

  /** Every getter resolves to this shape on failure, so callers cannot render a failure as data. */
  private async get<T>(path: string): Promise<{ ok: true; data: T } | OpsUnavailable> {
    try {
      const res = await fetch(`${STATION}${path}`, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (res.status === 502 || res.status === 503) {
        return { ok: false, reason: "station site is not reachable" };
      }
      if (!res.ok) {
        return { ok: false, reason: `station site answered ${res.status}` };
      }
      return { ok: true, data: (await res.json()) as T };
    } catch {
      return { ok: false, reason: "station site is not reachable" };
    }
  }

  stats(): Promise<{ ok: true; data: Stats } | OpsUnavailable> {
    return this.get<Stats>("/api/stats");
  }

  async submissions(): Promise<{ ok: true; data: Submission[] } | OpsUnavailable> {
    const res = await this.get<{ submissions: Submission[] }>("/api/submissions");
    return res.ok ? { ok: true, data: res.data.submissions ?? [] } : res;
  }

  async rights(): Promise<{ ok: true; data: RightsRecord[] } | OpsUnavailable> {
    const res = await this.get<{ rights: RightsRecord[] }>("/api/rights");
    return res.ok ? { ok: true, data: res.data.rights ?? [] } : res;
  }

  /** `PATCH /api/submissions/[id]` — PIN required by the route. */
  async review(
    id: string,
    status: SubmissionStatus,
    reviewNotes?: string,
  ): Promise<{ ok: true } | OpsUnavailable> {
    return this.mutate(`/api/submissions/${encodeURIComponent(id)}`, "PATCH", {
      status,
      ...(reviewNotes ? { reviewNotes } : {}),
    });
  }

  /** `PATCH /api/rights/[id]`. */
  async setRightsStatus(
    id: string,
    status: RightsRecord["status"],
  ): Promise<{ ok: true } | OpsUnavailable> {
    return this.mutate(`/api/rights/${encodeURIComponent(id)}`, "PATCH", { status });
  }

  /** `POST /api/ops/ad-sync` — PIN required by the route. */
  async adSync(): Promise<{ ok: true; inserted: number } | OpsUnavailable> {
    try {
      const res = await fetch(`${STATION}/api/ops/ad-sync`, {
        method: "POST",
        headers: this.authHeaders(),
      });
      if (res.status === 401) return { ok: false, reason: "control room is locked" };
      if (!res.ok) return { ok: false, reason: `ad sync answered ${res.status}` };
      const body = (await res.json()) as { inserted?: number };
      return { ok: true, inserted: body.inserted ?? 0 };
    } catch {
      return { ok: false, reason: "station site is not reachable" };
    }
  }

  private async mutate(
    path: string,
    method: "PATCH" | "POST",
    body: unknown,
  ): Promise<{ ok: true } | OpsUnavailable> {
    try {
      const res = await fetch(`${STATION}${path}`, {
        method,
        headers: { "content-type": "application/json", ...this.authHeaders() },
        body: JSON.stringify(body),
      });
      if (res.status === 401) return { ok: false, reason: "control room is locked" };
      if (res.status === 429) return { ok: false, reason: "rate limited — wait a moment" };
      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
        return { ok: false, reason: parsed?.error ?? `${method} failed (${res.status})` };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "station site is not reachable" };
    }
  }
}

export type { Stats, Submission, RightsRecord, SubmissionStatus };
