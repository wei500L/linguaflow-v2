import argon2 from 'argon2';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { and, desc, eq, isNull, gt, sql as query } from 'drizzle-orm';
import { db } from '../db/index.js';
import { authCodes, entitlements, loginAttempts, users } from '../db/schema.js';
import { config } from '../config.js';
import { canonicalEmail } from '../lib/email.js';
import { ensureEntitlement } from '../lib/quota.js';

const codeHash = (code: string) => crypto.createHash('sha256').update(code).digest('hex');
const normalizeEmail = (email: string) => canonicalEmail(email);

export async function findUserById(id: string) {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

/* A missing account still consumes the resend window, so the status code matches an account that exists. */
export async function reserveCodeSlot(emailInput: string, purpose: string) {
  const email = normalizeEmail(emailInput);
  const [last] = await db.select().from(authCodes).where(and(eq(authCodes.email, email), eq(authCodes.purpose, purpose))).orderBy(desc(authCodes.createdAt)).limit(1);
  if (last && Date.now() - last.createdAt.getTime() < 60_000) throw Object.assign(new Error('Please wait before resending a code'), { statusCode: 429 });
  await db.insert(authCodes).values({ email, purpose, codeHash: codeHash(crypto.randomBytes(16).toString('hex')), expiresAt: new Date(Date.now() + 60_000), consumedAt: new Date() });
}

export async function sendCode(emailInput: string, purpose: string) {
  const email = normalizeEmail(emailInput);
  const [last] = await db.select().from(authCodes).where(and(eq(authCodes.email, email), eq(authCodes.purpose, purpose))).orderBy(desc(authCodes.createdAt)).limit(1);
  if (last && Date.now() - last.createdAt.getTime() < 60_000) throw Object.assign(new Error('Please wait before resending a code'), { statusCode: 429 });
  const code = String(crypto.randomInt(100000, 1000000));
  await db.insert(authCodes).values({ email, purpose, codeHash: codeHash(code), expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
  if (config.smtp.host && config.smtp.user && config.smtp.password) {
    const transport = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, auth: { user: config.smtp.user, pass: config.smtp.password }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000 });
    await transport.sendMail({ from: config.smtp.from, to: emailInput.trim(), subject: 'Your LinguaFlow verification code', text: `Your verification code is ${code}. It expires in 10 minutes.` });
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
  const user = await findUser(emailInput);
  if (!user) return;
  await db.update(users).set({ passwordHash: await argon2.hash(password), tokenVersion: query`${users.tokenVersion} + 1` }).where(eq(users.id, user.id));
}

export async function changePassword(userId: string, currentPassword: string, nextPassword: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !await verifyPassword(user, currentPassword)) return null;
  const [updated] = await db.update(users).set({ passwordHash: await argon2.hash(nextPassword), tokenVersion: query`${users.tokenVersion} + 1` }).where(eq(users.id, userId)).returning({ id: users.id, role: users.role, tokenVersion: users.tokenVersion });
  return updated ?? null;
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

export async function createUser(emailInput: string, password?: string, signupIp?: string | null) {
  const typed = emailInput.trim().toLowerCase();
  const email = canonicalEmail(typed);
  const passwordHash = password ? await argon2.hash(password) : null;
  const [user] = await db.insert(users).values({ email, passwordHash, displayName: email.split('@')[0], role: config.adminEmail === typed ? 'admin' : 'user', signupIp: signupIp || null }).returning();
  await ensureEntitlement(user.id);
  return user;
}

export async function findUser(emailInput: string) {
  const typed = emailInput.trim().toLowerCase();
  const canonical = canonicalEmail(typed);
  const [typedUser] = await db.select().from(users).where(eq(users.email, typed)).limit(1);
  if (typedUser) return typedUser;
  if (canonical !== typed) {
    const [canonicalUser] = await db.select().from(users).where(eq(users.email, canonical)).limit(1);
    if (canonicalUser) return canonicalUser;
  }
  if (!canonical.endsWith('@gmail.com')) return undefined;
  const at = canonical.lastIndexOf('@');
  const local = canonical.slice(0, at);
  const [alias] = await db.select().from(users).where(query`
    lower(split_part(${users.email}, '@', 2)) in ('gmail.com', 'googlemail.com')
    and regexp_replace(split_part(split_part(lower(${users.email}), '@', 1), '+', 1), '\\.', '', 'g') = ${local}
  `).limit(1);
  return alias;
}

export async function verifyPassword(user: typeof users.$inferSelect, password: string) {
  return Boolean(user.passwordHash && await argon2.verify(user.passwordHash, password));
}
