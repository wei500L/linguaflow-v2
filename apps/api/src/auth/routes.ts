import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordUserDevice } from '../lib/device-store.js';
import { clientAddress } from '../lib/device.js';
import { assertAuthIpAllowed } from '../lib/auth-ip.js';
import { bindReferral } from '../lib/referral.js';
import { accessClaims } from './access.js';
import { checkLoginAllowed, createUser, findUser, recordLoginResult, reserveCodeSlot, resetPassword, sendCode, verifyCode, verifyPassword } from './service.js';

/* Phones often submit a trailing space from autofill or the keyboard.
   Zod rejects that as an invalid email before the address is normalized. */
const emailSchema = z.object({ email: z.string().trim().email() });
const passwordSchema = emailSchema.extend({ password: z.string().trim().min(8) });

export async function authRoutes(app: FastifyInstance) {
  app.get('/v1/auth/config', async () => ({ passwordLoginEnabled: true, codeLoginEnabled: true, oauthEnabled: false }));

  app.post('/v1/auth/email/register/code', async (request) => {
    const body = emailSchema.parse(request.body);
    await assertAuthIpAllowed(clientAddress(request.headers, request.ip), 'register_code');
    if (await findUser(body.email)) await reserveCodeSlot(body.email, 'register');
    else await sendCode(body.email, 'register');
    return { sent: true };
  });

  app.post('/v1/auth/email/register', async (request, reply) => {
    const body = passwordSchema.extend({ code: z.string().length(6), inviteCode: z.string().trim().max(40).optional() }).parse(request.body);
    await assertAuthIpAllowed(clientAddress(request.headers, request.ip), 'register');
    if (await findUser(body.email)) return reply.code(409).send({ message: 'Email already registered' });
    if (!await verifyCode(body.email, 'register', body.code)) return reply.code(400).send({ message: 'Invalid verification code' });
    const user = await createUser(body.email, body.password, clientAddress(request.headers, request.ip));
    const device = await recordUserDevice(user.id, request);
    let invite: { applied: boolean; status: string | null } = { applied: false, status: null };
    try {
      invite = await bindReferral({ inviteeId: user.id, inviteeEmail: user.email, inviteCode: body.inviteCode, device, signupIp: clientAddress(request.headers, request.ip) });
    } catch (error) {
      request.log.error({ err: error }, 'referral bind failed');
    }
    return reply.code(201).send({ user: { id: user.id, email: user.email }, token: app.jwt.sign(accessClaims(user), { expiresIn: '24h' }), invite });
  });

  app.post('/v1/auth/email/login/code', async (request) => {
    const body = emailSchema.parse(request.body);
    await assertAuthIpAllowed(clientAddress(request.headers, request.ip), 'login_code');
    if (await findUser(body.email)) await sendCode(body.email, 'login');
    else await reserveCodeSlot(body.email, 'login');
    return { sent: true };
  });

  app.post('/v1/auth/email/login/code/verify', async (request, reply) => {
    const body = emailSchema.extend({ code: z.string().length(6) }).parse(request.body);
    if (!await checkLoginAllowed(body.email)) return reply.code(429).send({ message: 'Too many login attempts' });
    const user = await findUser(body.email);
    if (!user || !await verifyCode(body.email, 'login', body.code)) { await recordLoginResult(body.email, false); return reply.code(401).send({ message: 'Invalid verification code' }); }
    await recordLoginResult(body.email, true);
    await recordUserDevice(user.id, request);
    return { user: { id: user.id, email: user.email }, token: app.jwt.sign(accessClaims(user), { expiresIn: '24h' }) };
  });

  app.post('/v1/auth/email/login/password', async (request, reply) => {
    const body = passwordSchema.parse(request.body);
    if (!await checkLoginAllowed(body.email)) return reply.code(429).send({ message: 'Too many login attempts' });
    const user = await findUser(body.email);
    if (!user || !await verifyPassword(user, body.password)) { await recordLoginResult(body.email, false); return reply.code(401).send({ message: 'Invalid credentials' }); }
    await recordLoginResult(body.email, true);
    await recordUserDevice(user.id, request);
    return { user: { id: user.id, email: user.email }, token: app.jwt.sign(accessClaims(user), { expiresIn: '24h' }) };
  });

  app.post('/v1/auth/email/password-reset/code', async (request) => {
    const { email } = emailSchema.parse(request.body);
    await assertAuthIpAllowed(clientAddress(request.headers, request.ip), 'password_reset_code');
    if (await findUser(email)) await sendCode(email, 'password_reset');
    else await reserveCodeSlot(email, 'password_reset');
    return { sent: true };
  });

  app.post('/v1/auth/refresh', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as { sub: string; role: string; tv: number };
    return { token: app.jwt.sign({ sub: user.sub, role: user.role, tv: user.tv }, { expiresIn: '24h' }) };
  });

  app.post('/v1/auth/email/password-reset', async (request, reply) => {
    const { email, code, password } = passwordSchema.extend({ code: z.string().length(6) }).parse(request.body);
    if (!await verifyCode(email, 'password_reset', code)) return reply.code(400).send({ message: 'Invalid verification code' });
    await resetPassword(email, password);
    return { reset: true };
  });
}
