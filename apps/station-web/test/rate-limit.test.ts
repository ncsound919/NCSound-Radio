import { afterEach, describe, expect, test } from 'bun:test'
import { allow, clientIp, sweepRateLimits, trustedClientIp } from '../src/lib/rate-limit'

const rnd = () => `${Date.now()}-${Math.random()}`

describe('sliding-window limiter', () => {
  test('permits up to max hits in the window, then refuses', () => {
    const key = `test:${rnd()}`
    expect(allow(key, 2, 60_000)).toBe(true)
    expect(allow(key, 2, 60_000)).toBe(true)
    expect(allow(key, 2, 60_000)).toBe(false)
  })

  test('each key has its own budget', () => {
    const a = `a:${rnd()}`
    const b = `b:${rnd()}`
    expect(allow(a, 1, 60_000)).toBe(true)
    expect(allow(a, 1, 60_000)).toBe(false)
    expect(allow(b, 1, 60_000)).toBe(true)
  })

  test('hits older than the window are pruned (a zero window admits every call)', () => {
    const key = `prune:${rnd()}`
    expect(allow(key, 1, 0)).toBe(true)
    expect(allow(key, 1, 0)).toBe(true)
  })

  test('sweepRateLimits is safe to call', () => {
    expect(() => sweepRateLimits()).not.toThrow()
  })
})

describe('client ip resolution', () => {
  const saved = process.env.TRUST_PROXY
  afterEach(() => {
    if (saved === undefined) delete process.env.TRUST_PROXY
    else process.env.TRUST_PROXY = saved
  })

  test('forwarding headers are ignored unless TRUST_PROXY=1', () => {
    delete process.env.TRUST_PROXY
    const req = new Request('http://x', {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8', 'x-real-ip': '9.9.9.9' },
    })
    expect(trustedClientIp(req)).toBeNull()
    // No trusted address means every caller shares one bucket — unbypassable.
    expect(clientIp(req)).toBe('direct')
  })

  test('with a trusted proxy the rightmost hop is used (the one the proxy appended)', () => {
    process.env.TRUST_PROXY = '1'
    const req = new Request('http://x', {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8', 'x-real-ip': '9.9.9.9' },
    })
    expect(trustedClientIp(req)).toBe('5.6.7.8')
    expect(clientIp(req)).toBe('5.6.7.8')
  })

  test('x-real-ip is the fallback when there is no x-forwarded-for', () => {
    process.env.TRUST_PROXY = '1'
    const req = new Request('http://x', { headers: { 'x-real-ip': '9.9.9.9' } })
    expect(trustedClientIp(req)).toBe('9.9.9.9')
  })
})
