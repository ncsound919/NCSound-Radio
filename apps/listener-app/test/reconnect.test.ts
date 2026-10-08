import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, nextBackoffMs, BACKOFF_MS } from '../src/player/reconnect.ts';

test('classifyError: transient HTTP statuses are retryable', () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(classifyError({ status }), 'transient', `status ${status}`);
  }
});

test('classifyError: permanent HTTP statuses fail fast', () => {
  for (const status of [400, 401, 403, 404, 410, 418]) {
    assert.equal(classifyError({ status }), 'permanent', `status ${status}`);
  }
});

test('classifyError: network-ish messages are transient, unknown errors are not permanent', () => {
  assert.equal(classifyError({ message: 'Network request failed' }), 'transient');
  assert.equal(classifyError({ name: 'AbortError' }), 'transient');
  assert.equal(classifyError({ message: 'socket hang up' }), 'transient');
  assert.equal(classifyError(undefined), 'transient'); // unknown -> retry conservatively
  assert.equal(classifyError({ message: 'decoder failed' }), 'permanent');
});

test('classifyError: string player error codes map to retry classes', () => {
  assert.equal(classifyError({ code: 'network' }), 'transient');
  assert.equal(classifyError({ code: 'unknown' }), 'transient');
  assert.equal(classifyError({ code: 'source' }), 'permanent');
  assert.equal(classifyError({ code: 'renderer' }), 'permanent');
  assert.equal(classifyError({ code: 'play-not-permitted' }), 'permanent');
  assert.equal(classifyError({ code: 'controller-connection-failed' }), 'permanent');
});

test('classifyError: react-native-video errorCode strings', () => {
  // Unrecoverable: retrying will not help.
  assert.equal(classifyError({ errorCode: 'ERROR_CODE_IO_FILE_NOT_FOUND' }), 'permanent');
  assert.equal(classifyError({ errorCode: 'ERROR_CODE_PARSING_CONTAINER_MALFORMED' }), 'permanent');
  // Recoverable transport/decoder hiccups: retry.
  assert.equal(classifyError({ errorCode: 'ERROR_CODE_IO_BAD_HTTP_STATUS' }), 'transient');
  assert.equal(classifyError({ errorCode: 'ERROR_CODE_DECODING_FAILED' }), 'transient');
});

test('nextBackoffMs: bounded exponential sequence, then exhausted', () => {
  assert.equal(nextBackoffMs(0), 1000);
  assert.equal(nextBackoffMs(1), 2000);
  assert.equal(nextBackoffMs(2), 4000);
  assert.equal(nextBackoffMs(BACKOFF_MS.length - 1), 30000);
  // out of range -> null (stop retrying)
  assert.equal(nextBackoffMs(BACKOFF_MS.length), null);
  assert.equal(nextBackoffMs(-1), null);
});
