/**
 * Resolve the Supabase user behind a request, if any.
 *
 * The listener app sends its Supabase session JWT as `Authorization: Bearer`.
 * We verify it by asking Supabase who it belongs to — no shared secret, no JWKS
 * cache to maintain, and a forged token simply fails. Returns null for an
 * anonymous web listener or when Supabase is not configured, so request logging
 * never depends on it.
 */
const URL_BASE = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

export async function supabaseUserId(req: Request): Promise<string | null> {
  if (!URL_BASE || !ANON) return null
  const header = req.headers.get('authorization') ?? ''
  const jwt = header.replace(/^Bearer\s+/i, '').trim()
  if (jwt.split('.').length !== 3) return null
  try {
    const res = await fetch(`${URL_BASE}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: `Bearer ${jwt}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    const user = (await res.json()) as { id?: string }
    return user?.id ?? null
  } catch {
    return null
  }
}
