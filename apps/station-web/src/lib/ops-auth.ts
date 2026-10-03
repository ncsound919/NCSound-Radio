/**
 * NCSound Radio — Ops control-room PIN gate (sandbox-scale auth).
 * ------------------------------------------------------------
 * Mutating ops routes (submission review, rights gate decisions, ad sync)
 * require the station PIN in the `x-ops-pin` header. The PIN lives in the
 * StationSetting table (key `ops_pin`, seeded default `0913` — the dial
 * frequency). Read-only dashboards stay public.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const OPS_PIN_KEY = 'ops_pin'
export const OPS_PIN_DEFAULT = '0913'

/** The control-room PIN (StationSetting-driven, constant default fallback). */
export async function getOpsPin(): Promise<string> {
  const row = await db.stationSetting.findUnique({ where: { key: OPS_PIN_KEY } })
  return row?.value ?? OPS_PIN_DEFAULT
}

/**
 * Guard for mutating ops endpoints. Returns null when the caller presented
 * the right PIN; otherwise a ready-to-return 401 response.
 */
export async function requireOpsPin(request: Request): Promise<NextResponse | null> {
  const provided = request.headers.get('x-ops-pin') ?? ''
  const expected = await getOpsPin()
  if (provided.length > 0 && provided === expected) return null
  return NextResponse.json(
    {
      error:
        'Control room is locked — unlock with the station PIN (demo: 0913) to run ops actions.',
    },
    { status: 401 },
  )
}
