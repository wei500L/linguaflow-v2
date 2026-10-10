import crypto from 'node:crypto';
import { REFERRAL } from '@linguaflow/shared';

const disposableDomains = new Set([
  '10minutemail.com', '10minutemail.net', 'burnermail.io', 'discard.email', 'dispostable.com',
  'emailondeck.com', 'fakeinbox.com', 'getnada.com', 'guerrillamail.biz', 'guerrillamail.com',
  'guerrillamail.info', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com',
  'mailcatch.com', 'maildrop.cc', 'mailinator.com', 'mailnesia.com', 'mintemail.com', 'moakt.com',
  'mytemp.email', 'sharklasers.com', 'temp-mail.org', 'tempail.com', 'tempmail.com', 'tempmailo.com',
  'throwawaymail.com', 'tmpmail.net', 'tmpmail.org', 'trashmail.com', 'trashmail.de', 'yopmail.com',
  'yopmail.fr'
]);

/* Shared inboxes. A burst here is normal and must not look like a private domain. */
const publicDomains = new Set([
  '163.com', '126.com', '139.com', '189.cn', 'aliyun.com', 'aol.com', 'bk.ru', 'daum.net',
  'foxmail.com', 'gmail.com', 'gmx.com', 'gmx.net', 'googlemail.com', 'hanmail.net', 'hotmail.com',
  'icloud.com', 'inbox.ru', 'list.ru', 'live.com', 'mac.com', 'mail.ru', 'me.com', 'msn.com',
  'naver.com', 'outlook.com', 'outlook.jp', 'pm.me', 'privaterelay.appleid.com', 'proton.me',
  'protonmail.com', 'qq.com', 'rambler.ru', 'sina.cn', 'sina.com', 'sohu.com', 'ya.ru', 'yahoo.com',
  'yahoo.co.jp', 'yandex.com', 'yandex.ru', 'yeah.net'
]);

export type ReferralDecision = { decision: 'allow' | 'reject' | 'hold'; reason: string | null };

export type ReferralSignalInput = {
  inviterFound: boolean;
  self: boolean;
  deviceOverlap: boolean;
  disposableEmail: boolean;
  identityUsed: boolean;
  pendingCount: number;
  recentCount: number;
  sameDomainRecentCount: number;
  customDomain: boolean;
  sameIp: boolean;
  sameIpRecentCount: number;
  weakDevice: boolean;
};

export function emailDomain(identity: string) {
  const at = identity.lastIndexOf('@');
  return at > 0 ? identity.slice(at + 1) : '';
}

export function isDisposableDomain(domain: string) {
  return disposableDomains.has(domain.toLowerCase());
}

export function isCustomReferralDomain(domain: string) {
  const normalized = domain.toLowerCase();
  return Boolean(normalized) && !publicDomains.has(normalized) && !disposableDomains.has(normalized);
}

/* Reject beats hold. The first matching rule wins so a self-invite on a weak
   device is stored as self_referral, not as a review queue item. */
export function evaluateReferral(input: ReferralSignalInput): ReferralDecision {
  if (!input.inviterFound) return { decision: 'reject', reason: 'inviter_missing' };
  if (input.self) return { decision: 'reject', reason: 'self_referral' };
  if (input.deviceOverlap) return { decision: 'reject', reason: 'device_overlap' };
  if (input.disposableEmail) return { decision: 'reject', reason: 'disposable_email' };
  if (input.identityUsed) return { decision: 'reject', reason: 'identity_used' };
  if (input.pendingCount >= REFERRAL.pendingCap) return { decision: 'reject', reason: 'pending_full' };
  if (input.sameIp && input.sameIpRecentCount >= 1) return { decision: 'hold', reason: 'same_ip_burst' };
  if (input.recentCount >= REFERRAL.velocityCap) return { decision: 'hold', reason: 'inviter_velocity' };
  if (input.customDomain && input.sameDomainRecentCount + 1 >= REFERRAL.domainBurstAt) return { decision: 'hold', reason: 'domain_burst' };
  if (input.weakDevice) return { decision: 'hold', reason: 'weak_device' };
  return { decision: 'allow', reason: null };
}

export function referralReward(monthlyQualified: number, lifetimeQualified: number) {
  if (lifetimeQualified >= REFERRAL.lifetimeQualifiedCap) {
    return { inviteeSeconds: REFERRAL.inviteeSeconds, inviterSeconds: 0, reason: 'inviter_lifetime_capped' };
  }
  if (monthlyQualified >= REFERRAL.monthlyQualifiedCap) {
    return { inviteeSeconds: REFERRAL.inviteeSeconds, inviterSeconds: 0, reason: 'inviter_monthly_capped' };
  }
  return { inviteeSeconds: REFERRAL.inviteeSeconds, inviterSeconds: REFERRAL.inviterSeconds, reason: null };
}

export function nextIpHits(hits: number, windowStartMs: number, nowMs: number, windowMs: number) {
  if (nowMs - windowStartMs >= windowMs) return { hits: 1, windowStartMs: nowMs };
  return { hits: hits + 1, windowStartMs };
}

export function registerIpBlocked(hits: number) {
  return hits > REFERRAL.registerIpPerHour;
}

export function makeInviteCode() {
  const alphabet = REFERRAL.codeAlphabet;
  let code = '';
  const bytes = crypto.randomBytes(REFERRAL.codeLength);
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return code;
}

export const openReferral: ReferralSignalInput = {
  inviterFound: true,
  self: false,
  deviceOverlap: false,
  disposableEmail: false,
  identityUsed: false,
  pendingCount: 0,
  recentCount: 0,
  sameDomainRecentCount: 0,
  customDomain: false,
  sameIp: false,
  sameIpRecentCount: 0,
  weakDevice: false
};
