import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { authRoutes } from './auth/routes.js';
import { meRoutes } from './routes/me.js';
import { realtimeRoutes } from './routes/realtime.js';
import { transcriptRoutes } from './routes/transcripts.js';
import { billingRoutes } from './routes/billing.js';
import { adminRoutes } from './routes/admin.js';
import { shareRoutes } from './routes/shares.js';
import { liveRoutes } from './routes/live.js';
import { closeActiveSession, closeActiveSessions, hasLiveRoom } from './realtime/proxy.js';
import { drainRecordingEncodes, resumeRecordingEncodes } from './realtime/encode.js';
import { sweepOrphanRecordings } from './lib/recordings.js';
import { db, sql } from './db/index.js';
import { realtimeSessions, transcripts } from './db/schema.js';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { settleUsage } from './lib/quota.js';
import { bootstrapOwner } from './auth/service.js';
import { markInterruptedSummaries } from './summary/jobs.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const app = Fastify({ logger: true });
await app.register(cors, { origin: config.webOrigin, credentials: false });
await app.register(jwt, { secret: config.jwtSecret });
await app.register(websocket, { options: { perMessageDeflate: false } });
app.decorate('authenticate', async (request, reply) => {
  try { await request.jwtVerify(); } catch { await reply.code(401).send({ message: 'Authentication required' }); }
});

app.get('/health', async () => ({ ok: true, service: 'linguaflow-api' }));
await app.register(authRoutes);
await app.register(meRoutes);
await app.register(realtimeRoutes);
await app.register(transcriptRoutes);
await app.register(billingRoutes);
await app.register(adminRoutes);
await app.register(shareRoutes);
await app.register(liveRoutes);

const cleanupTimer = setInterval(async () => {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  await db.update(realtimeSessions).set({ endedAt: new Date(), endReason: 'expired', status: 'expired' }).where(and(eq(realtimeSessions.status, 'pending'), lt(realtimeSessions.createdAt, cutoff), isNull(realtimeSessions.endedAt)));
  const stale = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.status, 'active'), lt(realtimeSessions.claimedAt, cutoff), isNull(realtimeSessions.endedAt)));
  await Promise.allSettled(stale.map(async (session) => {
    const closed = await closeActiveSession(session.id, 'expired');
    if (!closed) await settleUsage(session.userId, session.id, session.startedAt ? (Date.now() - session.startedAt.getTime()) / 1000 : 0, 'expired');
  }));
  const reconnecting = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.status, 'reconnecting'), lt(realtimeSessions.claimedAt, new Date(Date.now() - 2 * 60 * 1000)), isNull(realtimeSessions.endedAt)));
  await Promise.allSettled(reconnecting.map(async (session) => {
    if (hasLiveRoom(session.id)) return;
    await settleUsage(session.userId, session.id, session.startedAt ? (Date.now() - session.startedAt.getTime()) / 1000 : 0, 'expired');
  }));
  const referenced = await db.select({ audioRelPath: transcripts.audioRelPath }).from(transcripts);
  await sweepOrphanRecordings(referenced.flatMap((row) => row.audioRelPath ? [row.audioRelPath] : []));
}, 5 * 60 * 1000);
cleanupTimer.unref();

app.setErrorHandler((error: any, _request, reply) => {
  app.log.error(error);
  const zod = error?.name === 'ZodError' || Array.isArray(error?.issues);
  const status = zod ? 400 : (error.statusCode ?? 500);
  const message = zod ? 'Check the email and password, then try again' : status === 500 ? 'Internal server error' : error.message;
  return reply.code(status).send({ message });
});

if (config.bootstrapEmail && config.bootstrapPassword) await bootstrapOwner(config.bootstrapEmail, config.bootstrapPassword);
const interrupted = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.status, 'reconnecting'), isNull(realtimeSessions.endedAt)));
await Promise.allSettled(interrupted.map((session) => settleUsage(session.userId, session.id, session.startedAt ? (Date.now() - session.startedAt.getTime()) / 1000 : 0, 'server_restart')));
await markInterruptedSummaries();
await resumeRecordingEncodes();
await app.listen({ port: config.port, host: '0.0.0.0' });

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  clearInterval(cleanupTimer);
  await closeActiveSessions('server_shutdown');
  await drainRecordingEncodes();
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
