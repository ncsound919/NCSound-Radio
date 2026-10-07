// Supabase Edge Function: delete-account.
//
// App Store guideline 5.1.1(v) requires in-app account deletion. The client
// calls this with its own session JWT; the function identifies the caller,
// then deletes that user with the service role. The `on delete cascade` FKs on
// profiles / favorites / devices / push_prefs remove their rows.
//
// Deploy (Supabase CLI):
//   supabase functions deploy delete-account --project-ref <ref>
// Secrets that must be set on the project:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// (SUPABASE_URL / SUPABASE_ANON_KEY are injected by the platform; the service
// role key must be set explicitly and never ships to the app.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!url || !anon || !service || !jwt) {
    return new Response(JSON.stringify({ error: "not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  // Identify the caller with their own token: a user may only delete themselves.
  const asUser = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data, error } = await asUser.auth.getUser();
  if (error || !data.user) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const admin = createClient(url, service);
  const { error: delError } = await admin.auth.admin.deleteUser(data.user.id);
  if (delError) {
    return new Response(JSON.stringify({ error: delError.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
