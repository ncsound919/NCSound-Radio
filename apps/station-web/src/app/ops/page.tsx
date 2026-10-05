import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { AppShell } from '@/components/station/app-shell'
import { currentAdmin } from '@/lib/admin-auth'

export const dynamic = 'force-dynamic'

/**
 * GET /ops — the internal control room.
 *
 * A real route with a real gate, not a hidden tab. The previous design put the
 * control room in the same nav as "Listen", which told every listener that a
 * crate size, an engine state and a revenue figure existed; the numbers were
 * locked behind a PIN, but the shape of the operation was not.
 *
 * The session is checked here, before any ops UI is sent. An unauthenticated
 * visitor is redirected to the sign-in page rather than shown an empty
 * dashboard, because "signed out" and "nothing to review" must not look alike.
 */
export default async function OpsPage() {
  const store = await cookies()
  const header = store
    .getAll()
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
    .join('; ')

  const admin = await currentAdmin(new Request('http://internal/ops', { headers: { cookie: header } }))
  if (!admin) redirect('/ops/sign-in')

  return <AppShell initialTab="ops" />
}
