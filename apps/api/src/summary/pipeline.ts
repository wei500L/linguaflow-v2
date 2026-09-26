export const SUMMARY_TEMPLATES = ['meeting', 'classroom', 'interview', 'briefing'] as const;
export type SummaryTemplate = (typeof SUMMARY_TEMPLATES)[number];
export type SummaryEntry = { timestamp: string; original: string; translation: string };
export type ChatMessage = { role: 'system' | 'user'; content: string };

const TEMPLATES: Record<SummaryTemplate, string> = {
  meeting: '你是专业的会议纪要撰写人。根据提供的会议记录，用{lang}输出一份结构化 Markdown 纪要，必须包含以下小节（没有内容的小节写「无」）：\n## 会议概述\n## 核心内容\n## 重要结论\n## 决策事项\n## 待办事项\n## 待确认问题\n规则：\n- 保留重要的数字、金额、日期、人名、机构名、链接和承诺时间点，原样引用，不要改写。\n- 合并重复内容；按主题组织，不按发言顺序罗列。\n- 待办事项如有明确负责人或期限，单独一行写出。\n- 不要编造记录中没有的信息。记录含错字时按最可能的意图理解，不标注错误。\n- 只输出纪要本身，不要前言、后记或解释。',
  classroom: '你是认真的课堂笔记整理者。根据提供的课堂记录，用{lang}输出一份结构化 Markdown 笔记，必须包含以下小节（没有内容的小节写「无」）：\n## 课程主题\n## 知识点\n## 重要定义或公式\n## 教师强调内容\n## 作业与截止时间\n## 需要复习的问题\n规则：\n- 公式用 Markdown 代码块或行内代码原样保留，符号不改写。\n- 保留术语的原文形式（如首次出现时附原语言写法）。\n- 作业、考试、截止时间单独列出，保留原始日期表述。\n- 按知识结构组织，不按时间顺序罗列发言。\n- 不要编造课程中没有的内容。\n- 只输出笔记本身，不要前言、后记或解释。',
  interview: '你是访谈整理人。根据提供的访谈记录，用{lang}输出一份结构化 Markdown 纪要，必须包含以下小节（没有内容的小节写「无」）：\n## 访谈对象与场合\n## 核心观点\n## 关键原话\n## 事实与数字\n## 待办事项\n## 尚未回答的问题\n规则：\n- 关键原话尽量保留原意，可缩短但不能编造。\n- 数字、日期、人名原样保留。\n- 只输出纪要本身。',
  briefing: '你是简报撰写人。根据提供的记录，用{lang}输出一份短简报，必须包含以下小节（没有内容的小节写「无」）：\n## 一句话结论\n## 现在需要知道的事\n## 决定\n## 待办事项\n## 风险\n规则：\n- 每节不超过五条。\n- 数字、日期、人名原样保留。\n- 只输出简报本身。'
};

const CHUNK_PROMPT = '你是会议记录分析员。下面是一场{kind}记录的第 {index}/{total} 部分（时间区间 {span}）。用{lang}提取这一部分的关键信息，输出条目式 Markdown：\n- 保留所有数字、日期、金额、人名、决定和待办事项，原样引用。\n- 保留带时间点的关键发言（标注 [HH:MM:SS]）。\n- 忽略寒暄、重复和无实质内容的片段。\n- 只输出提取结果，不要解释你在做什么。';

const MERGE_PROMPT = '你是会议纪要撰写人。以下是对同一场{kind}（{span}，共 {total} 部分）分段提取的关键信息。合并成一份最终{lang}纪要：\n- 去除各部分之间重复的内容，合并同一话题。\n- 任何在任一部分出现的数字、日期、人名、决定、待办事项都必须保留。\n- 输出结构遵循给定的纪要模板。\n- 只输出纪要本身。';

const KIND: Record<SummaryTemplate, string> = { meeting: '会议', classroom: '课堂', interview: '访谈', briefing: '简报' };

function fill(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce((text, [key, value]) => text.split(`{${key}}`).join(value), template);
}

export class SummaryError extends Error {
  constructor(readonly kind: 'empty' | 'timeout' | 'auth' | 'unreachable' | 'endpoint' | 'api' | 'cancelled', message: string) {
    super(message);
  }
}

export function entriesToText(entries: SummaryEntry[]) {
  return entries.map((entry) => {
    const body = (entry.translation || entry.original).trim();
    return body ? `[${entry.timestamp}] ${body}` : '';
  }).filter(Boolean).join('\n');
}

export function chunkEntries(entries: SummaryEntry[], maxChars = 6000) {
  const chunks: SummaryEntry[][] = [];
  let current: SummaryEntry[] = [];
  let size = 0;
  for (const entry of entries) {
    const length = entriesToText([entry]).length + 1;
    if (current.length && size + length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function span(entries: SummaryEntry[]) {
  if (!entries.length) return '-';
  const first = entries[0]?.timestamp || '-';
  const last = entries[entries.length - 1]?.timestamp || '-';
  return first === last ? first : `${first} – ${last}`;
}

export function buildRequestMessages(entries: SummaryEntry[], template: SummaryTemplate, outputLanguage: string, chunk?: { index: number; total: number }) {
  if (!chunk) {
    return [
      { role: 'system' as const, content: fill(TEMPLATES[template], { lang: outputLanguage }) },
      { role: 'user' as const, content: `以下是完整会议记录：\n\n${entriesToText(entries)}` }
    ];
  }
  return [
    { role: 'system' as const, content: fill(CHUNK_PROMPT, { kind: KIND[template], index: String(chunk.index), total: String(chunk.total), span: span(entries), lang: outputLanguage }) },
    { role: 'user' as const, content: entriesToText(entries) }
  ];
}

export function buildMergeMessages(parts: string[], template: SummaryTemplate, outputLanguage: string, spanAll: string) {
  const joined = parts.map((text, index) => `### 第 ${index + 1} 部分\n\n${text}`).join('\n\n---\n\n');
  const system = fill(MERGE_PROMPT, { kind: KIND[template], span: spanAll, total: String(parts.length), lang: outputLanguage });
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: `${fill(TEMPLATES[template], { lang: outputLanguage })}\n\n分段提取结果：\n\n${joined}` }
  ];
}

function joinedChars(parts: string[]) {
  return parts.reduce((sum, part) => sum + part.length + 24, 0);
}

function groupForMerge(parts: string[], maxChars: number) {
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const part of parts) {
    const length = part.length + 24;
    if (current.length && size + length > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(part);
    size += length;
  }
  if (current.length) groups.push(current);
  return groups;
}

async function ensureActive(signal?: AbortSignal, shouldStop?: () => Promise<boolean> | boolean) {
  if (signal?.aborted || (shouldStop && await shouldStop())) throw new SummaryError('cancelled', '纪要已取消。');
}

export async function summarize(entries: SummaryEntry[], options: {
  template: SummaryTemplate;
  outputLanguage: string;
  chat: (messages: ChatMessage[], signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  shouldStop?: () => Promise<boolean> | boolean;
  maxChars?: number;
}) {
  const maxChars = options.maxChars ?? 6000;
  const usable = entries.filter((entry) => entry.original.trim() || entry.translation.trim());
  if (!usable.length) throw new SummaryError('empty', '这条记录没有可总结的文本。');
  await ensureActive(options.signal, options.shouldStop);
  const template = options.template === 'classroom' ? 'classroom' : 'meeting';
  const chunks = chunkEntries(usable, maxChars);
  if (chunks.length <= 1) {
    const result = (await options.chat(buildRequestMessages(usable, template, options.outputLanguage), options.signal)).trim();
    if (!result) throw new SummaryError('empty', '总结服务没有返回内容。');
    return result;
  }
  const extracted: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    await ensureActive(options.signal, options.shouldStop);
    const chunk = chunks[index] ?? [];
    const text = (await options.chat(buildRequestMessages(chunk, template, options.outputLanguage, { index: index + 1, total: chunks.length }), options.signal)).trim();
    if (!text) throw new SummaryError('empty', '总结服务没有返回内容。');
    extracted.push(text);
  }
  let parts = extracted;
  while (joinedChars(parts) > maxChars && parts.length > 1) {
    await ensureActive(options.signal, options.shouldStop);
    const groups = groupForMerge(parts, maxChars);
    if (groups.length >= parts.length) break;
    const merged: string[] = [];
    for (const group of groups) {
      await ensureActive(options.signal, options.shouldStop);
      const text = (await options.chat(buildMergeMessages(group, template, options.outputLanguage, span(usable)), options.signal)).trim();
      if (!text) throw new SummaryError('empty', '总结服务没有返回内容。');
      merged.push(text);
    }
    if (merged.length >= parts.length) break;
    parts = merged;
  }
  await ensureActive(options.signal, options.shouldStop);
  const result = (await options.chat(buildMergeMessages(parts, template, options.outputLanguage, span(usable)), options.signal)).trim();
  if (!result) throw new SummaryError('empty', '总结服务没有返回内容。');
  return result;
}
