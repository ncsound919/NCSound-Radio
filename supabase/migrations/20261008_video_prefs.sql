-- 2026-10-08 — add the watch-video preference for push targeting (plan 04-04).
--
-- The app also keeps a local `watchVideo` preference (AsyncStorage) for the
-- in-app banner; this column lets the push sender suppress watch prompts for
-- users who opted out, across devices.

alter table push_prefs
  add column if not exists watch_video boolean not null default true;
