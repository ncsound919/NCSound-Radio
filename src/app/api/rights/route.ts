import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { toRightsDTO } from '@/lib/broadcast'

export const dynamic = 'force-dynamic'

/**
 * GET /api/rights — the rights gate ledger, newest first.
 */
export async function GET() {
  try {
    const rows = await db.rightsLog.findMany({
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({ rights: rows.map(toRightsDTO) })
  } catch (error) {
    console.error('[api/rights GET]', error)
    return NextResponse.json(
      { error: 'Failed to load rights log' },
      { status: 500 },
    )
  }
}
