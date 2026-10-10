import { and, eq } from 'drizzle-orm';
import { REFERRAL } from '@linguaflow/shared';
import { db } from '../db/index.js';
import { authIpLimits } from '../db/schema.js';
import { nextIpHits, registerIpBlocked } from './referral-risk.js';

const windowMs = REFERRAL.registerWindowHours * 60 * 60 * 1000;

export async function assertAuthIpAllowed(ip: string | null, purpose: 'register_code' | 'register' | 'login_code' | 'password_reset_code') {
  const key = ip || 'unknown';
  const now = new Date();
  await db.transaction(async (tx) => {
    const inserted = await tx.insert(authIpLimits).values({ ip: key, purpose, windowStart: now, hits: 1 }).onConflictDoNothing().returning();
    if (inserted.length) return;
    const [row] = await tx.select().from(authIpLimits).where(and(eq(authIpLimits.ip, key), eq(authIpLimits.purpose, purpose))).for('update');
    if (!row) return;
    const next = nextIpHits(row.hits, row.windowStart.getTime(), now.getTime(), windowMs);
    await tx.update(authIpLimits).set({ hits: next.hits, windowStart: new Date(next.windowStartMs) }).where(and(eq(authIpLimits.ip, key), eq(authIpLimits.purpose, purpose)));
    if (registerIpBlocked(next.hits)) {
      const message = purpose === 'register' || purpose === 'register_code' ? 'Too many registration attempts' : 'Too many attempts';
      throw Object.assign(new Error(message), { statusCode: 429 });
    }
  });
}
