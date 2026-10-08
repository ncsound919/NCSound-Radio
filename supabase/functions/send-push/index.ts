// Supabase Edge Function: send-push.
//
// Supabase-native sender. Delivery is per-platform:
//   - iOS  -> APNs directly (Apple only; NO Firebase), signed with an APNs .p8
//             key (ES256 JWT). This is the default and needs no Google project.
//   - Android -> FCM HTTP v1, ONLY when FCM_SERVICE_ACCOUNT is set. Android has
//             no non-Google OS push channel, so this branch is opt-in; with it
//             unset, Android devices are reported as skipped, never silently
//             dropped.
//
// The caller is trusted infrastructure (the ingest service's "artist on air" /
// "request played" triggers, or a scheduled "show start" job), authenticated
// with a shared secret. It is NOT callable by the app: a device must never be
// able to make the station buzz every other listener.
//
// Deploy:
//   supabase functions deploy send-push --project-ref <ref>
// Secrets (Supabase project):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (service role: reads every device)
//   PUSH_SECRET                              (the caller's x-push-secret)
//   APNS_KEY      (the .p8 contents), APNS_KEY_ID, APNS_TEAM_ID,
//   APNS_TOPIC    (the app bundle id, e.g. com.ncsound.radio)
//   APNS_ENV      (production | sandbox; default production)
//   FCM_SERVICE_ACCOUNT  (optional; Android only)
//
// Not runnable without Deno + those secrets; there is no local Edge Function
// test harness in this repo yet.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type PushEvent = "artist_on_air" | "request_played" | "show_start";

type Body = {
  event: PushEvent;
  title: string;
  body: string;
  /** Limit to one listener; omit to notify everyone who opted in. */
  userId?: string;
  /** Optional deep-link payload, string values only. */
  data?: Record<string, string>;
};

type Device = { push_token: string; platform: "ios" | "android"; user_id: string };

const PREF_BY_EVENT: Record<PushEvent, "artist_on_air" | "request_played" | "show_start"> = {
  artist_on_air: "artist_on_air",
  request_played: "request_played",
  show_start: "show_start",
};

const EVENTS = Object.keys(PREF_BY_EVENT) as PushEvent[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function base64Url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const raw = atob(body);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// --- APNs (iOS) — no Firebase ----------------------------------------------

type ApnsConfig = { key: string; keyId: string; teamId: string; topic: string; host: string };

async function apnsJwt(cfg: ApnsConfig): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: cfg.keyId }));
  const claims = base64Url(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) }));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(cfg.key),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function sendApns(
  cfg: ApnsConfig,
  jwt: string,
  device: Device,
  payload: { title: string; body: string; event: PushEvent; data: Record<string, string> },
): Promise<{ ok: boolean; dead: boolean; error?: string }> {
  const res = await fetch(`https://${cfg.host}/3/device/${device.push_token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": cfg.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
    },
    body: JSON.stringify({
      aps: { alert: { title: payload.title, body: payload.body }, sound: "default" },
      ...payload.data,
      event: payload.event,
    }),
  });
  if (res.ok) return { ok: true, dead: false };
  const text = await res.text();
  // 410 Unregistered, or 400 BadDeviceToken, means prune — not retry forever.
  const reason = /"reason"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  const dead = res.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered";
  return { ok: false, dead, error: `${res.status} ${reason ?? text}` };
}

// --- FCM (Android) — opt-in, only when configured --------------------------

type ServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri?: string };
let cachedToken: { value: string; expiresAt: number } | null = null;

async function fcmAccessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.value;
  const audience = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: audience,
      iat: now,
      exp: now + 3600,
    }),
  )}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  const res = await fetch(audience, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`FCM auth failed: ${res.status} ${await res.text()}`);
  const doc = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!doc.access_token) throw new Error("FCM auth returned no access_token");
  cachedToken = { value: doc.access_token, expiresAt: now + (doc.expires_in ?? 3600) };
  return cachedToken.value;
}

async function sendFcm(
  account: ServiceAccount,
  accessToken: string,
  device: Device,
  payload: { title: string; body: string; event: PushEvent; data: Record<string, string> },
): Promise<{ ok: boolean; dead: boolean; error?: string }> {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          token: device.push_token,
          notification: { title: payload.title, body: payload.body },
          data: { ...payload.data, event: payload.event },
          android: { priority: "high" },
        },
      }),
    },
  );
  if (res.ok) return { ok: true, dead: false };
  const text = await res.text();
  // Prune only on the explicit dead-token signal; INVALID_ARGUMENT is ambiguous.
  const dead = res.status === 404 || /UNREGISTERED/.test(text);
  return { ok: false, dead, error: `${res.status} ${text}` };
}

// --- handler ---------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const expectedSecret = Deno.env.get("PUSH_SECRET");
  const provided = req.headers.get("x-push-secret");
  if (!expectedSecret || !provided || provided !== expectedSecret) {
    return json({ error: "unauthorized" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "not configured" }, 500);

  // APNs config (iOS). Required for iOS delivery.
  const apnsKey = Deno.env.get("APNS_KEY");
  const apnsKeyId = Deno.env.get("APNS_KEY_ID");
  const apnsTeamId = Deno.env.get("APNS_TEAM_ID");
  const apnsTopic = Deno.env.get("APNS_TOPIC");
  const apnsHost =
    (Deno.env.get("APNS_ENV") ?? "production") === "sandbox"
      ? "api.sandbox.push.apple.com"
      : "api.push.apple.com";
  const apns: ApnsConfig | null =
    apnsKey && apnsKeyId && apnsTeamId && apnsTopic
      ? { key: apnsKey, keyId: apnsKeyId, teamId: apnsTeamId, topic: apnsTopic, host: apnsHost }
      : null;

  // FCM config (Android). Optional.
  let account: ServiceAccount | null = null;
  const accountJson = Deno.env.get("FCM_SERVICE_ACCOUNT");
  if (accountJson) {
    try {
      account = JSON.parse(accountJson) as ServiceAccount;
    } catch {
      return json({ error: "FCM_SERVICE_ACCOUNT is not valid JSON" }, 500);
    }
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body.event || !EVENTS.includes(body.event)) {
    return json({ error: `event must be one of ${EVENTS.join(", ")}` }, 400);
  }
  if (!body.title || !body.body) {
    return json({ error: "title and body are required" }, 400);
  }

  const admin = createClient(url, serviceKey);
  const prefColumn = PREF_BY_EVENT[body.event];

  let deviceQuery = admin.from("devices").select("push_token, platform, user_id");
  if (body.userId) deviceQuery = deviceQuery.eq("user_id", body.userId);

  const [{ data: devices, error: devicesError }, { data: prefs }] = await Promise.all([
    deviceQuery,
    admin.from("push_prefs").select("user_id, artist_on_air, request_played, show_start"),
  ]);
  if (devicesError) return json({ error: devicesError.message }, 500);

  const prefByUser = new Map<string, Record<string, boolean>>();
  for (const row of prefs ?? []) {
    prefByUser.set(row.user_id as string, row as Record<string, boolean>);
  }

  const recipients = ((devices ?? []) as Device[]).filter((device) => {
    const pref = prefByUser.get(device.user_id);
    // No row yet means the table defaults (everything on) apply.
    return pref ? pref[prefColumn] !== false : true;
  });

  const payloadFor = (device: Device) => ({
    title: body.title,
    body: body.body,
    event: body.event,
    data: { ...(body.data ?? {}) },
    _device: device,
  });

  const apnsJwtValue = apns ? await apnsJwt(apns) : null;
  const fcmTokenValue = account ? await fcmAccessToken(account) : null;

  let skippedAndroid = 0;
  const results = await Promise.all(
    recipients.map(async (device) => {
      const payload = payloadFor(device);
      if (device.platform === "ios") {
        if (!apns || !apnsJwtValue) return { ok: false, dead: false, error: "APNs not configured" };
        return sendApns(apns, apnsJwtValue, device, payload);
      }
      // android
      if (!account || !fcmTokenValue) {
        skippedAndroid += 1;
        return { ok: false, dead: false, error: "FCM not configured (Android skipped)" };
      }
      return sendFcm(account, fcmTokenValue, device, payload);
    }),
  );

  const deadTokens: string[] = [];
  let sent = 0;
  let failed = 0;
  results.forEach((result, i) => {
    if (result.ok) {
      sent += 1;
      return;
    }
    failed += 1;
    if (result.dead) deadTokens.push(recipients[i].push_token);
  });

  if (deadTokens.length > 0) {
    await admin.from("devices").delete().in("push_token", deadTokens);
  }

  return json({
    event: body.event,
    recipients: recipients.length,
    sent,
    failed,
    skippedAndroid,
    pruned: deadTokens.length,
  });
});
