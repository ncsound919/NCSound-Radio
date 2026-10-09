/**
 * Refuse destructive Prisma commands against a remote (Supabase) database.
 *
 *   node scripts/db-guard.mjs db:push
 *
 * `prisma db push` / `migrate dev` / `migrate reset` compare the whole schema
 * against the database. On Supabase the `public` schema also holds the identity
 * tables (profiles/favorites/devices/push_prefs) that this app does NOT manage,
 * so Prisma would see them as drift and try to DROP them. Against Supabase the
 * only safe operation is `prisma migrate deploy` (which applies pending
 * migration files and never diffs).
 *
 * Local databases pass through untouched. Set ALLOW_REMOTE_DB=1 to override.
 */
const url = process.env.DATABASE_URL ?? ''
const isRemote = /supabase\.(co|com)/.test(url) || /pooler\.supabase/.test(url)

if (isRemote && process.env.ALLOW_REMOTE_DB !== '1') {
  console.error(
    [
      `db-guard: refusing "${process.argv[2] ?? 'a destructive command'}" against a Supabase database.`,
      '',
      'Prisma would diff the whole schema and could drop the identity tables',
      '(profiles, favorites, devices, push_prefs) that live in the same public',
      'schema. Use `bun run db:deploy` (prisma migrate deploy) instead, or set',
      'ALLOW_REMOTE_DB=1 if you really mean it.',
    ].join('\n'),
  )
  process.exit(1)
}
