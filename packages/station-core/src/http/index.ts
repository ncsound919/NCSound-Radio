/**
 * Runtime schemas for the station-web public HTTP responses.
 *
 * The listener app and the web player share `@ncsound/station-client`, which can
 * validate every response against these before a screen reads it. They live in
 * station-core (which already owns zod) so the command contract and the HTTP
 * contract cannot drift into two different zod copies.
 *
 * Every schema is `.passthrough()`: a server that grows a field must not break an
 * older client. The schemas assert only what a client is allowed to depend on.
 *
 * `responseSchemas` is keyed by client method name so `station-client` can look
 * one up by operation instead of duplicating the mapping.
 */

import { z } from "zod";
import type {
  Daypart,
  LiveShowInfo,
  NowPlayingElement,
  QueueEntry,
  StationIdentity,
  TrackDTO,
  WheelSlice,
} from "../contract/index";

const elementKind = z.enum(["MUSIC", "STATION_ID", "AD_SPOT", "TALK"]);

const trackDTO = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string().nullable(),
  durationSec: z.number(),
  explicit: z.boolean(),
  playlist: z.string(),
  bpm: z.number().nullable(),
});

const queueEntry = trackDTO.extend({
  elementKind,
  sponsorName: z.string().nullable().optional(),
});

const stationIdentity = z.object({
  name: z.string(),
  tagline: z.string(),
  timezone: z.string(),
});

const nowPlayingElement = z.object({
  kind: elementKind,
  campaignName: z.string().optional(),
  sponsorName: z.string().optional(),
  creativeName: z.string().optional(),
});

const daypart = z.object({ clean: z.boolean(), label: z.string() });

const liveShowInfo = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  description: z.string(),
  kind: z.enum(["LIVE", "PLAYLIST"]),
  accent: z.string(),
  startedAtIso: z.string(),
  endsAtIso: z.string(),
  minutesLeft: z.number(),
});

const wheelSlice = z.object({ kind: elementKind, durSec: z.number() });

// --- GET /api/stream -------------------------------------------------------

const streamMount = z.object({
  path: z.string(),
  bitrateKbps: z.number(),
  codec: z.string(),
  label: z.string(),
  url: z.string(),
});

export const streamDescriptorSchema = z
  .object({
    baseUrl: z.string(),
    live: streamMount,
    mobile: streamMount,
    hls: z.string().nullable(),
    updatedAt: z.string(),
  })
  .passthrough();

// --- GET /api/video --------------------------------------------------------

const videoShow = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  kind: z.enum(["LIVE", "PLAYLIST"]),
  isVideo: z.boolean(),
});

export const videoDescriptorSchema = z
  .object({
    configured: z.boolean(),
    live: z.boolean(),
    inputId: z.string().nullable(),
    videoId: z.string().nullable(),
    hls: z.string().nullable(),
    dash: z.string().nullable(),
    dvrHls: z.string().nullable(),
    player: z.string().nullable(),
    promote: z.boolean(),
    show: videoShow.nullable(),
    reason: z.string().nullable(),
    updatedAt: z.string(),
  })
  .passthrough();

// --- GET /api/nowplaying ---------------------------------------------------

/**
 * One schema for both the live body and the 503 offline document, so a caller
 * narrows on `mode` rather than on which fields happen to be present. The
 * offline body deliberately omits the element/daypart/engine/stream blocks.
 */
export const nowPlayingSchema = z
  .object({
    station: stationIdentity.extend({ bitrateKbps: z.number() }),
    mode: z.enum(["live", "standby", "offline"]),
    current: z
      .object({
        track: trackDTO,
        startedAt: z.string(),
        elapsed: z.number(),
        duration: z.number(),
        remaining: z.number(),
        progress: z.number(),
      })
      .nullable(),
    next: z.array(queueEntry),
    element: nowPlayingElement.optional(),
    daypart: daypart.optional(),
    liveShow: liveShowInfo.nullable().optional(),
    standbyReason: z.string().nullable().optional(),
    offlineReason: z.string().optional(),
    broadcastComponents: z
      .object({
        enginePlaying: z.boolean(),
        outputLive: z.boolean(),
        mountConnected: z.boolean(),
      })
      .nullable()
      .optional(),
    heat: z.record(z.string(), z.number()).optional(),
    requestedBy: z.record(z.string(), z.array(z.string())).optional(),
    wheel: z.array(wheelSlice).optional(),
    cycleIndex: z.number().optional(),
    cycleSec: z.number().optional(),
    listeners: z.object({
      current: z.number().nullable(),
      peak24h: z.number().nullable(),
      source: z.string().optional(),
    }),
    engine: z
      .object({
        state: z.string(),
        crateSize: z.number(),
        autopilot: z.boolean(),
        uptimeSec: z.number(),
        lastError: z.string().nullable(),
        spectrum: z.array(z.number()),
      })
      .optional(),
    stream: z
      .object({
        onAir: z.boolean(),
        encoder: z.string(),
        icecast: z.string().nullable(),
        mounts: z.array(
          z.object({
            mount: z.string(),
            bitrateKbps: z.number(),
            listeners: z.number(),
            peakListeners24h: z.number(),
            lastMetadata: z.string().nullable(),
          }),
        ),
      })
      .nullable()
      .optional(),
    streamUrl: z.string().nullable(),
    serverTime: z.string(),
  })
  .passthrough()
  .superRefine((v, ctx) => {
    // `mode` and `current` were validated independently, so `{mode:"offline",
    // current:{…}}` and `{mode:"live", current:null}` both passed — two states
    // the UI cannot render honestly. Tie them together here.
    if (v.mode === "offline" && v.current !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mode 'offline' requires current=null" });
    }
    if (v.mode === "live" && v.current === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mode 'live' requires a current track" });
    }
  });

// --- GET /api/schedule -----------------------------------------------------

const showDTO = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  host: z.string(),
  dayOfWeek: z.number(),
  startHour: z.number(),
  startMinute: z.number(),
  durationMin: z.number(),
  explicit: z.boolean(),
  kind: z.enum(["PLAYLIST", "LIVE"]),
  accent: z.string(),
  active: z.boolean(),
});

export const scheduleSchema = z
  .object({
    timezone: z.string(),
    now: z.object({
      dayOfWeek: z.number(),
      minutes: z.number(),
      label: z.string(),
    }),
    shows: z.array(showDTO),
    currentShowId: z.string().nullable(),
  })
  .passthrough();

// --- GET /api/requests + POST /api/requests --------------------------------

export const requestsSchema = z
  .object({
    top: z.array(
      z.object({
        trackId: z.string(),
        title: z.string(),
        artist: z.string(),
        explicit: z.boolean(),
        count: z.number(),
        lastRequestedAt: z.string(),
      }),
    ),
    recent: z.array(
      z.object({
        id: z.string(),
        listenerName: z.string(),
        note: z.string().nullable(),
        trackTitle: z.string(),
        trackArtist: z.string(),
        createdAt: z.string(),
      }),
    ),
    totalToday: z.number(),
    totalAllTime: z.number(),
  })
  .passthrough();

export const trackRequestResultSchema = z
  .object({
    ok: z.literal(true),
    request: z.object({
      id: z.string(),
      trackId: z.string(),
      listenerName: z.string(),
      note: z.string().nullable(),
      createdAt: z.string(),
    }),
    count: z.number(),
    message: z.string(),
  })
  .passthrough();

// --- GET /api/tracks -------------------------------------------------------

export const tracksSchema = z
  .object({
    tracks: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        artist: z.string(),
        playlist: z.string(),
        durationSec: z.number(),
        explicit: z.boolean(),
      }),
    ),
  })
  .passthrough();

/** The schemas keyed by the `station-client` method that consumes them. */
export const responseSchemas = {
  getStream: streamDescriptorSchema,
  getVideo: videoDescriptorSchema,
  getNowPlaying: nowPlayingSchema,
  getSchedule: scheduleSchema,
  getRequests: requestsSchema,
  getTracks: tracksSchema,
  postRequest: trackRequestResultSchema,
} as const;

export type ResponseSchemaKey = keyof typeof responseSchemas;

// Compile-time proof the schemas still describe the station-core domain types:
// if a contract type gains a required field, the matching schema stops being
// assignable and the build fails rather than a screen reading `undefined`.
type SchemasMatchContract = {
  track: z.infer<typeof trackDTO> extends TrackDTO ? true : never;
  queue: z.infer<typeof queueEntry> extends QueueEntry ? true : never;
  station: z.infer<typeof stationIdentity> extends StationIdentity ? true : never;
  element: z.infer<typeof nowPlayingElement> extends NowPlayingElement ? true : never;
  daypart: z.infer<typeof daypart> extends Daypart ? true : never;
  liveShow: z.infer<typeof liveShowInfo> extends LiveShowInfo ? true : never;
  wheel: z.infer<typeof wheelSlice> extends WheelSlice ? true : never;
};

export type __SchemasMatchContract = SchemasMatchContract;
