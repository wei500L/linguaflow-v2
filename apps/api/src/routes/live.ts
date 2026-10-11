import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { transcripts } from '../db/schema.js';
import { audienceViewPhase, ensureAudienceShare, findAudienceSession } from '../lib/audience.js';
import { audienceRoomState, joinAudience } from '../realtime/proxy.js';
import { socketUrl } from '../lib/socket-url.js';

function describe(session: { title: string | null; mode: string; languageA: string; languageB: string | null; targetLanguage: string | null; audienceIncludeAudio: boolean }) {
  return {
    title: session.title?.trim() || '',
    mode: session.mode,
    languageA: session.languageA,
    languageB: session.languageB ?? session.targetLanguage ?? '',
    includeAudio: session.audienceIncludeAudio
  };
}

export async function liveRoutes(app: FastifyInstance) {
  app.get('/v1/live/ws', { websocket: true }, async (socket, request) => {
    const protocols = request.headers['sec-websocket-protocol']?.split(',').map((part) => part.trim()) ?? [];
    const token = protocols[1];
    if (!token) return socket.close(1008, 'Missing audience token');
    const session = await findAudienceSession(token);
    if (!session || session.endedAt || !joinAudience(session.id, socket)) socket.close(1008, 'Audience unavailable');
  });

  app.get('/v1/live/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const session = await findAudienceSession(token);
    if (!session) return reply.code(404).send({ message: '分享链接已失效。' });
    const meta = describe(session);
    const phase = audienceViewPhase({ ended: Boolean(session.endedAt), room: audienceRoomState(session.id) });
    if (phase === 'live') {
      return { phase, ...meta, websocketUrl: socketUrl(request, '/v1/live/ws'), websocketProtocols: ['live.v1', token] };
    }
    if (phase !== 'ended') return { phase, ...meta };
    const [transcript] = await db.select().from(transcripts).where(eq(transcripts.sessionId, session.id)).limit(1);
    if (!transcript || transcript.deletedAt || transcript.recordStatus !== 'complete' || !session.audienceKeepAfter) return { phase: 'ended', ...meta, empty: true };
    await ensureAudienceShare(session, transcript.id);
    return { phase: 'ended', ...meta, empty: false };
  });
}
