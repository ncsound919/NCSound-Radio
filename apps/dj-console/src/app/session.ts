/**
 * Who is using this console.
 *
 * The owner's console is served by the owner's own vite server, whose proxy
 * adds the master token to every request, so ingest sees the owner. A host or
 * guest opens an invite link on the guest server (no token injection) instead:
 * `https://<guest-host>/#invite=ncs_…`. The token is moved into sessionStorage
 * (per tab, gone when the tab closes), stripped from the address bar, and sent
 * as `Authorization: Bearer` on every call. Ingest decides what that token may
 * do; this module only lets the UI avoid offering buttons that will be refused.
 *
 * The UI hiding is a courtesy. The permission table that matters is
 * `packages/ingest/src/permissions.ts`, enforced server-side.
 */

export type Who = {
  kind: "master" | "session";
  role: string;
  label: string;
  canLive: boolean;
  expiresAt: string | null;
  /** Command types this caller may issue (from ingest). */
  commands: string[];
  /** GET paths this caller may read; null = unrestricted (owner). */
  reads: string[] | null;
};

const KEY = "nc.session.token";
let token: string | null = null;
let who: Who | null = null;

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Pick an invite token off the URL fragment (once), else fall back to this tab's saved one. */
function captureInvite(): void {
  const m = /(?:^|[#&])invite=([A-Za-z0-9_]+)/.exec(location.hash);
  if (m) {
    token = m[1];
    try {
      store()?.setItem(KEY, token);
    } catch {
      /* private mode: the token lives in memory for this load only */
    }
    history.replaceState(null, "", location.pathname + location.search);
    return;
  }
  try {
    token = store()?.getItem(KEY) ?? null;
  } catch {
    token = null;
  }
}

export function sessionToken(): string | null {
  return token;
}

/** Headers to add to every ingest call; empty for the owner. */
export function authHeaders(): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function getWho(): Who | null {
  return who;
}

/** True for a host/guest session. The owner (and an offline console) is unrestricted. */
export function isRestricted(): boolean {
  return who?.kind === "session";
}

/** May this caller issue this command? Unknown identity (owner/offline) = yes; ingest still decides. */
export function can(commandType: string): boolean {
  return !who || who.kind === "master" || who.commands.includes(commandType);
}

export function canRead(path: string): boolean {
  return !who || who.reads === null || who.reads.includes(path);
}

export type InitResult = { ok: true; who: Who | null } | { ok: false; message: string };

/**
 * Resolve identity before the UI is built. A saved/URL token that ingest
 * rejects is a hard stop with a clear message, not a console full of failures.
 */
export async function initSession(): Promise<InitResult> {
  captureInvite();
  try {
    const res = await fetch("/ingest/whoami", { headers: { accept: "application/json", ...authHeaders() }, cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      who = (await res.json()) as Who;
      return { ok: true, who };
    }
    if (token && (res.status === 401 || res.status === 403)) {
      try {
        store()?.removeItem(KEY);
      } catch {
        /* ignore */
      }
      token = null;
      return { ok: false, message: "This invite has expired or was revoked. Ask the station for a new link." };
    }
  } catch {
    if (token) return { ok: false, message: "The station can't be reached right now. Check your connection and reload this page." };
  }
  // No token and no answer: a plain local console with the station offline. Unrestricted, as before.
  return { ok: true, who: null };
}

/** Full-page notice used when an invite can't be used. */
export function showBlocked(message: string): void {
  document.body.innerHTML = "";
  const p = document.createElement("p");
  p.setAttribute("role", "alert");
  p.style.cssText = "font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1rem;color:#ddd";
  p.textContent = message;
  document.body.append(p);
}
