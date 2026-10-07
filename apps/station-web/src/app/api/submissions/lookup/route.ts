import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import type { SubmissionLookupResponse } from '@/lib/station-types'
import { allow, clientIp } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const emailSchema = z.email('A valid email address is required').max(200)

const SUB_STATUSES = ['PENDING', 'IN_REVIEW', 'APPROVED', 'DECLINED'] as const
type SubStatus = (typeof SUB_STATUSES)[number]
const asStatus = (s: string): SubStatus =>
  (SUB_STATUSES as readonly string[]).includes(s) ? (s as SubStatus) : 'PENDING'

/**
 * GET /api/submissions/lookup?email=…
 *
 * Artist-facing status lookup — the public half of the submissions pipeline.
 * An artist who applied through the form can check where their track sits
 * (PENDING → IN_REVIEW → APPROVED/DECLINED) without any ops access.
 *
 * Privacy posture: returns ONLY status facts for rows whose submission email
 * matches exactly, capped at the 10 most recent — no review notes, no PII
 * beyond the title/genre the artist submitted themselves. Rate-limited per IP
 * so the endpoint can't be used to enumerate emails.
 */
export async function GET(req: Request) {
  try {
    if (!allow(`sub-lookup:${clientIp(req)}`, 5, 5 * 60_000)) {
      return NextResponse.json(
        { error: 'Too many lookups — try again in a few minutes.' },
        { status: 429 },
      )
    }

    const url = new URL(req.url)
    const raw = (url.searchParams.get('email') ?? '').trim().toLowerCase()
    if (!raw) {
      return NextResponse.json(
        { error: 'An email address is required.' },
        { status: 400 },
      )
    }
    const parsed = emailSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'That does not look like a valid email address.' },
        { status: 400 },
      )
    }

    const rows = await db.submission.findMany({
      where: { email: parsed.data }, // emails stored lowercase; input normalized above
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        trackTitle: true,
        genre: true,
        status: true,
        createdAt: true,
        reviewedAt: true,
      },
    })

    const body: SubmissionLookupResponse = {
      submissions: rows.map((r) => ({
        trackTitle: r.trackTitle,
        genre: r.genre,
        status: asStatus(r.status),
        createdAt: r.createdAt.toISOString(),
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
      })),
    }
    return NextResponse.json(body)
  } catch (error) {
    console.error('[api/submissions/lookup GET]', error)
    return NextResponse.json(
      { error: 'Failed to run the lookup' },
      { status: 500 },
    )
  }
}
