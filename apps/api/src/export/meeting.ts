import { gapDurationText, isIanaTimeZone, languageRelation, type AudioGap } from '@linguaflow/shared';

export type MeetingSegment = { id?: string; sourceText: string; translationText: string; startMs: number | null; endMs: number | null; speaker?: string | null };
export type MeetingDocument = {
  title: string;
  createdAt: Date;
  startedAt?: Date | null;
  endedAt?: Date | null;
  mode?: string;
  timeZone?: string | null;
  durationMs: number;
  audioDurationMs?: number | null;
  languageA: string;
  languageB: string;
  summaryMarkdown: string | null;
  gaps?: AudioGap[];
  recordStatus?: string | null;
  segments: MeetingSegment[];
};

function formatInstant(date: Date, timeZone: string | null | undefined) {
  if (!timeZone || !isIanaTimeZone(timeZone)) return `${date.toISOString()} UTC`;
  const formatted = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
  return `${formatted} (${timeZone})`;
}

export function formatClock(ms: number | null) {
  if (ms == null || !Number.isFinite(ms)) return '--:--:--';
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

export function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function buildMeetingMarkdown(doc: MeetingDocument, scope: 'summary' | 'full' = 'full') {
  const summary = doc.summaryMarkdown?.trim() || '尚未生成';
  const record = doc.segments.map((segment) => {
    const translation = segment.translationText.trim();
    const source = segment.sourceText.trim();
    const primary = translation || source;
    const extra = translation && source ? `\n  原文：${source}` : '';
    const speaker = segment.speaker ? ` 说话人 ${segment.speaker}` : '';
    return `[${formatClock(segment.startMs)}]${speaker} ${primary}${extra}`;
  }).join('\n\n');
  const gaps = (doc.gaps ?? []).map((gap) => `- ${gap.source === 'user_pause' ? '主动暂停' : '内容缺口'}（${gapDurationText(gap)}）`).join('\n');
  const lines = [
    `# ${doc.title}`,
    '',
    `- 开始：${doc.startedAt ? formatInstant(doc.startedAt, doc.timeZone) : '未知'}`,
    `- 结束：${doc.endedAt ? formatInstant(doc.endedAt, doc.timeZone) : '未知'}`,
    `- 保存：${formatInstant(doc.createdAt, doc.timeZone)}`,
    `- 课堂经过：${formatDuration(doc.durationMs)}`,
    `- 音频时长：${doc.audioDurationMs == null ? '未知' : formatDuration(doc.audioDurationMs)}`,
    `- 语言：${languageRelation(doc.mode ?? 'one_way', doc.languageA, doc.languageB)}`,
    ...(doc.recordStatus === 'incomplete' ? ['- 状态：中断记录'] : []),
    '',
    '## AI 纪要',
    '',
    summary
  ];
  if (gaps) lines.push('', '## 缺口与暂停', '', gaps);
  if (scope === 'full') lines.push('', '## 记录', '', record || '（无记录）');
  return `${lines.join('\n')}\n`;
}

export function safeDownloadName(title: string, ext: string) {
  const cleaned = title.replace(/[\r\n"]/g, '').trim().slice(0, 80) || 'meeting';
  const ascii = cleaned.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'meeting';
  const utf = encodeURIComponent(`${cleaned}.${ext}`);
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${utf}`;
}
