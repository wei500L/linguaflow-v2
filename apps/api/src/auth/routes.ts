import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkLoginAllowed, createUser, findUser, recordLoginResult, resetPassword, sendCode, verifyCode, verifyPassword } from './service.js';

/* Phones often submit a trailing space from autofill or the keyboard.
   Zod rejects that as an invalid email before the address is normalized. */
const emailSchema = z.object({ email: z.string().trim().email() });
const passwordSchema = emailSchema.extend({ password: z.string().trim().min(8) });

export async function authRoutes(app: FastifyInstance) {
  app.get('/v1/auth/config', async () => ({ passwordLoginEnabled: true, codeLoginEnabled: true, oauthEnabled: false }));

  app.post('/v1/auth/email/register/code', async (request, reply) => {
    const body = emailSchema.parse(request.body);
    if (await findUser(body.email)) return reply.code(409).send({ message: 'Email already registered' });
    await sendCode(body.email, 'register');
    return { sent: true };
  });

  app.post('/v1/auth/email/register', async (request, reply) => {
    const body = passwordSchema.extend({ code: z.string().length(6) }).parse(request.body);
    if (await findUser(body.email)) return reply.code(409).send({ message: 'Email already registered' });
    if (!await verifyCode(body.email, 'register', body.code)) return reply.code(400).send({ message: 'Invalid verification code' });
    const user = await createUser(body.email, body.password);
    return reply.code(201).send({ user: { id: user.id, email: user.email }, token: app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: '24h' }) });
  });

  app.post('/v1/auth/email/login/code', async (request, reply) => {
    const body = emailSchema.parse(request.body);
    if (!await findUser(body.email)) return reply.code(404).send({ message: 'Account not found' });
    await sendCode(body.email, 'login');
    return { sent: true };
  });

  app.post('/v1/auth/email/login/code/verify', async (request, reply) => {
    const body = emailSchema.extend({ code: z.string().length(6) }).parse(request.body);
    if (!await checkLoginAllowed(body.email)) return reply.code(429).send({ message: 'Too many login attempts' });
    const user = await findUser(body.email);
    if (!user || !await verifyCode(body.email, 'login', body.code)) { await recordLoginResult(body.email, false); return reply.code(401).send({ message: 'Invalid verification code' }); }
    await recordLoginResult(body.email, true);
    return { user: { id: user.id, email: user.email }, token: app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: '24h' }) };
  });

  app.post('/v1/auth/email/login/password', async (request, reply) => {
    const body = passwordSchema.parse(request.body);
    if (!await checkLoginAllowed(body.email)) return reply.code(429).send({ message: 'Too many login attempts' });
    const user = await findUser(body.email);
    if (!user || !await verifyPassword(user, body.password)) { await recordLoginResult(body.email, false); return reply.code(401).send({ message: 'Invalid credentials' }); }
    await recordLoginResult(body.email, true);
    return { user: { id: user.id, email: user.email }, token: app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: '24h' }) };
  });

  app.post('/v1/auth/email/password-reset/code', async (request) => {
    const { email } = emailSchema.parse(request.body);
    if (await findUser(email)) await sendCode(email, 'password_reset');
    return { sent: true };
  });

  app.post('/v1/auth/refresh', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as { sub: string; role?: string };
    return { token: app.jwt.sign({ sub: user.sub, role: user.role }, { expiresIn: '24h' }) };
  });

  app.post('/v1/auth/email/password-reset', async (request, reply) => {
    const { email, code, password } = passwordSchema.extend({ code: z.string().length(6) }).parse(request.body);
    if (!await verifyCode(email, 'password_reset', code)) return reply.code(400).send({ message: 'Invalid verification code' });
    await resetPassword(email, password);
    return { reset: true };
  });
}
