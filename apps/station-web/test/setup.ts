/**
 * Test prelude — import this FIRST in any suite that (transitively) imports the
 * Prisma client.
 *
 * Tests must NEVER run against production. `.env` in this app points at Supabase
 * (the live station DB), so this forces a dedicated local test database
 * regardless. Override with NCSOUND_TEST_DATABASE_URL if you want another.
 *
 * If the test database is unreachable (CI without Postgres), PrismaClient still
 * constructs (the URL is valid) and each suite's reachability probe skips
 * visibly rather than failing.
 */
const TEST_DB =
  process.env.NCSOUND_TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5433/ncsound_test?schema=public'

process.env.DATABASE_URL = TEST_DB
process.env.DIRECT_URL = TEST_DB

export {}
