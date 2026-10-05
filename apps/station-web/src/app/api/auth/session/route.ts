import { NextResponse } from 'next/server'
import { adminConfigured, currentAdmin, logout } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/auth/session — who am I?
 *
 * Reports whether an admin exists and whether this browser holds a valid
 * session. It never returns the credential, the hash or the session token.
 */
export async function GET(request: Request) {
  const admin = await currentAdmin(request)
  return NextResponse.json({
    configured: await adminConfigured(),
    authenticated: admin !== null,
    user: admin?.user ?? null,
  })
}

/** POST /api/auth/logout — withdraw every outstanding session. */
export async function POST() {
  return logout()
}
