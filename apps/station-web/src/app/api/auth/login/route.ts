import { NextResponse } from 'next/server'
import { z } from 'zod'
import { allow, clientIp } from '@/lib/rate-limit'
import { adminConfigured, login } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})

/**
 * POST /api/auth/login — sign in to the control room.
 *
 * Rate limited per IP. Ten attempts per five minutes is tight enough to make
 * guessing impractical and loose enough that an operator fat-fingering their
 * own password does not lock themselves out of a live station.
 */
export async function POST(request: Request) {
  if (!allow(`adminlogin:${clientIp(request)}`, 10, 5 * 60_000)) {
    return NextResponse.json(
      { error: 'Too many sign-in attempts. Try again in a few minutes.' },
      { status: 429 },
    )
  }

  if (!(await adminConfigured())) {
    return NextResponse.json(
      {
        error:
          'No admin credential exists yet. Run scripts/set-admin-password.ts to create one.',
        configured: false,
      },
      { status: 503 },
    )
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter a username and password.' }, { status: 400 })
  }

  const outcome = await login(request, parsed.data.username, parsed.data.password)
  return outcome.response
}
