import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDevicePayload, encodeDeviceHeader } from './device.ts';
import { shouldRefreshAccessToken } from './session.ts';

test('the access token refreshes only during a live session that is near expiry', () => {
  assert.equal(shouldRefreshAccessToken(false, true), false);
  assert.equal(shouldRefreshAccessToken(true, false), false);
  assert.equal(shouldRefreshAccessToken(true, true), true);
});

test('a device header carries the fields the API accepts', () => {
  const payload = buildDevicePayload({
    deviceId: '11111111-1111-4111-8111-111111111111',
    screen: '1920x1080x24',
    cores: 8,
    memory: 8,
    touch: 0,
    platform: 'MacIntel',
    timezone: 'Europe/Moscow',
    webgl: 'Apple M1',
    canvas: 'abcdef1234567890'
  });
  const parsed = JSON.parse(Buffer.from(encodeDeviceHeader(JSON.stringify(payload)), 'base64url').toString('utf8'));
  assert.equal(parsed.deviceId, payload.deviceId);
  assert.equal(parsed.screen, '1920x1080x24');
  assert.equal(parsed.canvas, 'abcdef1234567890');
  assert.equal(typeof parsed.cores, 'number');
});
