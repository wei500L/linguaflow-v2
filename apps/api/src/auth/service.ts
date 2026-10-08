import argon2 from 'argon2';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { and, desc, eq, isNull, gt, sql as query } from 'drizzle-orm';
import { db } from '../db/index.js';
import { authCodes, entitlements, loginAttempts, users } from '../db/schema.js';
import { config } from '../config.js';
import { ensureEntitlement } from '../lib/quota.js';

const codeHash = (code: string) => crypto.createHash('sha256').update(code).digest('hex');
const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function sendCode(emailInput: string, purpose: string) {
  const email = normalizeEmail(emailInput);
  const [last] = await db.select().from(authCodes).where(and(eq(authCodes.email, email), eq(authCodes.purpose, purpose))).orderBy(desc(authCodes.createdAt)).limit(1);
  if (last && Date.now() - last.createdAt.getTime() < 60_000) throw Object.assign(new Error('Please wait before resending a code'), { statusCode: 429 });
  const code = String(crypto.randomInt(100000, 1000000));
  await db.insert(authCodes).values({ email, purpose, codeHash: codeHash(code), expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
  if (config.smtp.host && config.smtp.user && config.smtp.password) {
    const transport = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, auth: { user: config.smtp.user, pass: config.smtp.password }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000 });
    await transport.sendMail({ from: config.smtp.from, to: email, subject: 'Your LinguaFlow verification code', text: `Your verification code is ${code}. It expires in 10 minutes.` });
  } else if (config.nodeEnv !== 'production') {
    console.info(`[LinguaFlow] verification code for ${email}: ${code}`);
  } else {
    throw new Error('SMTP is not configured');
  }
}

export async function verifyCode(emailInput: string, purpose: string, code: string) {
  const email = normalizeEmail(emailInput);
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(authCodes).where(and(eq(authCodes.email, email), eq(authCodes.purpose, purpose), isNull(authCodes.consumedAt), gt(authCodes.expiresAt, new Date()))).orderBy(desc(authCodes.createdAt)).limit(1).for('update');
    if (!row) return false;
    if (row.attempts >= 5 || row.codeHash !== codeHash(code)) {
      await tx.update(authCodes).set({ attempts: query`${authCodes.attempts} + 1` }).where(eq(authCodes.id, row.id));
      return false;
    }
    await tx.update(authCodes).set({ consumedAt: new Date() }).where(eq(authCodes.id, row.id));
    return true;
  });
}

export async function checkLoginAllowed(emailInput: string) {
  const [row] = await db.select().from(loginAttempts).where(eq(loginAttempts.email, normalizeEmail(emailInput)));
  return !row?.blockedUntil || row.blockedUntil <= new Date();
}

export async function recordLoginResult(emailInput: string, success: boolean) {
  const email = normalizeEmail(emailInput);
  if (success) { await db.delete(loginAttempts).where(eq(loginAttempts.email, email)); return; }
  const [row] = await db.insert(loginAttempts).values({ email, failures: 1 }).onConflictDoUpdate({ target: loginAttempts.email, set: { failures: query`${loginAttempts.failures} + 1`, updatedAt: new Date() } }).returning();
  if (row.failures >= 5) await db.update(loginAttempts).set({ blockedUntil: new Date(Date.now() + 15 * 60_000), failures: 0 }).where(eq(loginAttempts.email, email));
}

export async function resetPassword(emailInput: string, password: string) {
  await db.update(users).set({ passwordHash: await argon2.hash(password) }).where(eq(users.email, normalizeEmail(emailInput)));
}

export async function changePassword(userId: string, currentPassword: string, nextPassword: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !await verifyPassword(user, currentPassword)) return false;
  await db.update(users).set({ passwordHash: await argon2.hash(nextPassword) }).where(eq(users.id, userId));
  return true;
}

export async function bootstrapOwner(emailInput: string, password: string) {
  const email = normalizeEmail(emailInput);
  const existing = await findUser(email);
  const user = existing ?? await createUser(email, password);
  if (!existing) {
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, user.id));
  } else if (existing.role !== 'admin') {
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, existing.id));
  }
  await ensureEntitlement(user.id);
  await db.update(entitlements).set({ plan: 'ultra', status: 'active', planExpiresAt: null }).where(eq(entitlements.userId, user.id));
  return user;
}

export async function createUser(emailInput: string, password?: string) {
  const email = normalizeEmail(emailInput);
  const passwordHash = password ? await argon2.hash(password) : null;
  const [user] = await db.insert(users).values({ email, passwordHash, displayName: email.split('@')[0], role: config.adminEmail === email ? 'admin' : 'user' }).returning();
  await ensureEntitlement(user.id);
  return user;
}

export async function findUser(emailInput: string) {
  const [user] = await db.select().from(users).where(eq(users.email, normalizeEmail(emailInput))).limit(1);
  return user;
}

export async function verifyPassword(user: typeof users.$inferSelect, password: string) {
  return Boolean(user.passwordHash && await argon2.verify(user.passwordHash, password));
}
