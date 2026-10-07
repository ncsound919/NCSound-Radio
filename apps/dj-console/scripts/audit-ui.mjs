// Cramped-UI audit (DAW-UI rules): small or packed controls, overlaps, text
// overflow, controls outside the frame, text under 11px.
//   node scripts/audit-ui.mjs <url>...      e.g. http://127.0.0.1:3102/?ui=new
// A state reached by clicking: "<url>@@click:<button name>[@@click:...]".
// Exit code 1 when any issue is found.
import { chromium } from "playwright";
const RULES = { minH: 34, minW: 44, minFont: 11, minGap: 8, overlapPx: 4, gridMinH: 22, gridMinW: 14 };
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
// AUDIT_VIEWPORT=1280x720 to audit a laptop-sized window (default 1480x960).
const [vw, vh] = (process.env.AUDIT_VIEWPORT || "1480x960").split("x").map(Number);
const page = await browser.newPage({ viewport: { width: vw, height: vh } });
let total = 0;
for (const spec of process.argv.slice(2)) {
  const [url, ...steps] = spec.split("@@");
  await page.goto(url, { waitUntil: "load" });
  // Wait for the app to mount before sampling: index.html keeps the legacy
  // markup hidden with `visibility:hidden`, which retains layout boxes, so
  // sampling pre-mount audits the legacy console by mistake.
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-ui-ready"), null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  for (const s of steps) if (s.startsWith("click:")) { await page.locator("button", { hasText: new RegExp(`^\\s*${s.slice(6).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) }).first().click(); await page.waitForTimeout(300); }
  const issues = await page.evaluate((R) => {
    const out = [], name = (el) => (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().replace(/\s+/g, " ").slice(0, 32);
    const fr = (document.querySelector("[data-frame]") || document.body).getBoundingClientRect();
    const visible = (el) => { const r = el.getBoundingClientRect(); let l = r.left, t = r.top, rr = r.right, b = r.bottom;
      for (let a = el.parentElement; a; a = a.parentElement) { const cs = getComputedStyle(a), sc = (o) => o === "auto" || o === "scroll";
        if (!sc(cs.overflowX) && !sc(cs.overflowY)) continue; const c = a.getBoundingClientRect();
        l = Math.max(l, c.left); t = Math.max(t, c.top); rr = Math.min(rr, c.right); b = Math.min(b, c.bottom); }
      return rr - l < 1 || b - t < 1 ? null : { left: l, top: t, right: rr, bottom: b, width: rr - l, height: b - t }; };
    const onTop = (el, v) => { const h = document.elementFromPoint((v.left + v.right) / 2, (v.top + v.bottom) / 2); return !h || h === el || el.contains(h) || h.contains(el); };
    const boxes = [...document.querySelectorAll("button, [role=slider], select, input")].filter((el) => el.getClientRects().length && !el.closest("details:not([open])"))
      .map((el) => ({ el, r: el.getBoundingClientRect(), v: visible(el) })).filter((x) => x.v && onTop(x.el, x.v));
    for (const { el, r, v } of boxes) {
      const grid = el.hasAttribute("data-grid-cell"), sq = r.width >= 40 && r.height >= 40, btn = el.tagName === "BUTTON";
      if (btn && grid && (r.height < R.gridMinH || r.width < R.gridMinW)) out.push(`grid cell ${Math.round(r.width)}x${Math.round(r.height)}: ${name(el)}`);
      if (btn && !grid && !sq && (r.height < R.minH || r.width < R.minW)) out.push(`small ${Math.round(r.width)}x${Math.round(r.height)}: ${name(el)}`);
      if (btn && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) out.push(`text overflows: ${name(el)}`);
      if (v.bottom > fr.bottom + 1 || v.right > fr.right + 1) out.push(`outside frame: ${name(el)}`);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const A = boxes[i], B = boxes[j], a = A.v, b = B.v;
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 0 && h > 0 && w * h > R.overlapPx) { out.push(`overlap: ${name(A.el)} x ${name(B.el)}`); continue; }
      const joined = (A.el.closest(".nc-seg") && A.el.closest(".nc-seg") === B.el.closest(".nc-seg")) || (A.el.hasAttribute("data-grid-cell") && B.el.hasAttribute("data-grid-cell"));
      const gap = Math.max(b.left - a.right, a.left - b.right);
      if (!joined && h > Math.min(a.height, b.height) * 0.5 && gap >= 0 && gap < R.minGap && A.el.tagName === "BUTTON" && B.el.tagName === "BUTTON") out.push(`packed (${Math.round(gap)}px): ${name(A.el)} | ${name(B.el)}`);
    }
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), seen = new Set();
    for (let n = tw.nextNode(); n; n = tw.nextNode()) { const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent.trim() || !el.getClientRects().length || el.closest("option, select, [aria-hidden=true]")) continue;
      seen.add(el); const fs = parseFloat(getComputedStyle(el).fontSize); if (fs < R.minFont - 0.01) out.push(`tiny text (${fs}px): ${n.textContent.trim().slice(0, 32)}`); }
    return [...new Set(out)];
  }, RULES);
  total += issues.length; console.log(`\n${spec} - ${issues.length} issue(s)`); issues.slice(0, 60).forEach((i) => console.log("  - " + i));
  if (issues.length > 60) console.log(`  ... ${issues.length - 60} more`);
}
await browser.close(); process.exitCode = total ? 1 : 0;
