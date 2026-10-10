import assert from 'node:assert/strict';
import test from 'node:test';
import { usableSeconds } from '../format.ts';

test('available time includes add-on minutes and leaves an unlimited plan unlimited', () => {
  assert.equal(usableSeconds({ remainingSeconds: 0, addonSeconds: 120 }), 120);
  assert.equal(usableSeconds({ remainingSeconds: 30, addonSeconds: 90 }), 120);
  assert.equal(usableSeconds({ remainingSeconds: Number.MAX_SAFE_INTEGER, addonSeconds: 90 }), Number.MAX_SAFE_INTEGER);
});
