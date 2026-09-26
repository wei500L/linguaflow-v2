export type MeetingSegment = { sourceText: string; translationText: string; startMs: number | null; endMs: number | null; speaker?: string | null };
export type MeetingDocument = {
  title: string;
  createdAt: Date;
  durationMs: number;
  languageA: string;
  languageB: string;
  summaryMarkdown: string | null;
  segments: MeetingSegment[];
};

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
  const lines = [
    `# ${doc.title}`,
    '',
    `- 开始：${doc.createdAt.toISOString()}`,
    `- 时长：${formatDuration(doc.durationMs)}`,
    `- 语言：${doc.languageA} → ${doc.languageB}`,
    '',
    '## AI 纪要',
    '',
    summary
  ];
  if (scope === 'full') lines.push('', '## 记录', '', record || '（无记录）');
  return `${lines.join('\n')}\n`;
}

export function safeDownloadName(title: string, ext: string) {
  const cleaned = title.replace(/[\r\n"]/g, '').trim().slice(0, 80) || 'meeting';
  const ascii = cleaned.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'meeting';
  const utf = encodeURIComponent(`${cleaned}.${ext}`);
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${utf}`;
}
