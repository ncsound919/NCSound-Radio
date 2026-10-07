import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { toSubmissionDTO } from '@/lib/broadcast'
import { requireAdmin } from '@/lib/admin-auth'
import { promoteToLibrary, type PromoteResult } from '@/lib/submission-audio'

export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  status: z.enum(['IN_REVIEW', 'APPROVED', 'DECLINED'], {
    message: 'status must be IN_REVIEW, APPROVED or DECLINED',
  }),
  reviewNotes: z.string().max(2000).optional(),
})

/** GET /api/submissions/[id] — admin only. Carries the artist's email, the
 *  agreement IP and internal review notes; the list route beside it is already
 *  admin-gated and this one must be too. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireAdmin(request)
  if (denied) return denied
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
 * PATCH /api/submissions/[id] — review pipeline. Admin only.
 * APPROVED copies the submitted audio into the engine's library.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const denied = await requireAdmin(request)
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
    const data: { status: string; reviewedAt: Date; reviewNotes?: string } = {
      status: parsed.data.status,
      reviewedAt: now,
    }
    if (parsed.data.reviewNotes !== undefined) {
      data.reviewNotes = parsed.data.reviewNotes
    }

    const updated = await db.submission.update({ where: { id }, data })

    // Approval is what lets the audio reach the engine's library. A failed copy
    // does not undo the review, but it is reported rather than swallowed: the
    // track is approved and will NOT air until the file is in the library.
    let audio: PromoteResult | null = null
    if (parsed.data.status === 'APPROVED') {
      audio = await promoteToLibrary(
        updated.id,
        updated.fileName,
        updated.artistName,
        updated.trackTitle,
      )
    }
    return NextResponse.json({ submission: toSubmissionDTO(updated), audio })
  } catch (error) {
    console.error('[api/submissions/[id] PATCH]', error)
    return NextResponse.json(
      { error: 'Failed to review submission' },
      { status: 500 },
    )
  }
}


