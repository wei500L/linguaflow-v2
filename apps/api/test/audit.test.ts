import assert from 'node:assert/strict';
import argon2 from 'argon2';
import test from 'node:test';
import { acceptPcmFrame, PCM_BYTES_PER_SECOND } from '@linguaflow/shared';
import { accessStillValid } from '../src/auth/access.ts';
import { assertProductionReady } from '../src/config.ts';
import { completeAccountDeletion } from '../src/lib/account-files.ts';
import { sharePasswordMatches } from '../src/lib/share-password.ts';

test('an access token is rejected when the user is gone or the version moved', () => {
  const user = { id: 'user-1', role: 'admin', tokenVersion: 2 };
  assert.deepEqual(accessStillValid(user, { sub: 'user-1', role: 'user', tv: 2 }), { sub: 'user-1', role: 'admin', tv: 2 });
  assert.equal(accessStillValid(user, { sub: 'user-1', tv: 1 }), null);
  assert.equal(accessStillValid(undefined, { sub: 'user-1', tv: 0 }), null);
  assert.deepEqual(accessStillValid({ ...user, tokenVersion: 0 }, { sub: 'user-1', role: 'user' }), { sub: 'user-1', role: 'admin', tv: 0 });
});

test('pcm forwarding stops at the reserved seconds instead of the wall clock', () => {
  const budget = PCM_BYTES_PER_SECOND;
  assert.equal(acceptPcmFrame(0, budget, 1), true);
  assert.equal(acceptPcmFrame(budget - 1, 2, 1), false);
  assert.equal(acceptPcmFrame(0, budget * 30, 1), false);
  assert.equal(acceptPcmFrame(budget * 29, budget, 30), true);
});

test('a share recording requires the password when one is set', async () => {
  const passwordHash = await argon2.hash('correct-horse');
  assert.equal(await sharePasswordMatches({ passwordHash }, ''), false);
  assert.equal(await sharePasswordMatches({ passwordHash }, 'wrong'), false);
  assert.equal(await sharePasswordMatches({ passwordHash }, 'correct-horse'), true);
  assert.equal(await sharePasswordMatches({ passwordHash: null }, ''), true);
});

test('account files stay when a later delete throws', async () => {
  const removed: string[] = [];
  await assert.rejects(() => completeAccountDeletion(async () => {
    throw new Error('second delete');
  }, async (path) => { removed.push(path); }));
  assert.deepEqual(removed, []);
  await completeAccountDeletion(async () => ['user/session.wav'], async (path) => { removed.push(path); });
  assert.deepEqual(removed, ['user/session.wav']);
});

test('production startup refuses to run without SMTP', () => {
  assert.doesNotThrow(() => assertProductionReady({ nodeEnv: 'development', smtp: { host: '', user: '', password: '' } }));
  assert.throws(() => assertProductionReady({ nodeEnv: 'production', smtp: { host: 'smtp.example.com', user: '', password: 'secret' } }), /SMTP is not configured/);
  assert.doesNotThrow(() => assertProductionReady({ nodeEnv: 'production', smtp: { host: 'smtp.example.com', user: 'mailer', password: 'secret' } }));
});
