import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STREAM_MOUNTS, qualityFor, mountUrl } from '../src/data/streams.ts';

test('qualityFor: data saver selects the 64k mobile mount', () => {
  assert.equal(qualityFor(true), 'mobile');
  assert.equal(qualityFor(false), 'hi');
});

test('mountUrl: joins the base and the mount without doubling slashes', () => {
  assert.equal(mountUrl('https://stream.example.com/', 'hi'), 'https://stream.example.com/live.mp3');
  assert.equal(mountUrl('https://stream.example.com', 'mobile'), 'https://stream.example.com/mobile.mp3');
});

test('STREAM_MOUNTS: hi is 128k, mobile is 64k', () => {
  assert.equal(STREAM_MOUNTS.hi.bitrateKbps, 128);
  assert.equal(STREAM_MOUNTS.mobile.bitrateKbps, 64);
  assert.equal(STREAM_MOUNTS.hi.path, '/live.mp3');
  assert.equal(STREAM_MOUNTS.mobile.path, '/mobile.mp3');
});
