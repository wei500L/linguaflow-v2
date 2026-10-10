import assert from 'node:assert/strict';
import test from 'node:test';
import { REFERRAL, normalizeInviteCode } from '@linguaflow/shared';
import {
  emailDomain,
  evaluateReferral,
  isCustomReferralDomain,
  isDisposableDomain,
  makeInviteCode,
  nextIpHits,
  openReferral,
  referralReward,
  registerIpBlocked
} from '../src/lib/referral-risk.ts';

test('invite codes use the unambiguous alphabet', () => {
  assert.equal(normalizeInviteCode(' ab23cdef '), 'AB23CDEF');
  assert.equal(normalizeInviteCode('short'), null);
  assert.equal(normalizeInviteCode('ab23cdef'), 'AB23CDEF');
  assert.equal(normalizeInviteCode('AB23CDE0'), null);
  const code = makeInviteCode();
  assert.equal(code, normalizeInviteCode(code));
  assert.equal(code.length, REFERRAL.codeLength);
});

test('a clean invite is allowed', () => {
  assert.deepEqual(evaluateReferral(openReferral), { decision: 'allow', reason: null });
});

test('self, device, disposable, used identity and a full queue are rejected', () => {
  assert.equal(evaluateReferral({ ...openReferral, self: true }).reason, 'self_referral');
  assert.equal(evaluateReferral({ ...openReferral, deviceOverlap: true }).reason, 'device_overlap');
  assert.equal(evaluateReferral({ ...openReferral, disposableEmail: true }).reason, 'disposable_email');
  assert.equal(evaluateReferral({ ...openReferral, identityUsed: true }).reason, 'identity_used');
  assert.equal(evaluateReferral({ ...openReferral, pendingCount: REFERRAL.pendingCap - 1 }).decision, 'allow');
  assert.equal(evaluateReferral({ ...openReferral, pendingCount: REFERRAL.pendingCap }).reason, 'pending_full');
  assert.equal(evaluateReferral({ ...openReferral, inviterFound: false }).reason, 'inviter_missing');
});

test('the first shared network is allowed and the next one is held', () => {
  assert.equal(evaluateReferral({ ...openReferral, sameIp: true, sameIpRecentCount: 0 }).decision, 'allow');
  assert.equal(evaluateReferral({ ...openReferral, sameIp: true, sameIpRecentCount: 1 }).reason, 'same_ip_burst');
  assert.equal(evaluateReferral({ ...openReferral, sameIp: false, sameIpRecentCount: 4 }).decision, 'allow');
});

test('velocity, a private-domain burst and a weak device are held', () => {
  assert.equal(evaluateReferral({ ...openReferral, recentCount: REFERRAL.velocityCap - 1 }).decision, 'allow');
  assert.equal(evaluateReferral({ ...openReferral, recentCount: REFERRAL.velocityCap }).reason, 'inviter_velocity');
  assert.equal(isCustomReferralDomain('gmail.com'), false);
  assert.equal(isDisposableDomain('mailinator.com'), true);
  assert.equal(isCustomReferralDomain('studio.example'), true);
  assert.equal(evaluateReferral({ ...openReferral, customDomain: false, sameDomainRecentCount: 9 }).decision, 'allow');
  assert.equal(evaluateReferral({ ...openReferral, customDomain: true, sameDomainRecentCount: REFERRAL.domainBurstAt - 2 }).decision, 'allow');
  assert.equal(evaluateReferral({ ...openReferral, customDomain: true, sameDomainRecentCount: REFERRAL.domainBurstAt - 1 }).reason, 'domain_burst');
  assert.equal(evaluateReferral({ ...openReferral, weakDevice: true }).reason, 'weak_device');
});

test('a reject is not downgraded to a hold', () => {
  const decision = evaluateReferral({ ...openReferral, deviceOverlap: true, weakDevice: true, recentCount: 20 });
  assert.deepEqual(decision, { decision: 'reject', reason: 'device_overlap' });
});

test('inviter caps still pay the invited account', () => {
  assert.equal(referralReward(0, 0).inviterSeconds, REFERRAL.inviterSeconds);
  assert.equal(referralReward(REFERRAL.monthlyQualifiedCap, 0).reason, 'inviter_monthly_capped');
  assert.equal(referralReward(REFERRAL.monthlyQualifiedCap, 0).inviteeSeconds, REFERRAL.inviteeSeconds);
  assert.equal(referralReward(REFERRAL.monthlyQualifiedCap, 0).inviterSeconds, 0);
  assert.equal(referralReward(0, REFERRAL.lifetimeQualifiedCap).reason, 'inviter_lifetime_capped');
  assert.equal(referralReward(REFERRAL.monthlyQualifiedCap, REFERRAL.lifetimeQualifiedCap).reason, 'inviter_lifetime_capped');
});

test('registration attempts reset after the window and block past the hourly cap', () => {
  const hour = REFERRAL.registerWindowHours * 60 * 60 * 1000;
  const inside = nextIpHits(REFERRAL.registerIpPerHour, 0, hour - 1, hour);
  assert.equal(inside.hits, REFERRAL.registerIpPerHour + 1);
  assert.equal(registerIpBlocked(inside.hits), true);
  assert.equal(registerIpBlocked(REFERRAL.registerIpPerHour), false);
  const reset = nextIpHits(99, 0, hour, hour);
  assert.deepEqual(reset, { hits: 1, windowStartMs: hour });
  assert.equal(emailDomain('a.b@studio.example'), 'studio.example');
});
