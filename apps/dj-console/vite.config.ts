import { defineConfig, Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

// In-memory radio station state on the server
let serverRadioState: any = {
  station: {
    name: "Club Horizon Radio",
    slogan: "24/7 Autonomous Underground Electronic & Club Beats",
    genre: "Electronic / House / Techno",
    url: "https://radio.horizon.fm",
    mount: "/live.mp3",
    onAir: true,
    uptimeSec: 3600,
    listeners: 42,
  },
  nowPlaying: {
    id: "builtin-1",
    title: "Midnight Warehouse",
    artist: "Studio Syndicate",
    genre: "Peak Time Techno",
    bpm: 124,
    key: "8A",
    durationSec: 180,
    elapsedSec: 45,
    remainingSec: 135,
  },
  nextTrack: {
    id: "builtin-2",
    title: "Neon Ignition",
    artist: "Cyber Groove",
    bpm: 126,
    key: "9A",
    durationSec: 195,
  },
  broadcast: {
    bitrateKbps: 320,
    sampleRate: 44100,
    dspActive: true,
    jinglesPlayed: 14,
    currentMode: "Autonomous Auto-DJ",
  },
  timestamp: new Date().toISOString(),
};

const serverSongRequests: any[] = [
  {
    id: "req-sample-1",
    timestampMs: Date.now() - 120000,
    timeFormatted: "15:28",
    query: "Acid Horizon 303",
    requester: "Alex (Berlin)",
    message: "Drop some heavy acid synth please!",
    status: "queued",
  },
  {
    id: "req-sample-2",
    timestampMs: Date.now() - 300000,
    timeFormatted: "15:25",
    query: "Deep Velvet Lounge",
    requester: "Maya (Tokyo)",
    message: "Great groove today, love the station!",
    status: "pending",
  },
];

const pendingRemoteCommands: any[] = [];

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function radioApiPlugin(): Plugin {
  return {
    name: "vite-radio-station-api",
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url || "";

        // Enable CORS for external radio widgets and apps
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }

        // 1. GET /api/radio/nowplaying (AzuraCast / Icecast standard now playing JSON)
        if (url === "/api/radio/nowplaying" && req.method === "GET") {
          serverRadioState.timestamp = new Date().toISOString();
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(serverRadioState, null, 2));
          return;
        }

        // 2. GET /api/radio/status (Detailed broadcast telemetry)
        if (url === "/api/radio/status" && req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify(
              {
                ok: true,
                onAir: serverRadioState.station.onAir,
                station: serverRadioState.station,
                nowPlaying: serverRadioState.nowPlaying,
                nextTrack: serverRadioState.nextTrack,
                broadcast: serverRadioState.broadcast,
                requestsCount: serverSongRequests.length,
                pendingCommands: pendingRemoteCommands.length,
              },
              null,
              2
            )
          );
          return;
        }

        // 3. POST /api/radio/sync (Client updates the server memory state)
        if (url === "/api/radio/sync" && req.method === "POST") {
          const body = await parseBody(req);
          if (body && typeof body === "object") {
            serverRadioState = { ...serverRadioState, ...body, timestamp: new Date().toISOString() };
          }
          // Also return any pending remote commands
          const commands = [...pendingRemoteCommands];
          pendingRemoteCommands.length = 0;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, synced: true, commands }));
          return;
        }

        // 4. POST /api/radio/request (Listener submits song request)
        if (url === "/api/radio/request" && req.method === "POST") {
          const body = await parseBody(req);
          if (!body.query) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "Missing query in request" }));
            return;
          }
          const now = new Date();
          const timeFormatted = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
          const newReq = {
            id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestampMs: Date.now(),
            timeFormatted,
            query: String(body.query).slice(0, 120),
            requester: String(body.requester || "Online Listener").slice(0, 60),
            message: String(body.message || "").slice(0, 200),
            status: "pending",
          };
          serverSongRequests.unshift(newReq);
          if (serverSongRequests.length > 50) serverSongRequests.pop();

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, message: "Song request received by online radio station", request: newReq }));
          return;
        }

        // 5. GET /api/radio/requests (Fetch inbound request queue)
        if (url === "/api/radio/requests" && req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, requests: serverSongRequests }));
          return;
        }

        // 6. POST /api/radio/control (Remote control for station bot / scripts)
        if (url === "/api/radio/control" && req.method === "POST") {
          const body = await parseBody(req);
          if (!body.command) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "Missing command" }));
            return;
          }
          pendingRemoteCommands.push(body);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, message: `Command '${body.command}' scheduled for execution`, command: body }));
          return;
        }

        // 7. POST /api/radio/webhook-test (Test sending webhook)
        if (url === "/api/radio/webhook-test" && req.method === "POST") {
          const body = await parseBody(req);
          const targetUrl = body.webhookUrl;
          if (!targetUrl) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "Missing webhookUrl" }));
            return;
          }
          try {
            const testPayload = {
              event: "track_change",
              station: serverRadioState.station,
              nowPlaying: serverRadioState.nowPlaying,
              test: true,
              timestamp: new Date().toISOString(),
            };
            const fetchRes = await fetch(targetUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(testPayload),
            });
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: fetchRes.ok, status: fetchRes.status, statusText: fetchRes.statusText }));
          } catch (err: any) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
          return;
        }

        // 8. GET /api/radio/stream-info (ICY Stream Header Text)
        if (url === "/api/radio/stream-info" && req.method === "GET") {
          const icyTitle = `${serverRadioState.nowPlaying.artist} - ${serverRadioState.nowPlaying.title}`;
          res.setHeader("Content-Type", "text/plain");
          res.setHeader("icy-name", serverRadioState.station.name);
          res.setHeader("icy-genre", serverRadioState.station.genre);
          res.setHeader("icy-url", serverRadioState.station.url);
          res.setHeader("icy-br", String(serverRadioState.broadcast.bitrateKbps));
          res.end(`StreamTitle='${icyTitle}';StreamUrl='${serverRadioState.station.url}';`);
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [radioApiPlugin()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    allowedHosts: true,
    hmr: false,
  },
  preview: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    allowedHosts: true,
  },
});
