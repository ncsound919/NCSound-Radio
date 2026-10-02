/* Seed the WAVC 91.3 "Carolina Waves" station database */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const rightsForCore: Array<{
  id: string
  title: string
  artist: string
  owner: string
  explicit: boolean
  playlist: string
  dur: number
  bpm: number
  sampleStatus?: string
}> = [
  { id: 'R0001', title: 'Piedmont Gold', artist: 'Kwaze', owner: 'Kwaze (artist)', explicit: false, playlist: 'Core Rotation', dur: 214, bpm: 88 },
  { id: 'R0002', title: 'Queen City Nights', artist: 'MARLO Vaun', owner: 'Vaun Made Music BMI', explicit: false, playlist: 'Core Rotation', dur: 187, bpm: 92 },
  { id: 'R0003', title: 'Reidsville Reprise', artist: 'Bama Slim', owner: 'Bama Slim (artist)', explicit: false, playlist: 'Core Rotation', dur: 236, bpm: 84 },
  { id: 'R0004', title: 'Sawmill Flow', artist: 'Durham Dank', owner: 'Dank Tapes LLC', explicit: true, playlist: 'Core Rotation', dur: 168, bpm: 96 },
  { id: 'R0005', title: 'Grist Mill Grind', artist: 'Yung Seagull', owner: 'Seagull Sound ASCAP', explicit: false, playlist: 'Core Rotation', dur: 195, bpm: 90 },
  { id: 'R0006', title: 'Cape Fear Anthem', artist: '910 Rex', owner: '910 Rex (artist)', explicit: false, playlist: 'Core Rotation', dur: 223, bpm: 87 },
  { id: 'R0007', title: 'Linen & Loops', artist: 'Miss Appy', owner: 'Appy Hour Publishing', explicit: false, playlist: 'Clean Daypart', dur: 178, bpm: 86 },
  { id: 'R0008', title: 'Blue Ridge Static', artist: 'Ashe Arc', owner: 'Ashe Arc (artist)', explicit: false, playlist: 'Clean Daypart', dur: 242, bpm: 82 },
  { id: 'R0009', title: 'Sweet Tea Ceremonies', artist: 'PALMetto Kai', owner: 'PALMetto Kai (artist)', explicit: false, playlist: 'Clean Daypart', dur: 205, bpm: 91 },
  { id: 'R0010', title: 'Tar Heel Telecast', artist: 'Chapel Trae', owner: 'Trae Vision BMI', explicit: false, playlist: 'Clean Daypart', dur: 189, bpm: 93 },
  { id: 'R0011', title: 'Concrete Azaleas', artist: 'Wilm Wonder', owner: 'Wonder Works LLC', explicit: false, playlist: 'New Heat', dur: 172, bpm: 98 },
  { id: 'R0012', title: 'Interstate 85 Sermon', artist: 'G-Ville Grant', owner: 'Grant Writing ASCAP', explicit: true, playlist: 'New Heat', dur: 218, bpm: 140 },
  { id: 'R0013', title: 'Peach County Politics', artist: 'RB Slade', owner: 'Slade Sound (artist)', explicit: false, playlist: 'New Heat', dur: 199, bpm: 89 },
  { id: 'R0014', title: 'High Point Henny', artist: 'Furni Drew', owner: 'Furniture City Records', explicit: true, playlist: 'New Heat', dur: 161, bpm: 143 },
  { id: 'R0015', title: 'Salt Marsh Sunset', artist: 'EB Sound', owner: 'EB Sound (artist)', explicit: false, playlist: 'New Heat', dur: 231, bpm: 85 },
  { id: 'R0016', title: 'Country Roads Cypher', artist: 'Trip Lee Scott', owner: 'Scott Free Music', explicit: false, playlist: 'Throwbacks', dur: 254, bpm: 90 },
  { id: 'R0017', title: 'Raleigh Royals 09', artist: 'Sir Prolific', owner: 'Prolific Publishing BMI', explicit: false, playlist: 'Throwbacks', dur: 246, bpm: 88 },
  { id: 'R0018', title: 'Bathroom Wall Classics', artist: 'DJ Lumberton', owner: 'DJ Lumberton (artist)', explicit: false, playlist: 'Throwbacks', dur: 238, bpm: 91 },
  { id: 'R0019', title: 'Holler Anthem', artist: 'App Kids', owner: 'App Kids LLC', explicit: false, playlist: 'Fallback', dur: 201, bpm: 87 },
  { id: 'R0020', title: 'Porch Light', artist: 'Lenoir Lane', owner: 'Lenoir Lane (artist)', explicit: false, playlist: 'Fallback', dur: 227, bpm: 84 },
  { id: 'R0021', title: 'Foothills Forever', artist: 'Morganton Moss', owner: 'Moss Made BMI', explicit: false, playlist: 'Fallback', dur: 218, bpm: 86 },
  { id: 'R0022', title: 'Down East Drift', artist: 'Craven Carteret', owner: 'Down East Sound', explicit: false, playlist: 'Fallback', dur: 209, bpm: 88 },
]

const imaging: Array<{ id: string; title: string; artist: string; dur: number; playlist: string }> = [
  { id: 'IMG01', title: 'WAVC Station ID — Wake Up the Carolinas', artist: 'Station Imaging', dur: 12, playlist: 'Imaging' },
  { id: 'IMG02', title: 'WAVC Station ID — Real Ones Only', artist: 'Station Imaging', dur: 10, playlist: 'Imaging' },
  { id: 'IMG03', title: 'Legal ID — WAVC 91.3 FM', artist: 'Station Imaging', dur: 8, playlist: 'Imaging' },
]

const talk: Array<{ id: string; title: string; artist: string; dur: number; blurb: string }> = [
  { id: 'TALK01', title: 'Carolina Waves Spotlight — Fresh Finds', artist: 'WAVC 91.3 Programming', dur: 195, blurb: 'Three-minute spotlight on the newest cleared submissions.' },
  { id: 'TALK02', title: 'Studio Line Shout-Outs', artist: 'WAVC 91.3 Programming', dur: 150, blurb: 'Reading listener shouts from the studio line and request ledger.' },
  { id: 'TALK03', title: 'The Week in Carolina Hip-Hop', artist: 'WAVC 91.3 Programming', dur: 225, blurb: 'Shows, releases and open mics across NC/SC — produced segment.' },
]

async function main() {
  console.log('Seeding WAVC 91.3 ...')

  // wipe in FK-safe order
  await db.adPlay.deleteMany()
  await db.campaign.deleteMany()
  await db.sponsor.deleteMany()
  await db.playLog.deleteMany()
  await db.track.deleteMany()
  await db.rightsLog.deleteMany()
  await db.submission.deleteMany()
  await db.show.deleteMany()
  await db.stationSetting.deleteMany()

  // ---------- Rights log (the gate) ----------
  await db.rightsLog.createMany({
    data: rightsForCore.map(r => ({
      id: r.id,
      trackTitle: r.title,
      artistName: r.artist,
      owner: r.owner,
      sampleStatus: r.sampleStatus ?? 'CLEARED',
      explicitFlag: r.explicit,
      status: 'CLEARED',
      source: 'CORE',
      ownerProof: 'Email permission on file + artist agreement v1.1',
      clearedAt: new Date('2025-08-15T12:00:00Z'),
    })),
  })
  // imaging is fully owned/cleared
  await db.rightsLog.createMany({
    data: imaging.map(r => ({
      id: r.id,
      trackTitle: r.title,
      artistName: r.artist,
      owner: 'WAVC 91.3 (in-house)',
      sampleStatus: 'CLEARED',
      explicitFlag: false,
      status: 'CLEARED',
      source: 'CORE',
      ownerProof: 'Produced in-house — work for hire',
      clearedAt: new Date('2025-08-01T12:00:00Z'),
    })),
  })
  // produced talk segments are fully owned/cleared
  await db.rightsLog.createMany({
    data: talk.map(r => ({
      id: r.id,
      trackTitle: r.title,
      artistName: r.artist,
      owner: 'WAVC 91.3 (in-house)',
      sampleStatus: 'CLEARED',
      explicitFlag: false,
      status: 'CLEARED',
      source: 'CORE',
      ownerProof: 'Produced in-house — work for hire (talk segment)',
      clearedAt: new Date('2025-09-01T12:00:00Z'),
    })),
  })
  // pipeline demo rows (not cleared — must never reach AutoDJ)
  await db.rightsLog.createMany({
    data: [
      { id: 'R9001', trackTitle: 'Baseline Bootleg', artistName: 'Unknown Demo Tape', owner: 'unverified', sampleStatus: 'UNCLEARED', explicitFlag: true, status: 'BLOCKED', source: 'SUBMISSION', ownerProof: null },
      { id: 'R9002', trackTitle: 'Summer in the Sauc (feat. sample)', artistName: 'Lil Coast', owner: 'Lil Coast (pending signature)', sampleStatus: 'PENDING', explicitFlag: false, status: 'IN_REVIEW', source: 'SUBMISSION', ownerProof: null },
    ],
  })

  // ---------- Tracks (AutoDJ library) ----------
  const trackRows: Array<{ title: string; artist: string; album: string | null; durationSec: number; rightsId: string; explicit: boolean; playlist: string; bpm: number | null; seedOrder: number }> = []
  let order = 1
  for (const r of rightsForCore) {
    trackRows.push({ title: r.title, artist: r.artist, album: null, durationSec: r.dur, rightsId: r.id, explicit: r.explicit, playlist: r.playlist, bpm: r.bpm, seedOrder: order++ })
  }
  for (const img of imaging) {
    trackRows.push({ title: img.title, artist: img.artist, album: null, durationSec: img.dur, rightsId: img.id, explicit: false, playlist: img.playlist, bpm: null, seedOrder: order++ })
  }
  for (const t of talk) {
    trackRows.push({ title: t.title, artist: t.artist, album: t.blurb, durationSec: t.dur, rightsId: t.id, explicit: false, playlist: 'Talk', bpm: null, seedOrder: order++ })
  }
  await db.track.createMany({ data: trackRows })

  // ---------- Shows ----------
  const shows = [
    { name: 'Sunrise Soundcheck', slug: 'sunrise-soundcheck', description: 'Clean daypart wake-up mix — no explicit lyrics, all coffee.', host: 'Auntie Reese', dayOfWeek: 1, startHour: 6, startMinute: 0, durationMin: 120, explicit: false, kind: 'PLAYLIST', accent: 'amber' },
    { name: 'The Midday Mixdown', slug: 'midday-mixdown', description: 'Lunch-hour heat from the Clean Daypart playlist, sponsor window included.', host: 'DJ Lumberton', dayOfWeek: 1, startHour: 12, startMinute: 0, durationMin: 60, explicit: false, kind: 'PLAYLIST', accent: 'amber' },
    { name: 'Carolina Cypher', slug: 'carolina-cypher', description: 'Live freestyle cypher and guest 16s, straight from the studio floor.', host: '910 Rex', dayOfWeek: 5, startHour: 21, startMinute: 0, durationMin: 120, explicit: true, kind: 'LIVE', accent: 'red' },
    { name: 'New Heat', slug: 'new-heat', description: 'Fresh submissions that cleared the rights gate this week, front to back.', host: 'Miss Appy', dayOfWeek: 2, startHour: 19, startMinute: 0, durationMin: 120, explicit: true, kind: 'PLAYLIST', accent: 'orange' },
    { name: 'Throwback Vault', slug: 'throwback-vault', description: 'Saturday afternoon deep cuts from the Carolinas vault, 1998–2009.', host: 'Sir Prolific', dayOfWeek: 6, startHour: 14, startMinute: 0, durationMin: 120, explicit: false, kind: 'PLAYLIST', accent: 'yellow' },
    { name: 'Static & Samples', slug: 'static-and-samples', description: 'Long-form interviews: producers break down the sample, artists tell the story.', host: 'Auntie Reese', dayOfWeek: 0, startHour: 17, startMinute: 0, durationMin: 60, explicit: false, kind: 'LIVE', accent: 'amber' },
    { name: 'Late Night Frequencies', slug: 'late-night-frequencies', description: 'After-hours explicit rotation. Headphones weather.', host: 'AutoDJ', dayOfWeek: 5, startHour: 23, startMinute: 0, durationMin: 120, explicit: true, kind: 'PLAYLIST', accent: 'red' },
    { name: 'Sunday Soul Bath', slug: 'sunday-soul-bath', description: 'Slow jams and soul loops to close out the week, fully clean.', host: 'PALMetto Kai', dayOfWeek: 0, startHour: 9, startMinute: 0, durationMin: 120, explicit: false, kind: 'PLAYLIST', accent: 'amber' },
    { name: 'Overnight Rotation', slug: 'overnight-rotation', description: 'The Fallback playlist holds the line until sunrise. No dead air, ever.', host: 'AutoDJ', dayOfWeek: 1, startHour: 1, startMinute: 0, durationMin: 300, explicit: false, kind: 'PLAYLIST', accent: 'zinc' },
  ]
  for (const s of shows) {
    await db.show.create({ data: s })
  }

  // ---------- Submissions pipeline demo ----------
  await db.submission.createMany({
    data: [
      {
        artistName: 'Wilm Wonder', email: 'wilm@wonderworks.example', trackTitle: 'Concrete Azaleas', genre: 'Hip-Hop',
        explicit: false, city: 'Wilmington', state: 'NC', socials: '@wilmwonder',
        fileName: 'wilm-wonder__concrete-azaleas__R0011.mp3', fileSize: 4_912_000,
        status: 'APPROVED', agreementVersion: 'v1.1', agreementAcceptedAt: new Date('2025-11-02T18:22:00Z'), agreementIp: '152.4.118.7',
        reviewNotes: 'Sample verified original. Cleared and added to New Heat.', reviewedAt: new Date('2025-11-04T20:11:00Z'), rightsId: 'R0011',
        createdAt: new Date('2025-11-02T18:20:00Z'),
      },
      {
        artistName: 'G-Ville Grant', email: 'grant@grantwriting.example', trackTitle: 'Interstate 85 Sermon', genre: 'Trap',
        explicit: true, city: 'Greensboro', state: 'NC', socials: '@gvilleg',
        fileName: 'gville-grant__i85-sermon__R0012.mp3', fileSize: 5_310_000,
        status: 'APPROVED', agreementVersion: 'v1.1', agreementAcceptedAt: new Date('2025-11-06T01:02:00Z'), agreementIp: '24.148.66.221',
        reviewNotes: 'Explicit — night rotation only. Cleared.', reviewedAt: new Date('2025-11-07T15:40:00Z'), rightsId: 'R0012',
        createdAt: new Date('2025-11-06T01:00:00Z'),
      },
      {
        artistName: 'Lil Coast', email: 'lilcoast@beachmail.example', trackTitle: 'Summer in the Sauc (feat. sample)', genre: 'Hip-Hop',
        explicit: false, city: 'Myrtle Beach', state: 'SC', socials: '@lilcoast',
        fileName: 'lil-coast__summer-in-the-sauc.mp3', fileSize: 6_020_000,
        status: 'IN_REVIEW', agreementVersion: 'v1.1', agreementAcceptedAt: new Date('2025-12-01T14:30:00Z'), agreementIp: '107.13.90.44',
        reviewNotes: 'Contains a 6s sample — awaiting clearance proof.',
        createdAt: new Date('2025-12-01T14:28:00Z'),
      },
      {
        artistName: 'Unknown Demo Tape', email: 'drop@demo.example', trackTitle: 'Baseline Bootleg', genre: 'Boom Bap',
        explicit: true, city: 'Columbia', state: 'SC', socials: null,
        fileName: 'baseline-bootleg.mp3', fileSize: 7_100_000,
        status: 'DECLINED', agreementVersion: 'v1.1', agreementAcceptedAt: new Date('2025-12-03T09:00:00Z'), agreementIp: '66.42.11.9',
        reviewNotes: 'Uncleared commercial sample, artist unresponsive. Blocked at rights gate.',
        reviewedAt: new Date('2025-12-05T11:15:00Z'), rightsId: 'R9001',
        createdAt: new Date('2025-12-03T08:58:00Z'),
      },
      {
        artistName: 'EB Sound', email: 'eb@ebsound.example', trackTitle: 'Salt Marsh Sunset', genre: 'Lo-fi Hip-Hop',
        explicit: false, city: 'Beaufort', state: 'NC', socials: '@ebsound252',
        fileName: 'eb-sound__salt-marsh-sunset__R0015.mp3', fileSize: 5_750_000,
        status: 'APPROVED', agreementVersion: 'v1.1', agreementAcceptedAt: new Date('2025-11-20T22:05:00Z'), agreementIp: '209.91.140.3',
        reviewNotes: 'Instrumental, fully cleared.', reviewedAt: new Date('2025-11-22T13:00:00Z'), rightsId: 'R0015',
        createdAt: new Date('2025-11-20T22:02:00Z'),
      },
      {
        artistName: 'Furni Drew', email: 'drew@furnicity.example', trackTitle: 'High Point Henny', genre: 'Trap',
        explicit: true, city: 'High Point', state: 'NC', socials: '@furnidrew',
        fileName: 'furni-drew__high-point-henny__R0014.mp3', fileSize: 4_480_000,
        status: 'IN_REVIEW', agreementVersion: 'v1.1', agreementAcceptedAt: new Date('2025-12-10T03:44:00Z'), agreementIp: '152.7.22.61',
        reviewNotes: null,
        createdAt: new Date('2025-12-10T03:40:00Z'),
      },
      {
        artistName: 'RB Slade', email: 'slade@sladesound.example', trackTitle: 'Peach County Politics', genre: 'Conscious',
        explicit: false, city: 'Gaffney', state: 'SC', socials: '@rbslade',
        fileName: 'rb-slade__peach-county-politics__R0013.mp3', fileSize: 5_010_000,
        status: 'PENDING', agreementVersion: 'v1.1', agreementAcceptedAt: new Date('2025-12-14T19:12:00Z'), agreementIp: '72.180.33.19',
        reviewNotes: null,
        createdAt: new Date('2025-12-14T19:10:00Z'),
      },
    ],
  })

  // ---------- Sponsors + campaigns ----------
  const coffee = await db.sponsor.create({
    data: {
      name: 'Queen City Coffee Co.', contact: 'ops@queencitycoffee.example', tier: 'DAYPART_SPONSOR', monthlyRate: 45_000,
      status: 'ACTIVE', startAt: new Date('2025-11-01T00:00:00Z'),
    },
  })
  const supply = await db.sponsor.create({
    data: {
      name: 'Carolina Sound Supply', contact: 'hello@casoundsupply.example', tier: 'SHOW_SPONSOR', monthlyRate: 30_000,
      status: 'ACTIVE', startAt: new Date('2025-11-15T00:00:00Z'),
    },
  })
  const fest = await db.sponsor.create({
    data: {
      name: 'Brew & Bars Festival', contact: 'promo@brewbars.example', tier: 'ON_AIR_SPOT', monthlyRate: 18_000,
      status: 'ACTIVE', startAt: new Date('2025-12-01T00:00:00Z'),
    },
  })
  const c1 = await db.campaign.create({
    data: { sponsorId: coffee.id, name: 'Morning Roast Clean Daypart', spotsPerDay: 6, creativeName: 'qcc-morning-roast-30.mp3', startAt: new Date('2025-11-01T00:00:00Z') },
  })
  const c2 = await db.campaign.create({
    data: { sponsorId: supply.id, name: 'Carolina Cypher Show Sponsor', spotsPerDay: 4, creativeName: 'css-cypher-sponsor-30.mp3', startAt: new Date('2025-11-15T00:00:00Z') },
  })
  const c3 = await db.campaign.create({
    data: { sponsorId: fest.id, name: 'March 2026 Festival Push', spotsPerDay: 8, creativeName: 'brew-bars-fest-15.mp3', startAt: new Date('2025-12-01T00:00:00Z') },
  })

  // ---------- History: play log for last 48h (deterministic-ish) + ad plays ----------
  const tracks = await db.track.findMany({ where: { playlist: { not: 'Imaging' } }, orderBy: { seedOrder: 'asc' } })
  const now = Date.now()
  let cursor = now - 48 * 3600 * 1000
  let i = 0
  const playLogRows: Array<{ trackId: string; playedAt: Date; source: string }> = []
  while (cursor < now - 30 * 1000) {
    const t = tracks[i % tracks.length]
    playLogRows.push({ trackId: t.id, playedAt: new Date(cursor), source: 'AUTODJ' })
    cursor += (t.durationSec + 14) * 1000
    i++
  }
  await db.playLog.createMany({ data: playLogRows })

  // ad plays for last 3 days: spotsPerDay per campaign per day at spread hours
  const campaigns = [
    { c: c1, baseHour: 7, spread: 2.5 },
    { c: c2, baseHour: 21, spread: 1.2 },
    { c: c3, baseHour: 12, spread: 3 },
  ]
  const adRows: Array<{ campaignId: string; playedAt: Date; source: string }> = []
  for (const { c, baseHour, spread } of campaigns) {
    for (let d = 2; d >= 0; d--) {
      for (let s = 0; s < c.spotsPerDay; s++) {
        const dt = new Date(now - d * 24 * 3600 * 1000)
        dt.setHours(0, 0, 0, 0)
        dt.setMinutes(Math.round((baseHour * 60 + s * (24 * 60 / c.spotsPerDay)) % (24 * 60) + (s % 2) * spread))
        if (dt.getTime() < now - 60 * 1000 && dt.getTime() >= now - 3.2 * 24 * 3600 * 1000) {
          adRows.push({ campaignId: c.id, playedAt: dt, source: 'azuracast-history' })
        }
      }
    }
  }
  await db.adPlay.createMany({ data: adRows })

  // ---------- Settings ----------
  await db.stationSetting.createMany({
    data: [
      { key: 'station_name', value: 'WAVC 91.3 FM' },
      { key: 'tagline', value: 'The Carolinas\u2019 independent hip-hop signal' },
      { key: 'rights_gate', value: 'ENFORCED' },
      { key: 'bitrate_kbps', value: '128' },
      { key: 'timezone', value: 'America/New_York' },
      { key: 'agreement_version', value: 'v1.1' },
    ],
  })

  const counts = {
    tracks: await db.track.count(),
    rights: await db.rightsLog.count(),
    shows: await db.show.count(),
    submissions: await db.submission.count(),
    sponsors: await db.sponsor.count(),
    campaigns: await db.campaign.count(),
    adPlays: await db.adPlay.count(),
    playLog: await db.playLog.count(),
  }
  console.log('Seed complete:', counts)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
