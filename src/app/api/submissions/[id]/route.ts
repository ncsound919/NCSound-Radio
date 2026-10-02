import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { toSubmissionDTO } from '@/lib/broadcast'
import { requireOpsPin } from '@/lib/ops-auth'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  status: z.enum(['IN_REVIEW', 'APPROVED', 'DECLINED'], {
    message: 'status must be IN_REVIEW, APPROVED or DECLINED',
  }),
  reviewNotes: z.string().max(2000).optional(),
})

/**
 * Next free RightsLog id: R0xxx sequence starting at R0100.
 * Looks at every id matching /^R\d+$/, takes the max value >= 100, +1.
 */
async function nextRightsId(): Promise<string> {
  const rows = await db.rightsLog.findMany({ select: { id: true } })
  let max = 99
  for (const row of rows) {
    const m = /^R(\d+)$/.exec(row.id)
    if (!m) continue
    const n = Number.parseInt(m[1], 10)
    if (n >= 100 && n > max) max = n
  }
  return `R${String(max + 1).padStart(4, '0')}`
}

/** GET /api/submissions/[id] */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const submission = await db.submission.findUnique({ where: { id } })
    if (!submission) {
      return NextResponse.json(
        { error: 'Submission not found' },
        { status: 404 },
      )
    }
    return NextResponse.json({ submission: toSubmissionDTO(submission) })
  } catch (error) {
    console.error('[api/submissions/[id] GET]', error)
    return NextResponse.json(
      { error: 'Failed to load submission' },
      { status: 500 },
    )
  }
}

/**
 * PATCH /api/submissions/[id] — review pipeline.
 * On APPROVED (and when the submission has no rightsId yet) the rights gate
 * issues a CLEARED RightsLog (R0xxx, source SUBMISSION) and links it.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = await requireOpsPin(request)
    if (denied) return denied

    const { id } = await params
    const body: unknown = await request.json().catch(() => null)
    const parsed = patchSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid review payload' },
        { status: 400 },
      )
    }

    const submission = await db.submission.findUnique({ where: { id } })
    if (!submission) {
      return NextResponse.json(
        { error: 'Submission not found' },
        { status: 404 },
      )
    }

    const now = new Date()
    const data: { status: string; reviewedAt: Date; reviewNotes?: string; rightsId?: string } = {
      status: parsed.data.status,
      reviewedAt: now,
    }
    if (parsed.data.reviewNotes !== undefined) {
      data.reviewNotes = parsed.data.reviewNotes
    }

    if (parsed.data.status === 'APPROVED' && !submission.rightsId) {
      const rightsId = await nextRightsId()
      const rightsLog = await db.rightsLog.create({
        data: {
          id: rightsId,
          trackTitle: submission.trackTitle,
          artistName: submission.artistName,
          owner: `${submission.artistName} (artist)`,
          sampleStatus: 'CLEARED',
          explicitFlag: submission.explicit,
          status: 'CLEARED',
          source: 'SUBMISSION',
          ownerProof: `Signed agreement ${submission.agreementVersion} + submission review`,
          clearedAt: now,
        },
      })
      data.rightsId = rightsLog.id
    }

    const updated = await db.submission.update({ where: { id }, data })
    return NextResponse.json({ submission: toSubmissionDTO(updated) })
  } catch (error) {
    console.error('[api/submissions/[id] PATCH]', error)
    return NextResponse.json(
      { error: 'Failed to review submission' },
      { status: 500 },
    )
  }
}


