-- NCSound listener identity (mobile implementation plan, P1 / section 7).
--
-- Four user-scoped tables behind Row Level Security, plus a trigger that
-- creates a profile on signup. The mobile app reads/writes these directly with
-- the publishable key; RLS (auth.uid()) is the boundary, not the client.
--
-- Idempotent: safe to re-run. Apply with the Supabase CLI (`supabase db push`)
-- or the Management API (`POST /v1/projects/<ref>/database/query`).

-- Profiles: one row per auth user.
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);

-- Favorites: a station / artist / track a user follows ("My Waves").
create table if not exists public.favorites (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('station', 'artist', 'track')),
  ref        text not null,
  created_at timestamptz not null default now(),
  unique (user_id, kind, ref)
);

-- Devices: one push token per user/device.
create table if not exists public.devices (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  platform   text not null check (platform in ('ios', 'android')),
  push_token text not null,
  updated_at timestamptz not null default now(),
  unique (user_id, push_token)
);

-- Push preferences.
create table if not exists public.push_prefs (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  artist_on_air   boolean not null default true,
  request_played  boolean not null default true,
  show_start      boolean not null default true
);

-- Create a profile row on signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Row Level Security: on for every table, scoped to the owning user.
alter table public.profiles   enable row level security;
alter table public.favorites  enable row level security;
alter table public.devices    enable row level security;
alter table public.push_prefs enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (auth.uid() = id);

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists favorites_own on public.favorites;
create policy favorites_own on public.favorites
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists devices_own on public.devices;
create policy devices_own on public.devices
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists push_prefs_own on public.push_prefs;
create policy push_prefs_own on public.push_prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Explicit grants (RLS still applies). Supabase grants new public tables to
-- these roles by default, but being explicit makes the contract visible.
grant select, insert, update, delete
  on public.profiles, public.favorites, public.devices, public.push_prefs
  to authenticated;
