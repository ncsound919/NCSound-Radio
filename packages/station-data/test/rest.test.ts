import { describe, expect, test } from "bun:test";
import { createRestGateways, StationDataError } from "../src/rest.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(
  responder: (call: Call) => { status?: number; body?: unknown } | undefined,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers as HeadersInit);
    const call: Call = {
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const out = responder(call) ?? {};
    const status = out.status ?? 200;
    const text = out.body === undefined ? "" : JSON.stringify(out.body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const base = { url: "https://proj.supabase.co", anonKey: "anon_123" };

describe("supabase rest gateways", () => {
  test("favorites.list filters by kind and sends apikey + bearer", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      body: [{ id: "f1", kind: "artist", ref: "Jaz", created_at: "2026-10-07T00:00:00.000Z" }],
    }));
    const g = createRestGateways({ ...base, getAccessToken: () => "jwt_1", fetchImpl });

    const rows = await g.favorites.list("artist");

    expect(calls[0].url).toBe(
      "https://proj.supabase.co/rest/v1/favorites?select=id,kind,ref,created_at&order=created_at.desc&kind=eq.artist",
    );
    expect(calls[0].headers.apikey).toBe("anon_123");
    expect(calls[0].headers.authorization).toBe("Bearer jwt_1");
    expect(rows).toEqual([{ id: "f1", kind: "artist", ref: "Jaz", createdAt: "2026-10-07T00:00:00.000Z" }]);
  });

  test("favorites.add posts kind+ref and upserts (no user_id)", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      body: [{ id: "f2", kind: "track", ref: "t1", created_at: "2026-10-07T00:00:00.000Z" }],
    }));
    const g = createRestGateways({ ...base, getAccessToken: () => "jwt_1", fetchImpl });

    const row = await g.favorites.add({ kind: "track", ref: "t1" });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ kind: "track", ref: "t1" });
    expect(calls[0].headers.prefer).toContain("resolution=merge-duplicates");
    expect(row.id).toBe("f2");
  });

  test("favorites.remove deletes by kind and ref", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ body: null }));
    const g = createRestGateways({ ...base, getAccessToken: () => "jwt_1", fetchImpl });

    await g.favorites.remove({ kind: "artist", ref: "Jaz & Friends" });

    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain("kind=eq.artist");
    expect(calls[0].url).toContain("ref=eq.Jaz%20%26%20Friends");
  });

  test("prefs.get returns defaults when the user has no row", async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: [] }));
    const g = createRestGateways({ ...base, getAccessToken: () => "jwt_1", fetchImpl });

    expect(await g.prefs.get()).toEqual({ artistOnAir: true, requestPlayed: true, showStart: true });
  });

  test("prefs.update reads, merges the patch and sends snake_case", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.method === "GET") {
        return { body: [{ artist_on_air: true, request_played: true, show_start: true }] };
      }
      return { body: [{ artist_on_air: false, request_played: true, show_start: true }] };
    });
    const g = createRestGateways({ ...base, getAccessToken: () => "jwt_1", fetchImpl });

    const out = await g.prefs.update({ artistOnAir: false });

    expect(out.artistOnAir).toBe(false);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ artist_on_air: false, request_played: true, show_start: true });
  });

  test("devices.upsert maps push_token and re-registers idempotently", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      body: [{ id: "d1", platform: "ios", push_token: "tok", updated_at: "2026-10-07T00:00:00.000Z" }],
    }));
    const g = createRestGateways({ ...base, getAccessToken: () => "jwt_1", fetchImpl });

    const device = await g.devices.upsert({ platform: "ios", pushToken: "tok" });

    expect(calls[0].url).toContain("/rest/v1/devices");
    expect(calls[0].body).toEqual({ platform: "ios", push_token: "tok" });
    expect(device).toEqual({ id: "d1", platform: "ios", pushToken: "tok", updatedAt: "2026-10-07T00:00:00.000Z" });
  });

  test("signed out: no token means no network call and a 401", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ body: [] }));
    const g = createRestGateways({ ...base, getAccessToken: () => null, fetchImpl });

    await expect(g.favorites.list()).rejects.toBeInstanceOf(StationDataError);
    expect(calls).toHaveLength(0);
  });

  test("a PostgREST error surfaces its message", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 409,
      body: { message: "duplicate key value violates unique constraint", code: "23505" },
    }));
    const g = createRestGateways({ ...base, getAccessToken: () => "jwt_1", fetchImpl });

    await expect(g.devices.upsert({ platform: "ios", pushToken: "tok" })).rejects.toThrow(
      "duplicate key value violates unique constraint",
    );
  });
});
