-- Create the dedicated Prisma role on Supabase, per the official Prisma guide:
-- https://supabase.com/docs/guides/database/prisma
--
-- Run once, in the Supabase SQL editor (project xczjyhsibnjbjhpvtotx), as the
-- postgres superuser. Replace the password, then put it in DATABASE_URL /
-- DIRECT_URL as the `prisma` user (see .env.example).
--
-- Why a separate role: least privilege and observability. Prisma connects as a
-- normal (non-superuser) role that owns the public schema objects it creates,
-- instead of the postgres superuser. `bypassrls` is deliberate — Prisma is the
-- server-side owner path; RLS governs the PostgREST/anon path (the listener
-- app), not Prisma.

create user "prisma" with password 'REPLACE_WITH_A_STRONG_PASSWORD' bypassrls createdb;

-- Let the postgres role see Prisma's changes in the Supabase dashboard.
grant "prisma" to "postgres";

grant usage, create on schema public to prisma;
grant all on all tables    in schema public to prisma;
grant all on all routines  in schema public to prisma;
grant all on all sequences in schema public to prisma;
alter default privileges for role postgres in schema public grant all on tables    to prisma;
alter default privileges for role postgres in schema public grant all on routines  to prisma;
alter default privileges for role postgres in schema public grant all on sequences to prisma;

-- If you need to rotate the password later:
--   alter user "prisma" with password 'NEW_PASSWORD';
