# Supabase (NCSound)

Identity and listener data for the phone app (mobile implementation plan, §7).
The app queries these tables **directly** with the publishable key; **RLS is the
boundary**, not the client.

- **Project:** `NCSound Radio` — ref `xczjyhsibnjbjhpvtotx`, region `us-east-1`.
- **Contents:** `migrations/` (DDL) and `functions/` (Edge Functions).

## Schema (applied)

| Table | Purpose | RLS |
|---|---|---|
| `profiles` | one row per auth user (`id = auth.uid()`) | select/insert/update own |
| `favorites` | station/artist/track follows ("My Waves") | all, own |
| `devices` | push tokens (`platform`, `push_token`) | all, own |
| `push_prefs` | notification toggles | all, own |

A trigger (`on_auth_user_created`) creates the `profiles` row on signup. Deleting
the auth user cascades to all four tables.

## Migrations

Applied this session; the files are idempotent and the project is linked for the
CLI.

| File | Purpose |
|---|---|
| `20261007000000_init_identity.sql` | `profiles` / `favorites` / `devices` / `push_prefs` + RLS + signup trigger |
| `20261007000100_user_id_defaults.sql` | `user_id` (and `profiles.id`) default to `auth.uid()` |

```sh
supabase link --project-ref xczjyhsibnjbjhpvtotx
supabase db push
```

## Edge Function: `delete-account` — deployed + verified

App Store 5.1.1(v). Deployed (`supabase functions deploy delete-account`) and
verified end to end: a throwaway user was created, signed in, and deleted via
the function — the user is gone and their `favorites` row cascaded away. The
function only ever deletes the **caller** (from their JWT); it uses the
platform-provided `SUPABASE_SERVICE_ROLE_KEY`.

## Secrets — do not commit

Project credentials (DB password, publishable key, service-role key, access
token) live in `~/.config/ncsound/supabase.txt`, moved **out of the repo**;
`.gitignore` still ignores any stray `supabase.txt`. The
service-role key and the `sbp_` access token are full-power — keep them out of
git and out of the app bundle. Only the publishable key is safe in the app.
