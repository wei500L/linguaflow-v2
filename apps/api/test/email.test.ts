import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalEmail, referralIdentity } from '../src/lib/email.ts';

test('gmail dots, plus-tags and googlemail.com are one inbox', () => {
  assert.equal(canonicalEmail('A.B+wool@gmail.com'), 'ab@gmail.com');
  assert.equal(canonicalEmail('a.b+other@googlemail.com'), 'ab@gmail.com');
  assert.equal(canonicalEmail('ab@gmail.com'), 'ab@gmail.com');
});

test('other providers keep plus-tags and dots', () => {
  assert.equal(canonicalEmail('A.B+wool@outlook.com'), 'a.b+wool@outlook.com');
  assert.equal(canonicalEmail('  User@Example.com '), 'user@example.com');
});

test('referral identity strips plus-tags without merging login addresses', () => {
  assert.equal(referralIdentity('A.B+wool@outlook.com'), 'a.b@outlook.com');
  assert.equal(referralIdentity('a.b+other@outlook.com'), referralIdentity('A.B+wool@outlook.com'));
  assert.equal(canonicalEmail('A.B+wool@outlook.com'), 'a.b+wool@outlook.com');
  assert.equal(referralIdentity('A.B+wool@gmail.com'), 'ab@gmail.com');
});
