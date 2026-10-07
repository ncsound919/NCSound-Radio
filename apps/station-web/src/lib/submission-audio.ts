import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

/**
 * Where submitted audio lives on disk.
 *
 * Uploads used to be read, measured and thrown away: the form accepted up to
 * 15MB and stored only `fileName`/`fileSize`, so the A&R desk reviewed a track
 * nobody could hear and "approved" one the engine could never play.
 *
 * Two folders, deliberately separate:
 *
 *  - INBOX (`NCSOUND_SUBMISSIONS_DIR`): every upload lands here, named by
 *    submission id. Nothing in here is ever aired; the engine does not scan it.
 *  - LIBRARY (`NCSOUND_LIBRARY`): the engine's crate. A submission is copied
 *    here only when an admin approves it, so approval is what decides what
 *    can go on air.
 *
 * Defaults match packages/ingest/src/main.ts, which reads the same library.
 */
const DEFAULT_LIBRARY = 'C:/Users/User/Music/music'

export const libraryDir = (): string => resolve(process.env.NCSOUND_LIBRARY ?? DEFAULT_LIBRARY)

/** Beside the library, never inside it: the engine scans the library recursively. */
export const inboxDir = (): string =>
  resolve(process.env.NCSOUND_SUBMISSIONS_DIR ?? join(libraryDir(), '..', 'submissions'))

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
}

export const ALLOWED_AUDIO_EXTS = Object.keys(MIME_BY_EXT)

/** Extension the engine can decode, or null. Taken from the name, then checked against the bytes. */
export function audioExt(fileName: string): string | null {
  const ext = extname(fileName).toLowerCase()
  return ext in MIME_BY_EXT ? ext : null
}

/**
 * Does the content look like the format its extension claims?
 * A cheap magic-byte check: it keeps a renamed .exe or .html out of the
 * crate, it does not prove the file decodes.
 */
export function looksLikeAudio(buf: Uint8Array, ext: string): boolean {
  const ascii = (from: number, len: number) => Buffer.from(buf.subarray(from, from + len)).toString('latin1')
  switch (ext) {
    case '.mp3':
      return ascii(0, 3) === 'ID3' || (buf[0] === 0xff && ((buf[1] ?? 0) & 0xe0) === 0xe0)
    case '.wav':
      return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE'
    case '.flac':
      return ascii(0, 4) === 'fLaC'
    case '.ogg':
      return ascii(0, 4) === 'OggS'
    case '.m4a':
      return ascii(4, 4) === 'ftyp'
    case '.aiff':
    case '.aif':
      return ascii(0, 4) === 'FORM'
    default:
      return false
  }
}

/** Safe single path segment: no separators, no traversal, no control or reserved characters. */
export function safeSegment(s: string, max = 80): string {
  const cleaned = s
    .normalize('NFKC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, max)
    .trim()
  return cleaned || 'untitled'
}

export function newSubmissionId(): string {
  return randomUUID()
}

/** The inbox path for a submission. Built from the id we generated, never from the upload's name. */
export const inboxPath = (id: string, ext: string): string => join(inboxDir(), `${id}${ext}`)

export async function saveToInbox(id: string, ext: string, data: Uint8Array): Promise<string> {
  await mkdir(inboxDir(), { recursive: true })
  const path = inboxPath(id, ext)
  // `wx`: never overwrite. Ids are random UUIDs, so a collision means something is wrong.
  await writeFile(path, data, { flag: 'wx' })
  return path
}

export async function removeFromInbox(id: string, ext: string): Promise<void> {
  await unlink(inboxPath(id, ext)).catch(() => {})
}

export type PromoteResult =
  | { promoted: true; path: string }
  | { promoted: false; reason: string }

/**
 * Copy an approved submission's audio into the engine's library.
 *
 * Copy, not move: the inbox stays as the record of what was submitted.
 * Never overwrites an existing library file.
 */
export async function promoteToLibrary(
  id: string,
  originalName: string | null,
  artist: string,
  title: string,
): Promise<PromoteResult> {
  const ext = audioExt(originalName ?? '')
  if (!ext) return { promoted: false, reason: 'this submission has no audio file attached' }
  const src = inboxPath(id, ext)
  if (!(await stat(src).then((s) => s.isFile()).catch(() => false))) {
    return { promoted: false, reason: `audio file not found in the inbox (${basename(src)})` }
  }
  const destName = `${safeSegment(artist, 60)} - ${safeSegment(title, 80)}${ext}`
  const dest = join(libraryDir(), destName)
  try {
    await mkdir(libraryDir(), { recursive: true })
    await copyFile(src, dest, 1 /* COPYFILE_EXCL: never overwrite */)
    return { promoted: true, path: dest }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return { promoted: false, reason: `${destName} already exists in the library` }
    return { promoted: false, reason: `copy into the library failed: ${(e as Error).message}` }
  }
}
