import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { STREAM_MOUNTS, streamBaseUrl, streamDescriptor, streamUrl } from '../src/lib/stream'

const KEYS = ['NEXT_PUBLIC_STREAM_BASE_URL', 'NCSOUND_STREAM_BASE_URL'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('stream descriptor', () => {
  test('falls back to the loopback Icecast when nothing is configured', () => {
    expect(streamBaseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  test('prefers the public env over the server env, and strips trailing slashes', () => {
    process.env.NCSOUND_STREAM_BASE_URL = 'http://server-only:9999'
    expect(streamBaseUrl()).toBe('http://server-only:9999')
    process.env.NEXT_PUBLIC_STREAM_BASE_URL = 'https://stream.example.com/'
    expect(streamBaseUrl()).toBe('https://stream.example.com')
  })

  test('a blank configured base is ignored, not used as an empty URL', () => {
    process.env.NEXT_PUBLIC_STREAM_BASE_URL = '   '
    expect(streamBaseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  test('the mount paths and bitrates are the encoder contract', () => {
    expect(STREAM_MOUNTS.hi.path).toBe('/live.mp3')
    expect(STREAM_MOUNTS.hi.bitrateKbps).toBe(128)
    expect(STREAM_MOUNTS.mobile.path).toBe('/mobile.mp3')
    expect(STREAM_MOUNTS.mobile.bitrateKbps).toBe(64)
  })

  test('streamUrl joins the base and mount with no double slash', () => {
    expect(streamUrl('hi', 'https://x')).toBe('https://x/live.mp3')
    expect(streamUrl('mobile', 'https://x')).toBe('https://x/mobile.mp3')
  })

  test('the descriptor carries absolute urls and a null hls placeholder', () => {
    const d = streamDescriptor('https://stream.example.com')
    expect(d.baseUrl).toBe('https://stream.example.com')
    expect(d.live.url).toBe('https://stream.example.com/live.mp3')
    expect(d.mobile.url).toBe('https://stream.example.com/mobile.mp3')
    expect(d.hls).toBeNull()
    expect(typeof d.updatedAt).toBe('string')
  })
})
