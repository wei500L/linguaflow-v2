import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { transcripts } from '../db/schema.js';
import { ensureAudienceShare, findAudienceSession } from '../lib/audience.js';
import { hasLiveRoom, joinAudience } from '../realtime/proxy.js';

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
    if (!session.endedAt && hasLiveRoom(session.id)) {
      const host = request.headers.host ?? 'localhost:3000';
      const protocol = request.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
      return { phase: 'live', ...meta, websocketUrl: `${protocol}://${host}/v1/live/ws`, websocketProtocols: ['live.v1', token] };
    }
    if (!session.endedAt) return { phase: 'waiting', ...meta };
    const [transcript] = await db.select().from(transcripts).where(eq(transcripts.sessionId, session.id)).limit(1);
    if (!transcript) return { phase: 'ended', ...meta, empty: true };
    await ensureAudienceShare(session, transcript.id);
    return { phase: 'ended', ...meta, empty: false };
  });
}
