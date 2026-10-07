-- Default the owner columns to the caller, so a client cannot forget user_id.
-- RLS still enforces auth.uid() = user_id, so a spoofed value is rejected; this
-- only removes the boilerplate of echoing the id on every insert.
--
-- Idempotent. Apply with `supabase db push` or the Management API.

alter table public.profiles   alter column id      set default auth.uid();
alter table public.favorites  alter column user_id set default auth.uid();
alter table public.devices    alter column user_id set default auth.uid();
alter table public.push_prefs alter column user_id set default auth.uid();
