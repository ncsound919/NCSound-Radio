/**
 * Owner-only: mint invite links for a morning-show host or a guest DJ, see who
 * holds one, and revoke it. Lives in Settings, and is not built for a
 * host/guest console.
 *
 * Every call goes to ingest's `/sessions` routes, which refuse anyone but the
 * owner; this panel is the convenience, not the control. The token is shown
 * once, in the link, and cannot be retrieved afterwards.
 */

type SessionRow = { id: string; role: string; label: string; canLive: boolean; expiresAt: string };

const GUEST_URL_KEY = "ncsound.console.guestUrl";

function loadGuestUrl(): string {
  try {
    return localStorage.getItem(GUEST_URL_KEY) ?? (import.meta.env.VITE_GUEST_URL as string | undefined) ?? "";
  } catch {
    return (import.meta.env.VITE_GUEST_URL as string | undefined) ?? "";
  }
}

async function api(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  try {
    const res = await fetch(`/ingest${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function invitesPanel(): HTMLElement {
  const root = el("details", "nc-settings-fold");
  root.append(el("summary", undefined, "Hosts & guests"));
  const field = el("div", "nc-settings-field");
  root.append(field);

  const urlIn = el("input");
  urlIn.type = "url";
  urlIn.placeholder = "Guest console URL, e.g. https://guest.example.com";
  urlIn.value = loadGuestUrl();
  urlIn.setAttribute("aria-label", "Guest console URL");
  urlIn.addEventListener("change", () => {
    try {
      localStorage.setItem(GUEST_URL_KEY, urlIn.value.trim());
    } catch {
      /* not persisted */
    }
  });

  const role = el("select");
  role.setAttribute("aria-label", "Role");
  for (const [v, t] of [["guest", "Guest DJ"], ["host", "Morning show host"]] as const) {
    const o = el("option", undefined, t);
    o.value = v;
    role.append(o);
  }
  const label = el("input");
  label.placeholder = "Name (shown on their console)";
  label.maxLength = 60;
  label.setAttribute("aria-label", "Name");
  const hours = el("select");
  hours.setAttribute("aria-label", "Valid for");
  for (const h of [2, 4, 8, 24]) {
    const o = el("option", undefined, `${h} hours`);
    o.value = String(h);
    hours.append(o);
  }
  hours.value = "4";
  const liveBox = el("input");
  liveBox.type = "checkbox";
  liveBox.checked = true;
  const liveLbl = el("label", undefined, " May go live");
  liveLbl.prepend(liveBox);

  const create = el("button", "nc-settings-btn", "Create invite");
  create.type = "button";
  const linkOut = el("input");
  linkOut.readOnly = true;
  linkOut.hidden = true;
  linkOut.setAttribute("aria-label", "Invite link");
  const copy = el("button", "nc-settings-btn", "Copy link");
  copy.type = "button";
  copy.hidden = true;
  const note = el("p", "nc-settings-note");
  note.setAttribute("role", "status");
  const list = el("div");

  field.append(urlIn, role, label, hours, liveLbl, create, linkOut, copy, note, list);

  const refresh = async () => {
    const r = await api("/sessions");
    list.innerHTML = "";
    if (r.status === 403 || r.status === 401) {
      note.textContent = "Only the station owner can manage invites.";
      return;
    }
    if (r.status !== 200) {
      note.textContent = "The station engine is not reachable.";
      return;
    }
    const rows: SessionRow[] = r.body?.sessions ?? [];
    if (rows.length === 0) list.append(el("p", "nc-settings-note", "No active invites."));
    for (const s of rows) {
      const row = el("div");
      const mins = Math.max(0, Math.round((Date.parse(s.expiresAt) - Date.now()) / 60_000));
      row.append(el("span", undefined, `${s.label} · ${s.role}${s.canLive ? "" : " · no live"} · ${mins >= 60 ? `${Math.round(mins / 60)} h` : `${mins} min`} left `));
      const revoke = el("button", "nc-settings-btn", "Revoke");
      revoke.type = "button";
      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        const rr = await api("/sessions/revoke", { id: s.id });
        note.textContent = rr.status === 200 ? `Revoked ${s.label}${rr.body?.killedLive ? " and took them off the air" : ""}.` : "Could not revoke.";
        void refresh();
      });
      row.append(revoke);
      list.append(row);
    }
  };

  create.addEventListener("click", async () => {
    const base = urlIn.value.trim().replace(/\/+$/, "");
    if (!base) {
      note.textContent = "Enter the guest console URL first: the address you expose, not this console.";
      return;
    }
    if (!label.value.trim()) {
      note.textContent = "Give them a name.";
      return;
    }
    create.disabled = true;
    const r = await api("/sessions", { role: role.value, label: label.value.trim(), ttlMin: Number(hours.value) * 60, canLive: liveBox.checked });
    create.disabled = false;
    if (r.status !== 200) {
      note.textContent = r.status === 400 && r.body?.error ? String(r.body.error) : r.status === 0 ? "The station engine is not reachable." : `Could not create the invite (${r.status}).`;
      return;
    }
    linkOut.value = `${base}/#invite=${r.body.token}`;
    linkOut.hidden = copy.hidden = false;
    note.textContent = "Send this link only to them. It is shown once and expires on its own.";
    label.value = "";
    void refresh();
  });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(linkOut.value);
      note.textContent = "Copied.";
    } catch {
      linkOut.select();
      note.textContent = "Select the link and copy it.";
    }
  });

  root.addEventListener("toggle", () => {
    if (root.open) void refresh();
  });
  return root;
}
