import { logout, requireAdmin } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/logout — withdraw every outstanding session.
 *
 * The ops UI has always posted here, but the handler lived at
 * /api/auth/session, so sign-out 404'd and the cookie stayed valid.
 *
 * Requires a session: logout bumps the global epoch, so leaving it open would
 * let anyone sign the operator out of the control room mid-show.
 */
export async function POST(request: Request) {
  const denied = await requireAdmin(request)
  if (denied) return denied
  return logout()
}
