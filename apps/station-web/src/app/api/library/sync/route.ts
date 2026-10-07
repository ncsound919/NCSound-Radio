import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ingestCrate } from '@/lib/ingest'
import { requireAdmin } from '@/lib/admin-auth'
import { allow, clientIp } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * POST /api/library/sync — mirror the engine's crate into the station library.
 *
 * The engine's crate is the single source of truth: `Track.id` is the engine's
 * id, so both sides name a record by the same key. Only rows previously
 * written by this sync (playlist 'Local Library') are ever removed; a
 * hand-entered track is never touched, even if its id is absent from the crate.
 */
const LOCAL_LIBRARY = 'Local Library'

const MAX_PER_WINDOW = 6
const WINDOW_MS = 60_000

export async function POST(request: Request) {
  const denied = await requireAdmin(request)
  if (denied) return denied

  if (!allow(`library-sync:${clientIp(request)}`, MAX_PER_WINDOW, WINDOW_MS)) {
    return NextResponse.json(
      { ok: false, error: `Too many syncs — max ${MAX_PER_WINDOW} per minute.` },
      { status: 429 },
    )
  }

  const crate = await ingestCrate()
  if (!crate) {
    // Distinguish "the engine is down" from "the engine has no music". The
    // second is a real state the operator needs to see, not an error.
    return NextResponse.json(
      {
        ok: false,
        error:
          'Could not read the engine crate. Is the ingest service running, and does it have a library directory?',
      },
      { status: 503 },
    )
  }

  const libraryDir = process.env.NCSOUND_LIBRARY ?? 'the engine library directory'

  const now = new Date()
  let created = 0
  let updated = 0
  let unchanged = 0
  let removed = 0

  await db.$transaction(async (tx) => {
    // Highest existing seedOrder, so new rows never collide with the unique
    // constraint on a table that already holds hand-entered tracks.
    const maxOrder = await tx.track.aggregate({ _max: { seedOrder: true } })

    for (const [index, t] of crate.entries()) {
      const seedOrder = (maxOrder._max.seedOrder ?? 0) + index + 1

      const existing = await tx.track.findUnique({ where: { id: t.id } })
      const data = {
        title: t.title,
        artist: t.artist,
        album: t.album,
        durationSec: t.durationSec,
        playlist: LOCAL_LIBRARY,
        bpm: t.bpm == null ? null : Math.round(t.bpm),
      }

      if (!existing) {
        await tx.track.create({ data: { id: t.id, seedOrder, ...data } })
        created += 1
        continue
      }

      const changed =
        existing.title !== data.title ||
        existing.artist !== data.artist ||
        existing.album !== data.album ||
        existing.durationSec !== data.durationSec ||
        existing.bpm !== data.bpm

      if (changed) {
        await tx.track.update({ where: { id: t.id }, data })
        updated += 1
      } else {
        unchanged += 1
      }
    }

    // Drop rows a previous sync wrote whose file is no longer in the crate.
    // Scoped to the sync's own playlist so nothing hand-entered is ever removed.
    const gone = await tx.track.findMany({
      where: { playlist: LOCAL_LIBRARY },
      select: { id: true },
    })
    const crateIds = new Set(crate.map((t) => t.id))
    for (const row of gone) {
      if (crateIds.has(row.id)) continue
      await tx.playLog.deleteMany({ where: { trackId: row.id } })
      await tx.trackRequest.deleteMany({ where: { trackId: row.id } })
      await tx.track.delete({ where: { id: row.id } })
      removed += 1
    }
  })

  return NextResponse.json({
    ok: true,
    crateSize: crate.length,
    created,
    updated,
    unchanged,
    removed,
    playlist: LOCAL_LIBRARY,
  })
}
