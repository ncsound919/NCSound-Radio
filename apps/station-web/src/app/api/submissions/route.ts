import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { AGREEMENT_VERSION } from '@/lib/station-types'
import { toSubmissionDTO } from '@/lib/broadcast'
import { allow, clientIp, trustedClientIp } from '@/lib/rate-limit'
import { requireAdmin } from '@/lib/admin-auth'
import {
  ALLOWED_AUDIO_EXTS,
  audioExt,
  looksLikeAudio,
  newSubmissionId,
  removeFromInbox,
  safeSegment,
  saveToInbox,
} from '@/lib/submission-audio'

export const dynamic = 'force-dynamic'

const MAX_FILE_BYTES = 15 * 1024 * 1024 // 15MB; saved to the local submissions inbox

const submissionSchema = z.object({
  artistName: z.string().min(1, 'Artist name is required').max(120),
  email: z
    .string()
    .max(200)
    .pipe(z.email('A valid email address is required')),
  trackTitle: z.string().min(1, 'Track title is required').max(200),
  genre: z.string().min(1, 'Genre is required').max(80),
  explicit: z.boolean(),
  city: z.string().max(80).nullable(),
  state: z.string().max(80).nullable(),
  socials: z.string().max(200).nullable(),
  notes: z.string().max(2000).nullable(),
  agreementAccepted: z.boolean(),
})

type RawBody = Record<string, unknown>

const asString = (v: unknown): string =>
  typeof v === 'string' ? v : v == null ? '' : String(v)

const asTrimmed = (v: unknown): string => asString(v).trim()

const asOptional = (v: unknown): string | null => {
  const s = asTrimmed(v)
  return s === '' ? null : s
}

const asBool = (v: unknown): boolean =>
  v === true || v === 1 || v === 'true' || v === 'on' || v === '1'

/**
 * GET /api/submissions — full pipeline, newest first. Admin only.
 *
 * Every row carries the artist's email, agreement IP and review notes. This
 * used to be open, so anyone who could reach the site could download the
 * whole submitter list. Artists check their own status via /lookup.
 */
export async function GET(request: Request) {
  const denied = await requireAdmin(request)
  if (denied) return denied
  try {
    const rows = await db.submission.findMany({
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({ submissions: rows.map(toSubmissionDTO) })
  } catch (error) {
    console.error('[api/submissions GET]', error)
    return NextResponse.json(
      { error: 'Failed to load submissions' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/submissions — accepts JSON or multipart/form-data.
 * Multipart may include an optional `file` audio field (<= 15MB). It is saved
 * to the local submissions inbox (NCSOUND_SUBMISSIONS_DIR) and only copied into
 * the engine's library when an admin approves the submission.
 */
export async function POST(request: Request) {
  try {
    // Per-IP throttle: 3 submissions per 10 minutes (inbox hygiene).
    if (!allow(`sub:${clientIp(request)}`, 3, 10 * 60_000)) {
      return NextResponse.json(
        { error: 'Too many submissions from this connection — try again later.' },
        { status: 429 },
      )
    }

    // formData() buffers the entire body before the per-file size check can
    // run, so the 15MB limit did not bound memory. Refuse oversized bodies up
    // front. (A client can omit content-length with chunked encoding; a
    // reverse-proxy body limit is the real backstop when exposed publicly.)
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES + 64 * 1024) {
      return NextResponse.json(
        { error: 'Audio file exceeds the 15MB limit' },
        { status: 413 },
      )
    }

    const contentType = request.headers.get('content-type') ?? ''
    let raw: RawBody = {}
    let fileName: string | null = null
    let fileSize: number | null = null
    let audio: { ext: string; data: Uint8Array } | null = null

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData()
      // The ambient FormData type resolves to string-valued entries once
      // @types/node is hoisted (it shadows the DOM lib), so the `File` arm is
      // cast back in here. At runtime a multipart `file` part IS a File.
      for (const [key, value] of form.entries() as IterableIterator<[string, File | string]>) {
        if (key === 'file') {
          if (typeof value !== 'string' && value.size > 0) {
            if (value.size > MAX_FILE_BYTES) {
              return NextResponse.json(
                { error: 'Audio file exceeds the 15MB limit' },
                { status: 400 },
              )
            }
            const ext = audioExt(value.name)
            if (!ext) {
              return NextResponse.json(
                { error: `Audio must be one of: ${ALLOWED_AUDIO_EXTS.join(', ')}` },
                { status: 400 },
              )
            }
            const data = new Uint8Array(await value.arrayBuffer())
            if (!looksLikeAudio(data, ext)) {
              return NextResponse.json(
                { error: `That file does not look like a real ${ext} audio file` },
                { status: 400 },
              )
            }
            audio = { ext, data }
            fileName = safeSegment(value.name, 120)
            fileSize = value.size
          }
        } else if (typeof value === 'string') {
          raw[key] = value
        }
      }
    } else {
      const json: unknown = await request.json().catch(() => null)
      if (json == null || typeof json !== 'object' || Array.isArray(json)) {
        return NextResponse.json(
          { error: 'Invalid JSON body' },
          { status: 400 },
        )
      }
      raw = json as RawBody
    }

    const parsed = submissionSchema.safeParse({
      artistName: asTrimmed(raw.artistName),
      email: asTrimmed(raw.email),
      trackTitle: asTrimmed(raw.trackTitle),
      genre: asTrimmed(raw.genre),
      explicit: asBool(raw.explicit),
      city: asOptional(raw.city),
      state: asOptional(raw.state),
      socials: asOptional(raw.socials),
      notes: asOptional(raw.notes),
      agreementAccepted: asBool(raw.agreementAccepted),
    })

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid submission' },
        { status: 400 },
      )
    }

    if (parsed.data.agreementAccepted !== true) {
      return NextResponse.json(
        { error: 'Agreement must be accepted' },
        { status: 400 },
      )
    }

    const data = parsed.data
    const now = new Date()
    // Only record an IP a trusted proxy vouched for; a client-written header
    // on a signed agreement is evidence of nothing.
    const agreementIp = trustedClientIp(request) ?? 'unknown'

    // Write the audio before the row exists: a submission that claims a file
    // we failed to keep is worse than a clear error the artist can retry.
    const id = newSubmissionId()
    if (audio) {
      try {
        await saveToInbox(id, audio.ext, audio.data)
      } catch (error) {
        console.error('[api/submissions POST] could not save audio', error)
        return NextResponse.json(
          { error: 'Could not store the audio file — please try again.' },
          { status: 500 },
        )
      }
    }

    let submission
    try {
      submission = await db.submission.create({
      data: {
        id,
        artistName: data.artistName,
        email: data.email,
        trackTitle: data.trackTitle,
        genre: data.genre,
        explicit: data.explicit,
        city: data.city,
        state: data.state,
        socials: data.socials,
        fileName,
        fileSize,
        notes: data.notes,
        status: 'PENDING',
        agreementVersion: AGREEMENT_VERSION,
        agreementAcceptedAt: now,
        agreementIp,
      },
      })
    } catch (error) {
      if (audio) await removeFromInbox(id, audio.ext)
      throw error
    }

    // Loose artist registry upsert keyed by name.
    const existingArtist = await db.artist.findFirst({
      where: { name: data.artistName },
    })
    if (existingArtist) {
      await db.artist.update({
        where: { id: existingArtist.id },
        data: {
          email: data.email,
          ...(data.city !== null ? { city: data.city } : {}),
          ...(data.state !== null ? { state: data.state } : {}),
          // Artist model has instagram/soundcloud columns; socials free-text
          // maps onto `instagram`.
          ...(data.socials !== null ? { instagram: data.socials } : {}),
        },
      })
    } else {
      await db.artist.create({
        data: {
          name: data.artistName,
          email: data.email,
          city: data.city,
          state: data.state,
          instagram: data.socials,
        },
      })
    }

    return NextResponse.json(
      { submission: toSubmissionDTO(submission) },
      { status: 201 },
    )
  } catch (error) {
    console.error('[api/submissions POST]', error)
    return NextResponse.json(
      { error: 'Failed to create submission' },
      { status: 500 },
    )
  }
}
