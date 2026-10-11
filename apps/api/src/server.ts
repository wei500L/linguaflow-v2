import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import { assertProductionReady, config } from './config.js';
import { authRoutes } from './auth/routes.js';
import { meRoutes } from './routes/me.js';
import { realtimeRoutes } from './routes/realtime.js';
import { transcriptRoutes } from './routes/transcripts.js';
import { billingRoutes } from './routes/billing.js';
import { adminRoutes } from './routes/admin.js';
import { shareRoutes } from './routes/shares.js';
import { liveRoutes } from './routes/live.js';
import { courseRoutes } from './routes/courses.js';
import { supportRoutes } from './routes/support.js';
import { purgeExpiredTrash } from './lib/trash.js';
import { EVENT_RETAIN_MS } from '@linguaflow/shared';
import { closeActiveSession, closeActiveSessions, hasLiveRoom, roomHeardRecently } from './realtime/proxy.js';
import { drainRecordingEncodes, resumeRecordingEncodes } from './realtime/encode.js';
import { protectedRecordingPaths, recoverStaleSessions } from './realtime/persist.js';
import { sweepOrphanRecordings } from './lib/recordings.js';
import { db, sql } from './db/index.js';
import { productEvents, realtimeSessions, transcripts } from './db/schema.js';
import { and, asc, eq, gt, isNotNull, isNull, lt } from 'drizzle-orm';
import { replayDueReferrals } from './lib/referral.js';
import { accessStillValid } from './auth/access.js';
import { bootstrapOwner, findUserById } from './auth/service.js';
import { markInterruptedSummaries } from './summary/jobs.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const app = Fastify({ logger: true });
await app.register(cors, { origin: config.webOrigin, credentials: false });
await app.register(jwt, { secret: config.jwtSecret });
await app.register(websocket, { options: { perMessageDeflate: false, maxPayload: 256 * 1024 } });
app.decorate('authenticate', async (request, reply) => {
  try { await request.jwtVerify(); }
  catch { await reply.code(401).send({ message: 'Authentication required' }); return; }
  const claims = request.user as { sub?: string; tv?: number };
  const user = claims.sub ? await findUserById(claims.sub) : undefined;
  const next = accessStillValid(user, claims);
  if (!next) { await reply.code(401).send({ message: 'Authentication required' }); return; }
  request.user = next;
});

app.get('/health', async (_request, reply) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      sql`select 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('health timeout')), 1_500);
        timer.unref();
      })
    ]);
    return { ok: true, service: 'linguaflow-api' };
  } catch (error) {
    app.log.error({ err: error }, 'health check failed');
    return reply.code(503).send({ ok: false, service: 'linguaflow-api' });
  } finally {
    if (timer) clearTimeout(timer);
  }
});
await app.register(authRoutes);
await app.register(meRoutes);
await app.register(realtimeRoutes);
await app.register(transcriptRoutes);
await app.register(billingRoutes);
await app.register(adminRoutes);
await app.register(shareRoutes);
await app.register(liveRoutes);
await app.register(courseRoutes);
await app.register(supportRoutes);

async function referencedRecordingPaths() {
  const paths: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await db.select({ id: transcripts.id, audioRelPath: transcripts.audioRelPath }).from(transcripts)
      .where(cursor ? and(isNotNull(transcripts.audioRelPath), gt(transcripts.id, cursor)) : isNotNull(transcripts.audioRelPath))
      .orderBy(asc(transcripts.id))
      .limit(500);
    for (const row of page) if (row.audioRelPath) paths.push(row.audioRelPath);
    if (page.length < 500) break;
    cursor = page[page.length - 1].id;
  }
  paths.push(...await protectedRecordingPaths());
  return paths;
}

const cleanupTimer = setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    await db.update(realtimeSessions).set({ endedAt: new Date(), endReason: 'expired', status: 'expired' }).where(and(eq(realtimeSessions.status, 'pending'), lt(realtimeSessions.createdAt, cutoff), isNull(realtimeSessions.endedAt)));
    const stale = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.status, 'active'), lt(realtimeSessions.claimedAt, cutoff), isNull(realtimeSessions.endedAt)));
    await Promise.allSettled(stale.map(async (session) => {
      if (roomHeardRecently(session.id) || hasLiveRoom(session.id)) return;
      await closeActiveSession(session.id, 'expired');
    }));
    await recoverStaleSessions(hasLiveRoom);
    await purgeExpiredTrash();
    await db.delete(productEvents).where(lt(productEvents.createdAt, new Date(Date.now() - EVENT_RETAIN_MS)));
    await replayDueReferrals();
    await sweepOrphanRecordings(await referencedRecordingPaths());
  } catch (error) {
    app.log.error({ err: error }, 'cleanup failed');
  }
}, 5 * 60 * 1000);
cleanupTimer.unref();

app.setErrorHandler((error: any, _request, reply) => {
  app.log.error(error);
  const zod = error?.name === 'ZodError' || Array.isArray(error?.issues);
  const status = zod ? 400 : (error.statusCode ?? 500);
  const message = zod ? 'Check the email and password, then try again' : status === 500 ? 'Internal server error' : error.message;
  const code = !zod && status < 500 && typeof error.code === 'string' ? error.code : undefined;
  return reply.code(status).send(code ? { message, code } : { message });
});

if (config.bootstrapEmail && config.bootstrapPassword) await bootstrapOwner(config.bootstrapEmail, config.bootstrapPassword);
await recoverStaleSessions(hasLiveRoom);
await markInterruptedSummaries();
await resumeRecordingEncodes();
assertProductionReady();
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
