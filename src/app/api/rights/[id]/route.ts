import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { toRightsDTO } from '@/lib/broadcast'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  status: z.enum(['PENDING', 'IN_REVIEW', 'CLEARED', 'BLOCKED'], {
    message: 'status must be PENDING, IN_REVIEW, CLEARED or BLOCKED',
  }),
})

/**
 * PATCH /api/rights/[id] — gate decisions.
 * CLEARED stamps clearedAt + sampleStatus CLEARED; any other status clears
 * the clearedAt stamp (the record leaves the "airable" state).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body: unknown = await request.json().catch(() => null)
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid status payload' },
        { status: 400 },
      )
    }

    const existing = await db.rightsLog.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Rights record not found' }, { status: 404 })
    }

    const status = parsed.data.status
    const updated = await db.rightsLog.update({
      where: { id },
      data: {
        status,
        clearedAt: status === 'CLEARED' ? new Date() : null,
        ...(status === 'CLEARED' ? { sampleStatus: 'CLEARED' } : {}),
      },
    })

    return NextResponse.json({ right: toRightsDTO(updated) })
  } catch (error) {
    console.error('[api/rights/[id] PATCH]', error)
    return NextResponse.json(
      { error: 'Failed to update rights record' },
      { status: 500 },
    )
  }
}
