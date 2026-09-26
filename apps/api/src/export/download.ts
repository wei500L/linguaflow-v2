import type { FastifyReply } from 'fastify';
import { buildMeetingMarkdown, safeDownloadName, type MeetingDocument } from './meeting.js';
import { renderMeetingPdf, resolvePdfFont } from './pdf.js';

const formatTime = (value: number, comma: boolean) => {
  const ms = Math.max(0, value);
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms % 3600000 / 60000);
  const seconds = Math.floor(ms % 60000 / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${comma ? ',' : '.'}${String(ms % 1000).padStart(3, '0')}`;
};

export async function sendTranscriptFile(reply: FastifyReply, doc: MeetingDocument, format: 'txt' | 'srt' | 'vtt' | 'md' | 'pdf', scope: 'summary' | 'full') {
  if (format === 'md' || format === 'pdf') {
    if (format === 'md') {
      reply.header('content-disposition', safeDownloadName(doc.title, 'md'));
      return reply.type('text/markdown; charset=utf-8').send(buildMeetingMarkdown(doc, scope));
    }
    if (scope === 'summary' && !doc.summaryMarkdown?.trim()) return reply.code(409).send({ message: '生成纪要后才能导出仅含纪要的 PDF。' });
    const font = resolvePdfFont();
    if (!font) return reply.code(503).send({ message: 'PDF 字体未安装。' });
    const pdf = await renderMeetingPdf(doc, font, scope);
    reply.header('content-disposition', safeDownloadName(doc.title, 'pdf'));
    return reply.type('application/pdf').send(pdf);
  }
  const body = doc.segments.map((segment, index) => {
    if (format === 'txt') return `${segment.sourceText}\n${segment.translationText}`;
    const start = segment.startMs ?? 0;
    const end = segment.endMs != null && segment.endMs > start ? segment.endMs : start + 2000;
    const range = `${formatTime(start, format === 'srt')} --> ${formatTime(end, format === 'srt')}`;
    return `${format === 'srt' ? `${index + 1}\n` : ''}${range}\n${segment.sourceText}\n${segment.translationText}`;
  }).join('\n\n');
  const type = format === 'txt' ? 'text/plain; charset=utf-8' : format === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8';
  reply.header('content-disposition', safeDownloadName(doc.title, format));
  return reply.type(type).send(format === 'vtt' ? `WEBVTT\n\n${body}` : body);
}
