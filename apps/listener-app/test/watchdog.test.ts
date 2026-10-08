import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStalled } from '../src/player/watchdog.ts';

test('isStalled: not stalled while the position advances', () => {
  assert.equal(
    isStalled({ playing: true, positionSec: 130, lastPositionSec: 120, elapsedMs: 12000 }),
    false,
  );
});

test('isStalled: stalled when playing, frozen past the default threshold', () => {
  assert.equal(
    isStalled({ playing: true, positionSec: 120, lastPositionSec: 120, elapsedMs: 9000 }),
    true,
  );
});

test('isStalled: never stalled while paused', () => {
  assert.equal(
    isStalled({ playing: false, positionSec: 120, lastPositionSec: 120, elapsedMs: 60000 }),
    false,
  );
});

test('isStalled: below the threshold is not yet stalled', () => {
  assert.equal(
    isStalled({ playing: true, positionSec: 120, lastPositionSec: 120, elapsedMs: 3000 }),
    false,
  );
});

test('isStalled: respects a custom threshold', () => {
  const args = { playing: true, positionSec: 1, lastPositionSec: 1, elapsedMs: 2500 };
  assert.equal(isStalled({ ...args, thresholdMs: 2000 }), true);
  assert.equal(isStalled({ ...args, thresholdMs: 5000 }), false);
});

test('isStalled: sub-quarter-second jitter counts as not moving', () => {
  assert.equal(
    isStalled({ playing: true, positionSec: 120.1, lastPositionSec: 120, elapsedMs: 9000 }),
    true,
  );
});
