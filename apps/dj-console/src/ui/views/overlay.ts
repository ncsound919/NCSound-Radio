/**
 * OBS overlay (plan 6.4): a transparent now-playing lower third for an OBS
 * Browser Source. It renders what the console publishes over BroadcastChannel
 * and says "waiting" when nothing is arriving, so it never shows a stale track
 * as if it were live.
 */
import "../tokens.css";
import "./overlay.css";
import { subscribeNowPlaying, formatNowPlaying, type NowPlaying } from "../../audio/nowPlaying";

const STALE_MS = 5000;

export function mountOverlay(root: HTMLElement): void {
  root.innerHTML = "";
  root.className = "nc-overlay-page";

  const el = document.createElement("div");
  el.className = "nc-overlay";
  const lower = document.createElement("div");
  lower.className = "nc-overlay-lower";
  const dot = document.createElement("span");
  dot.className = "nc-overlay-dot";
  const text = document.createElement("div");
  text.className = "nc-overlay-text";
  const title = document.createElement("div");
  title.className = "nc-overlay-title";
  title.textContent = "Waiting for the console…";
  const artist = document.createElement("div");
  artist.className = "nc-overlay-artist";
  text.append(title, artist);
  const dj = document.createElement("div");
  dj.className = "nc-overlay-dj";
  lower.append(dot, text, dj);
  el.append(lower);
  root.append(el);

  let last: NowPlaying | null = null;

  const render = () => {
    const np = last;
    const stale = !np || Date.now() - np.at > STALE_MS;
    if (stale) {
      title.textContent = "Waiting for the console…";
      artist.textContent = "";
      dj.textContent = "";
      dot.dataset.state = "idle";
      return;
    }
    const line = formatNowPlaying(np);
    title.textContent = line || (np.slot === null ? "Silence" : "—");
    artist.textContent = line ? "" : "Nothing playing";
    dj.textContent = np.djName;
    dot.dataset.state = np.onAir === false ? "off" : np.onAir === true ? "live" : "on";
  };

  subscribeNowPlaying((np) => {
    last = np;
    render();
  });
  setInterval(render, 1000);
  render();
}
