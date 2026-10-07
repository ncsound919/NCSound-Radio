import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

/**
 * Internal admin authentication.
 *
 * There was no authentication here at all: the only gate on every mutating ops
 * route was an `x-ops-pin` header compared against a constant baked into the
 * source, which the ops UI helpfully told the user to type. That is not an
 * internal boundary, it is a shared secret in the repository.
 *
 * What this is instead:
 *
 *  - **A credential, hashed.** scrypt with a per-account random salt. The
 *    plaintext is never stored and never logged.
 *  - **A real session.** A signed, expiring, HttpOnly, SameSite=Strict cookie,
 *    rather than a PIN resent on every request — which could be replayed from
 *    a proxy log, a shell history entry or a page.
 *  - **Revocable.** The signature covers an epoch held in the database;
 *    logging out bumps the epoch, which invalidates every outstanding session
 *    at once. A purely stateless token could not be withdrawn.
 *  - **No default.** `adminConfigured()` is false until an operator runs
 *    `scripts/set-admin-password.ts`. There is no bootstrap credential to
 *    forget to change, which is exactly the failure mode the old PIN had.
 */

export const ADMIN_COOKIE = 'ncsound_admin'

/** An operator shift, not a week. */
const SESSION_TTL_SEC = 60 * 60 * 12

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 64

type Settings = {
  adminUser: string | null
  adminHash: string | null
  secret: string | null
  epoch: string | null
}

async function loadSettings(): Promise<Settings> {
  const rows = await db.stationSetting.findMany({
    where: {
      key: { in: ['admin_user', 'admin_pw_hash', 'admin_session_secret', 'admin_session_epoch'] },
    },
  })
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  return {
    adminUser: byKey.get('admin_user') ?? null,
    adminHash: byKey.get('admin_pw_hash') ?? null,
    secret: byKey.get('admin_session_secret') ?? null,
    epoch: byKey.get('admin_session_epoch') ?? null,
  }
}

async function setSetting(key: string, value: string): Promise<void> {
  await db.stationSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

/** False until an operator has set a credential. Used to explain, not to block. */
export async function adminConfigured(): Promise<boolean> {
  const s = await loadSettings()
  return Boolean(s.adminUser && s.adminHash && s.secret)
}

// ---- password hashing -----------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password.normalize('NFKC'), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$')
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts
  try {
    const salt = Buffer.from(saltB64!, 'base64url')
    const expected = Buffer.from(hashB64!, 'base64url')
    const actual = scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

// ---- credentials ----------------------------------------------------------

/**
 * Create or replace the admin credential.
 *
 * Replaces the session secret too when there is none, and leaves the epoch
 * alone so existing sessions survive a password change — an operator changing
 * a forgotten password has not asked to be logged out everywhere, but they
 * have asked to be the only one who can get in from now on.
 */
export async function setAdminCredential(user: string, password: string): Promise<void> {
  if (!user.trim()) throw new Error('username must not be empty')
  if (password.length < 10) {
    throw new Error('password must be at least 10 characters')
  }
  const current = await loadSettings()
  await setSetting('admin_user', user.trim())
  await setSetting('admin_pw_hash', hashPassword(password))
  if (!current.secret) {
    await setSetting('admin_session_secret', randomBytes(32).toString('base64url'))
  }
  if (!current.epoch) {
    await setSetting('admin_session_epoch', randomBytes(8).toString('base64url'))
  }
}

// ---- sessions -------------------------------------------------------------

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

/**
 * Cookie value: `epoch.b64url(user).expiresAt.signature`.
 *
 * The username is base64url-encoded because the token is split on `.`: a raw
 * username like `john.redd` produced five parts, so every session it minted
 * was rejected by `parse` and that admin could sign in but never stay in.
 */
function mint(epoch: string, user: string, expiresAt: number, secret: string): string {
  const payload = `${epoch}.${Buffer.from(user, 'utf8').toString('base64url')}.${expiresAt}`
  return `${payload}.${sign(payload, secret)}`
}

function parse(token: string, secret: string, epoch: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [tokEpoch, userB64, expiresAt, signature] = parts as [string, string, string, string]
  const expected = sign(`${tokEpoch}.${userB64}.${expiresAt}`, secret)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  // Epoch mismatch means the session was withdrawn.
  if (tokEpoch !== epoch) return null
  if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now()) return null
  const user = Buffer.from(userB64, 'base64url').toString('utf8')
  return user || null
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

/** The signed-in admin, or null. Never throws and never says why not. */
export async function currentAdmin(request: Request): Promise<{ user: string } | null> {
  const s = await loadSettings()
  if (!s.adminUser || !s.adminHash || !s.secret || !s.epoch) return null
  const token = readCookie(request, ADMIN_COOKIE)
  if (!token) return null
  const user = parse(token, s.secret, s.epoch)
  return user ? { user } : null
}

/**
 * Guard for internal routes. Returns a ready-to-return 401, or null.
 *
 * The message is deliberately uniform. Distinguishing "no such user" from
 * "wrong password" from "no session" hands an attacker a free oracle.
 */
export async function requireAdmin(request: Request): Promise<NextResponse | null> {
  if (await currentAdmin(request)) return null
  return NextResponse.json({ error: 'Sign in to the control room.' }, { status: 401 })
}

export type LoginOutcome =
  | { ok: true; response: NextResponse }
  | { ok: false; response: NextResponse }

/**
 * Attempt a sign-in.
 *
 * Runs a dummy hash when no admin exists or the username does not match, so
 * the response time does not reveal whether an account is configured. Without
 * that, "is there an admin?" is answerable by measuring.
 */
export async function login(
  request: Request,
  user: string,
  password: string,
): Promise<LoginOutcome> {
  const s = await loadSettings()
  const fail = () =>
    NextResponse.json({ error: 'Wrong username or password.' }, { status: 401 })

  if (!s.adminUser || !s.adminHash || !s.secret || !s.epoch) {
    // No credential set up yet: burn comparable time, then explain.
    scryptSync('no-admin-configured', randomBytes(16), KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    })
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            'No admin credential exists yet. Run: bun run --cwd apps/station-web scripts/set-admin-password.ts',
        },
        { status: 503 },
      ),
    }
  }

  const userMatches = safeEqual(user.trim(), s.adminUser)
  const hash = userMatches ? s.adminHash : DUMMY_HASH
  const passwordOk = verifyPassword(password, hash)

  if (!userMatches || !passwordOk) return { ok: false, response: fail() }

  const expiresAt = Date.now() + SESSION_TTL_SEC * 1000
  const token = mint(s.epoch, s.adminUser, expiresAt, s.secret)
  const response = NextResponse.json({ ok: true, user: s.adminUser })
  response.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    // The station runs on plain http on loopback, so `secure` would make the
    // cookie unusable locally. Set behind TLS, this should be true.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SEC,
  })
  return { ok: true, response }
}

/**
 * Sign out.
 *
 * Bumps the epoch so the presented cookie is dead even if the client keeps a
 * copy, and clears the cookie on the way out.
 */
export async function logout(): Promise<NextResponse> {
  await setSetting('admin_session_epoch', randomBytes(8).toString('base64url'))
  const response = NextResponse.json({ ok: true })
  response.cookies.set(ADMIN_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
  return response
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** A real hash of a value nobody can supply, used to equalise timing. */
const DUMMY_HASH = hashPassword('timing-equaliser-not-a-credential')
