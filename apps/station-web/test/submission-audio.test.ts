import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOWED_AUDIO_EXTS,
  audioExt,
  inboxDir,
  libraryDir,
  looksLikeAudio,
  newSubmissionId,
  promoteToLibrary,
  safeSegment,
  saveToInbox,
} from '../src/lib/submission-audio'

const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)))

let work: string
const savedLib = process.env.NCSOUND_LIBRARY
const savedInbox = process.env.NCSOUND_SUBMISSIONS_DIR

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'ncsound-sub-'))
  process.env.NCSOUND_LIBRARY = join(work, 'music')
  process.env.NCSOUND_SUBMISSIONS_DIR = join(work, 'submissions')
})
afterAll(() => {
  if (savedLib === undefined) delete process.env.NCSOUND_LIBRARY
  else process.env.NCSOUND_LIBRARY = savedLib
  if (savedInbox === undefined) delete process.env.NCSOUND_SUBMISSIONS_DIR
  else process.env.NCSOUND_SUBMISSIONS_DIR = savedInbox
  rmSync(work, { recursive: true, force: true })
})

describe('audioExt', () => {
  test('accepts only decodeable extensions, case-insensitively', () => {
    expect(audioExt('track.mp3')).toBe('.mp3')
    expect(audioExt('TRACK.WAV')).toBe('.wav')
    expect(audioExt('a.flac')).toBe('.flac')
    expect(audioExt('evil.exe')).toBeNull()
    expect(audioExt('noext')).toBeNull()
    expect(ALLOWED_AUDIO_EXTS).toContain('.mp3')
  })
})

describe('looksLikeAudio (magic bytes)', () => {
  test('recognises each supported container by its signature', () => {
    expect(looksLikeAudio(ascii('ID3'), '.mp3')).toBe(true)
    expect(looksLikeAudio(new Uint8Array([0xff, 0xfb, 0x00]), '.mp3')).toBe(true)
    expect(looksLikeAudio(new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]), '.wav')).toBe(true)
    expect(looksLikeAudio(ascii('fLaC'), '.flac')).toBe(true)
    expect(looksLikeAudio(ascii('OggS'), '.ogg')).toBe(true)
    expect(looksLikeAudio(new Uint8Array([0, 0, 0, 0, ...ascii('ftyp')]), '.m4a')).toBe(true)
    expect(looksLikeAudio(ascii('FORM'), '.aiff')).toBe(true)
  })

  test('rejects a renamed non-audio file and a mismatched container', () => {
    // An HTML file named .mp3 must not reach the crate.
    expect(looksLikeAudio(ascii('<html>'), '.mp3')).toBe(false)
    // RIFF bytes are not FLAC.
    expect(looksLikeAudio(new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]), '.flac')).toBe(false)
    // Unknown extension is never audio.
    expect(looksLikeAudio(ascii('ID3'), '.exe')).toBe(false)
  })
})

describe('safeSegment', () => {
  test('strips path separators and traversal so an uploaded name cannot escape', () => {
    expect(safeSegment('AC/DC')).toBe('AC DC')
    const seg = safeSegment('..\\..\\etc\\passwd')
    expect(seg).not.toContain('/')
    expect(seg).not.toContain('\\')
    expect(seg).not.toContain('..')
  })

  test('drops reserved, control and colon characters', () => {
    expect(safeSegment('a\u0000b')).toBe('a b')
    expect(safeSegment('a:b*c?d|e')).toBe('a b c d e')
  })

  test('an empty or dots-only name becomes untitled, and length is capped', () => {
    expect(safeSegment('')).toBe('untitled')
    expect(safeSegment('...')).toBe('untitled')
    expect(safeSegment('a'.repeat(200), 10)).toBe('aaaaaaaaaa')
  })
})

describe('inbox -> library promotion', () => {
  test('the inbox sits beside the library, never inside it', () => {
    expect(inboxDir()).not.toBe(libraryDir())
    expect(inboxDir().startsWith(libraryDir())).toBe(false)
  })

  test('a saved submission is copied into the library under a safe name', async () => {
    const id = newSubmissionId()
    await saveToInbox(id, '.mp3', ascii('ID3fake-bytes'))
    const res = await promoteToLibrary(id, 'x.mp3', 'AC/DC', 'Back In Black')
    expect(res.promoted).toBe(true)
    if (res.promoted) {
      expect(existsSync(res.path)).toBe(true)
      // Artist slash is neutralised in the destination filename.
      expect(res.path.includes('AC DC - Back In Black.mp3')).toBe(true)
    }
  })

  test('promotion never overwrites an existing library file', async () => {
    const id1 = newSubmissionId()
    const id2 = newSubmissionId()
    await saveToInbox(id1, '.mp3', ascii('ID3one'))
    await saveToInbox(id2, '.mp3', ascii('ID3two'))
    const first = await promoteToLibrary(id1, 'x.mp3', 'Same', 'Title')
    expect(first.promoted).toBe(true)
    const second = await promoteToLibrary(id2, 'x.mp3', 'Same', 'Title')
    expect(second.promoted).toBe(false)
    if (!second.promoted) expect(second.reason).toContain('already exists')
  })

  test('a submission with no attachment, or no file in the inbox, reports why', async () => {
    const noName = await promoteToLibrary(newSubmissionId(), null, 'A', 'T')
    expect(noName.promoted).toBe(false)
    if (!noName.promoted) expect(noName.reason).toContain('no audio file')

    const missing = await promoteToLibrary(newSubmissionId(), 'ghost.mp3', 'A', 'T')
    expect(missing.promoted).toBe(false)
    if (!missing.promoted) expect(missing.reason).toContain('not found')
  })
})
