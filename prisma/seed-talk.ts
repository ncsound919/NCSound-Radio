/* Incremental seed: Talk / Spotlight produced segments for the program clock.
 * Idempotent (upsert) — safe to run on a live database; never wipes rows.
 * Also mirrored in prisma/seed.ts for fresh environments. */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const talkSegments = [
  {
    id: 'TALK01',
    title: 'Carolina Waves Spotlight — Fresh Finds',
    artist: 'WAVC 91.3 Programming',
    dur: 195,
    blurb: 'Three-minute spotlight on the newest cleared submissions.',
  },
  {
    id: 'TALK02',
    title: 'Studio Line Shout-Outs',
    artist: 'WAVC 91.3 Programming',
    dur: 150,
    blurb: 'Reading listener shouts from the studio line and request ledger.',
  },
  {
    id: 'TALK03',
    title: 'The Week in Carolina Hip-Hop',
    artist: 'WAVC 91.3 Programming',
    dur: 225,
    blurb: 'Shows, releases and open mics across NC/SC — produced segment.',
  },
]

async function main() {
  console.log('Seeding Talk / Spotlight segments ...')

  // Rights records: fully owned, produced in-house, instantly CLEARED.
  for (const t of talkSegments) {
    await db.rightsLog.upsert({
      where: { id: t.id },
      update: {
        trackTitle: t.title,
        artistName: t.artist,
        owner: 'WAVC 91.3 (in-house)',
        sampleStatus: 'CLEARED',
        explicitFlag: false,
        status: 'CLEARED',
        source: 'CORE',
        ownerProof: 'Produced in-house — work for hire (talk segment)',
        clearedAt: new Date('2025-09-01T12:00:00Z'),
      },
      create: {
        id: t.id,
        trackTitle: t.title,
        artistName: t.artist,
        owner: 'WAVC 91.3 (in-house)',
        sampleStatus: 'CLEARED',
        explicitFlag: false,
        status: 'CLEARED',
        source: 'CORE',
        ownerProof: 'Produced in-house — work for hire (talk segment)',
        clearedAt: new Date('2025-09-01T12:00:00Z'),
      },
    })

    // Track rows live in the "Talk" playlist (excluded from music pools).
    const existing = await db.track.findUnique({ where: { id: t.id } })
    if (existing) {
      await db.track.update({
        where: { id: t.id },
        data: {
          title: t.title,
          artist: t.artist,
          durationSec: t.dur,
          rightsId: t.id,
          explicit: false,
          playlist: 'Talk',
          bpm: null,
        },
      })
    } else {
      const maxOrder = await db.track.aggregate({ _max: { seedOrder: true } })
      await db.track.create({
        data: {
          id: t.id,
          title: t.title,
          artist: t.artist,
          album: t.blurb,
          durationSec: t.dur,
          rightsId: t.id,
          explicit: false,
          playlist: 'Talk',
          bpm: null,
          seedOrder: (maxOrder._max.seedOrder ?? 0) + 1,
        },
      })
    }
  }

  const counts = {
    talkTracks: await db.track.count({ where: { playlist: 'Talk' } }),
    talkRights: await db.rightsLog.count({ where: { id: { startsWith: 'TALK' } } }),
  }
  console.log('Talk seed complete:', counts)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
