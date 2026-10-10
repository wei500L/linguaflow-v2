import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalScreen, claimKeys, clientAddress, fingerprintHash, freeDeviceDecision, parseDeviceHeader, serverClaimKeys } from '../src/lib/device.ts';

const signals = {
  deviceId: '11111111-1111-4111-8111-111111111111',
  screen: '1920x1080x24',
  cores: 8,
  memory: 8,
  touch: 0,
  platform: 'MacIntel',
  timezone: 'Europe/Moscow',
  webgl: 'Apple M1',
  canvas: 'abcdef1234567890'
};

test('fingerprint hash ignores the stored device id and stays stable', () => {
  const hash = fingerprintHash(signals);
  const renamed = fingerprintHash({ ...signals, deviceId: '22222222-2222-4222-8222-222222222222' });
  assert.equal(hash, renamed);
  assert.equal(hash, fingerprintHash({ ...signals, timezone: 'Asia/Shanghai' }));
  assert.equal(hash.length, 64);
  assert.notEqual(hash, fingerprintHash({ ...signals, canvas: 'fedcba0987654321' }));
  assert.notEqual(hash, fingerprintHash({ ...signals, screen: '390x844x32' }));
});

test('paid plans can start without a device', () => {
  for (const plan of ['plus', 'pro', 'ultra']) {
    assert.deepEqual(freeDeviceDecision({ plan, userId: 'a', hasDevice: false, claims: [{ userId: 'other', releasedAt: null }] }), { ok: true });
  }
});

test('a free session without a device is rejected', () => {
  assert.deepEqual(freeDeviceDecision({ plan: 'free', userId: 'a', hasDevice: false, claims: [] }), { ok: false, code: 'device_required' });
});

test('a free account is allowed when the device has not used the quota', () => {
  assert.deepEqual(freeDeviceDecision({ plan: 'free', userId: 'a', hasDevice: true, claims: [] }), { ok: true });
});

test('the account that used the free quota can keep using what is left', () => {
  assert.deepEqual(freeDeviceDecision({
    plan: 'free',
    userId: 'a',
    hasDevice: true,
    claims: [{ userId: 'a', releasedAt: null }]
  }), { ok: true });
});

test('another free account on a used device is blocked', () => {
  assert.deepEqual(freeDeviceDecision({
    plan: 'free',
    userId: 'b',
    hasDevice: true,
    claims: [{ userId: 'a', releasedAt: null }]
  }), { ok: false, code: 'free_device_blocked' });
});

test('a released claim lets the next free account through', () => {
  assert.deepEqual(freeDeviceDecision({
    plan: 'free',
    userId: 'b',
    hasDevice: true,
    claims: [{ userId: 'a', releasedAt: new Date('2026-10-08T00:00:00Z') }]
  }), { ok: true });
});

test('one blocking key is enough when the fingerprint and device id disagree', () => {
  assert.deepEqual(freeDeviceDecision({
    plan: 'free',
    userId: 'b',
    hasDevice: true,
    claims: [
      { userId: 'b', releasedAt: null },
      { userId: 'a', releasedAt: null }
    ]
  }), { ok: false, code: 'free_device_blocked' });
});

test('claim keys cover the fingerprint and the device id', () => {
  assert.deepEqual(claimKeys('abc', '11111111-1111-4111-8111-111111111111'), ['fp:abc', 'dev:11111111-1111-4111-8111-111111111111']);
  assert.deepEqual(claimKeys('abc', '11111111-1111-4111-8111-111111111111', false), ['dev:11111111-1111-4111-8111-111111111111']);
});

test('turning a phone sideways does not create a second fingerprint', () => {
  assert.equal(canonicalScreen('390x844x32'), canonicalScreen('844x390x32'));
  assert.equal(fingerprintHash({ ...signals, screen: '390x844x32' }), fingerprintHash({ ...signals, screen: '844x390x32' }));
  assert.notEqual(fingerprintHash(signals), fingerprintHash({ ...signals, screen: '390x844x32' }));
});

test('a forged forwarding header cannot replace the address the proxy actually saw', () => {
  const headers = { 'x-forwarded-for': '1.2.3.4, 203.0.113.8, 172.18.0.3' };
  assert.equal(clientAddress(headers, '::ffff:172.17.0.2'), '203.0.113.8');
  assert.equal(clientAddress({ 'x-forwarded-for': '1.2.3.4' }, '203.0.113.9'), '203.0.113.9');
  assert.equal(clientAddress({ 'x-forwarded-for': '8.8.8.8, 192.168.1.20' }, '172.18.0.4'), '192.168.1.20');
  assert.equal(clientAddress({ 'x-forwarded-for': '1.2.3.4, 10.1.2.3, 172.17.0.1' }, '::FFFF:172.18.0.5'), '10.1.2.3');
  assert.equal(clientAddress({}, '127.0.0.1'), '127.0.0.1');
});

test('a device header accepts json and base64url json, and drops a bad payload', () => {
  assert.equal(parseDeviceHeader(undefined), null);
  assert.equal(parseDeviceHeader('not-json'), null);
  assert.equal(parseDeviceHeader(JSON.stringify({ ...signals, canvas: 'short' })), null);
  assert.equal(parseDeviceHeader(JSON.stringify(signals))?.timezone, 'Europe/Moscow');
  const encoded = Buffer.from(JSON.stringify(signals)).toString('base64url');
  assert.equal(parseDeviceHeader(encoded)?.canvas, signals.canvas);
});

test('a second free account on the same IP is blocked inside the window, then allowed', () => {
  const claimedAt = new Date('2026-10-09T10:00:00Z');
  const claim = { userId: 'a', releasedAt: null, key: 'ip:abc', claimedAt };
  assert.deepEqual(freeDeviceDecision({
    plan: 'free', userId: 'b', hasDevice: true, now: new Date('2026-10-09T12:00:00Z'), claims: [claim]
  }), { ok: false, code: 'free_device_blocked' });
  assert.deepEqual(freeDeviceDecision({
    plan: 'free', userId: 'b', hasDevice: true, now: new Date('2026-10-10T11:00:00Z'), claims: [claim]
  }), { ok: true });
});

test('a public mailbox domain is not a free-quota claim, and a disposable domain is', () => {
  const gmail = serverClaimKeys({ signupIp: '203.0.113.8', email: 'person@gmail.com' });
  assert.equal(gmail.length, 1);
  assert.equal(gmail[0]?.startsWith('ip:'), true);
  const disposable = serverClaimKeys({ signupIp: null, email: 'person@mailinator.com' });
  assert.deepEqual(disposable, ['dom:mailinator.com']);
  const custom = serverClaimKeys({ signupIp: '203.0.113.8', email: 'person@example.test' });
  assert.equal(custom.some((key) => key === 'dom:example.test'), true);
});
