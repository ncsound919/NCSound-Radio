/**
 * NCSound DJ Console — Windows beta shell (Electron).
 *
 *   The DJ booth, standalone. The full console UI is served from the built
 *   `dist/`, and the DJ side (decks, mixer, FX, sampler, library, MIDI,
 *   recording) is fully live.
 *
 *   This beta deliberately does NOT include the station backend. The `/ingest`,
 *   `/station`, `/transcode` and `/vectorize` endpoints — which the Vite dev
 *   server proxies to the engine / Workers — are answered here with a clear
 *   "not in this beta" 404, so the station/OBS/requests panels stay visible but
 *   inert instead of hanging on a proxy that is not there.
 *
 *   The UI is served over http://127.0.0.1:<random> rather than file:// so ES
 *   modules, the analysis Web Worker and the PWA manifest all resolve against a
 *   real origin.
 */
const { app, BrowserWindow, Menu, shell } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/** Backends the dev server proxies; absent from this beta. */
const STATION_PREFIXES = ["/ingest", "/station", "/transcode", "/vectorize"];

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }

      if (STATION_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "The station backend is not included in this beta build." }));
        return;
      }

      if (pathname === "/") pathname = "/index.html";
      let file = path.join(DIST, pathname);
      if (!file.startsWith(DIST)) {
        res.writeHead(403);
        res.end();
        return;
      }

      fs.stat(file, (err, stat) => {
        // Missing -> fall back to the single-page shell.
        if (err || !stat.isFile()) file = path.join(DIST, "index.html");
        res.setHeader("content-type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
        fs.createReadStream(file)
          .on("error", () => {
            res.writeHead(404);
            res.end();
          })
          .pipe(res);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function createWindow() {
  const port = await startServer();
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#0b0b12",
    title: "NCSound DJ Console (Beta)",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  win.once("ready-to-show", () => {
    win.maximize();
    win.show();
  });
  // Open any external link in the OS browser rather than inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  void createWindow();
});

app.on("window-all-closed", () => app.quit());
