/**
 * @ncsound/station-client
 *
 * A typed, dependency-free client for the station-web public API. The listener
 * app (React Native) and the web player share it, so the mount names, response
 * shapes and the offline contract cannot drift between them.
 *
 * What it deliberately does NOT do:
 *  - import zod, or `@ncsound/station-core/http`, at runtime. Response
 *    validation is *injected* (see `validateResponse`), so the React Native
 *    bundler never pulls zod in for a caller that leaves validation off. Only
 *    the type of the schema key crosses the boundary, and types are erased.
 *  - own a base URL from `process.env` (env differs per platform — the caller
 *    passes it, e.g. from `react-native-config`),
 *  - treat the now-playing 503 as an error. Offline is a state the app renders,
 *    not an exception it catches.
 */

import type { ResponseSchemaKey } from "@ncsound/station-core/http";
import type {
  NowPlaying,
  PostRequestInput,
  Requests,
  Schedule,
  StreamDescriptor,
  Tracks,
  TrackRequestResult,
  VideoDescriptor,
} from "./types";

export type * from "./types";

/** Thrown for a non-2xx the caller did not opt into. Carries the server body. */
export class StationApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "StationApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Thrown only when `validateResponses` is on and a 2xx body fails its schema.
 *
 * This is a programming-contract failure, not a network one: the server answered
 * but the shape is not what this client was compiled against. It is separate
 * from `StationApiError` so a caller can tell "the API is down" (retry) from
 * "the API changed under us" (fix the client).
 */
export class StationResponseError extends Error {
  readonly schemaKey: ResponseSchemaKey;
  readonly status: number;
  readonly issues: unknown;
  readonly body: unknown;

  constructor(
    schemaKey: ResponseSchemaKey,
    status: number,
    issues: unknown,
    body: unknown,
  ) {
    super(`response for ${schemaKey} failed validation`);
    this.name = "StationResponseError";
    this.schemaKey = schemaKey;
    this.status = status;
    this.issues = issues;
    this.body = body;
  }
}

/** The slice of a zod `safeParse` result this client reads. Kept structural. */
export type ResponseValidation =
  | { success: true }
  | { success: false; issues: unknown };

/**
 * Injected response validator. Build it from station-core without importing
 * station-core here: `(key, body) => responseSchemas[key].safeParse(body)`.
 *
 * The client never reaches for a schema itself, so leaving this out keeps zod
 * (and station-core) entirely out of the bundle — which is what the React Native
 * app does. Inject it in dev, in CI, and in the mock-server contract test.
 */
export type ResponseValidator = (
  schemaKey: ResponseSchemaKey,
  body: unknown,
) => ResponseValidation;

export type StationClientConfig = {
  /** e.g. `https://api.<domain>` or `http://127.0.0.1:3100`. Trailing slash OK. */
  baseUrl: string;
  /**
   * Returns a Supabase access token, or null when signed out. When present it
   * is sent as a bearer so `POST /api/requests` can attribute the request.
   */
  getAuthToken?: () => string | null | Promise<string | null>;
  /** Injectable for tests / RN's fetch. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Per-request abort time. Default 8000ms. */
  timeoutMs?: number;
  /** Validate every 2xx body before handing it back. Omitted => no validation. */
  validateResponse?: ResponseValidator;
};

export type StationClient = {
  getStream(): Promise<StreamDescriptor>;
  getVideo(): Promise<VideoDescriptor>;
  getNowPlaying(): Promise<NowPlaying>;
  getSchedule(): Promise<Schedule>;
  getRequests(): Promise<Requests>;
  getTracks(): Promise<Tracks>;
  postRequest(input: PostRequestInput): Promise<TrackRequestResult>;
};

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string" && error.length > 0) return error;
  }
  return fallback;
}

export function createStationClient(config: StationClientConfig): StationClient {
  const base = normalizeBase(config.baseUrl);
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 8000;

  async function request<T>(
    path: string,
    init: RequestInit = {},
    opts: { allowStatus?: number[]; schema?: ResponseSchemaKey } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      };
      if (config.getAuthToken) {
        const token = await config.getAuthToken();
        if (token) headers.authorization = `Bearer ${token}`;
      }
      const res = await doFetch(`${base}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      const allowed = opts.allowStatus ?? [];
      if (!res.ok && !allowed.includes(res.status)) {
        throw new StationApiError(
          res.status,
          messageFrom(body, `request failed: ${res.status}`),
          body,
        );
      }

      if (config.validateResponse && opts.schema) {
        const parsed = config.validateResponse(opts.schema, body);
        if (!parsed.success) {
          throw new StationResponseError(opts.schema, res.status, parsed.issues, body);
        }
      }

      return body as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getStream: () =>
      request<StreamDescriptor>("/api/stream", {}, { schema: "getStream" }),
    getVideo: () =>
      request<VideoDescriptor>("/api/video", {}, { schema: "getVideo" }),
    // 503 is the honest offline document, not a failure: return it and let the
    // UI read `mode: "offline"`.
    getNowPlaying: () =>
      request<NowPlaying>("/api/nowplaying", {}, { allowStatus: [503], schema: "getNowPlaying" }),
    getSchedule: () =>
      request<Schedule>("/api/schedule", {}, { schema: "getSchedule" }),
    getRequests: () =>
      request<Requests>("/api/requests", {}, { schema: "getRequests" }),
    getTracks: () =>
      request<Tracks>("/api/tracks", {}, { schema: "getTracks" }),
    postRequest: (input: PostRequestInput) =>
      request<TrackRequestResult>(
        "/api/requests",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        { schema: "postRequest" },
      ),
  };
}

// --- convenience singleton -------------------------------------------------
// The app configures once at startup (with the env base + Supabase token
// getter) and screens import the named functions.

let defaultClient: StationClient | null = null;

export function configureStationClient(config: StationClientConfig): StationClient {
  defaultClient = createStationClient(config);
  return defaultClient;
}

export function stationClient(): StationClient {
  if (!defaultClient) {
    throw new Error(
      "configureStationClient({ baseUrl }) must be called before using station-client",
    );
  }
  return defaultClient;
}

export const getStream = (): Promise<StreamDescriptor> => stationClient().getStream();
export const getVideo = (): Promise<VideoDescriptor> => stationClient().getVideo();
export const getNowPlaying = (): Promise<NowPlaying> => stationClient().getNowPlaying();
export const getSchedule = (): Promise<Schedule> => stationClient().getSchedule();
export const getRequests = (): Promise<Requests> => stationClient().getRequests();
export const getTracks = (): Promise<Tracks> => stationClient().getTracks();
export const postRequest = (input: PostRequestInput): Promise<TrackRequestResult> =>
  stationClient().postRequest(input);
