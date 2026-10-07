/**
 * Requests tab (plan 5.7): listener requests from the station database,
 * newest first, read through ingest `/requests`.
 *
 * Per request:
 *   - Cue for autopilot: `cue.request`. Ingest resolves the request to a crate
 *     track and loads it on the engine's idle deck; the result is shown.
 *   - Load to deck: only when the same title/artist is in THIS console's
 *     library (otherwise the button isn't offered).
 *   - Dismiss: hides it on this console only. The station database is
 *     read-only to ingest by design, and the tab says so.
 *
 * Polled every 10 s, only in Radio mode.
 */
import type { ConsoleAudio } from "../../audio/engine";
import type { LibraryController } from "../../library/controller";
import { libraryStore } from "../../library/controller";
import { consoleStore } from "../../state/console";
import { fetchRequests, matchRequest, stationCommand, type ListenerRequest } from "../../radio/station";
import { key } from "../controls";

const DISMISSED_KEY = "ncsound.console.requests.dismissed";

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function loadDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function requestsView(audio: ConsoleAudio, library: LibraryController): HTMLElement {
  const el = div("nc-reqs");
  const head = div("nc-bcast-row");
  const status = div("nc-bcast-note");
  const refresh = key({ label: "Refresh", onPress: () => void load() });
  head.append(refresh.el, status);
  const list = div("nc-reqs-list");
  const foot = div("nc-bcast-note", "Dismiss hides a request on this console only; the station's list is not changed.");
  el.append(head, list, foot);

  const dismissed = loadDismissed();
  const saveDismissed = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed].slice(-500)));
    } catch {
      /* storage blocked */
    }
  };
  let rows: ListenerRequest[] = [];
  const feedback = new Map<string, string>();

  const render = () => {
    list.innerHTML = "";
    const visible = rows.filter((r) => !dismissed.has(r.id));
    if (!visible.length) {
      list.append(div("nc-bcast-note", rows.length ? "All requests dismissed." : "No requests."));
      return;
    }
    const tracks = libraryStore.get().tracks;
    for (const r of visible) {
      const row = div("nc-req");
      const text = div("nc-req-text");
      text.append(
        div("nc-req-title", `${r.artist ? `${r.artist} – ` : ""}${r.title}`),
        div("nc-req-meta", `for ${r.listenerName || "a listener"} · ${ago(r.createdAt)}${r.note ? ` · “${r.note}”` : ""}`),
      );
      const fb = feedback.get(r.id);
      if (fb) text.append(div("nc-req-fb", fb));
      const actions = div("nc-req-actions");
      const cue = key({
        label: "Cue for autopilot",
        onPress: async () => {
          cue.setDisabled(true);
          const res = await stationCommand({ type: "cue.request", requestId: r.id });
          feedback.set(r.id, res.ok ? "Cued on the engine's idle deck." : `Not cued: ${res.error}`);
          render();
        },
      });
      actions.append(cue.el);
      const match = matchRequest(r, tracks);
      if (match) {
        const load = key({
          label: "Load to deck",
          onPress: async () => {
            const idle = audio.deck(0).playing ? 1 : 0;
            const ok = await library.loadToDeck(idle, match.id, { refuseIfPlaying: true });
            feedback.set(r.id, ok ? `Loaded on deck ${idle ? "B" : "A"}.` : "Not loaded: both decks are playing.");
            render();
          },
        });
        actions.append(load.el);
      }
      const dismiss = key({
        label: "Dismiss",
        onPress: () => {
          dismissed.add(r.id);
          saveDismissed();
          render();
        },
      });
      actions.append(dismiss.el);
      row.append(text, actions);
      list.append(row);
    }
  };

  async function load(): Promise<void> {
    const res = await fetchRequests();
    if (!res) {
      status.textContent = "The station engine is not reachable, so requests can't be read.";
      rows = [];
    } else if (res.reason) {
      status.textContent = `Requests unavailable: ${res.reason}`;
      rows = [];
    } else {
      const shown = res.requests.filter((r) => !dismissed.has(r.id)).length;
      status.textContent = `${shown} request${shown === 1 ? "" : "s"} · updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      rows = [...res.requests].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    }
    render();
  }

  let timer: number | null = null;
  consoleStore.select((s) => s.mode, (mode) => {
    if (mode === "radio" && timer === null) {
      void load();
      timer = window.setInterval(() => void load(), 10_000);
    } else if (mode !== "radio" && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  });
  libraryStore.select((s) => s.tracks, () => render());
  return el;
}
