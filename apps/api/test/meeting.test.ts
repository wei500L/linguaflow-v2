import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptionFold, extractActionItems, FORCE_TURN_CHARS, HARD_TURN_CHARS, foldCaptionTurns, ingestCaptionTokens, projectCaptionTurns, splitQuotaCharge, summaryChargeSeconds, type TranscriptToken } from '../../../packages/shared/src/index.ts';
import { audienceIsOpen, audienceReveal, audienceViewPhase } from '../src/lib/audience.ts';
import { classifyGlossaryImport } from '../src/lib/glossary-import.ts';
import { buildMeetingMarkdown, formatClock } from '../src/export/meeting.ts';
import { signAudioPlayback, verifyAudioPlayback } from '../src/lib/playback.ts';
import { wavHeader } from '../src/realtime/recorder.ts';
import { keyHint, encryptSecret, decryptSecret } from '../src/lib/secrets.ts';
import { assessSummaryEndpoint, isDisallowedIp } from '../src/lib/ssrf.ts';
import { buildMergeMessages, buildRequestMessages, chunkEntries, summarize, type SummaryEntry } from '../src/summary/pipeline.ts';
import { GLOSSARY_PRESETS } from '../src/lib/glossary-presets.ts';
import { buildSonioxConfig, glossaryInjection, sameLanguageResponse } from '../src/realtime/soniox.ts';
import { quotaExhaustedMessage, sessionConflictMessage } from '../src/routes/realtime.ts';
import { hashShareToken, shareIsActive } from '../src/lib/shares.ts';

test('caption turns keep one utterance together instead of zipping sentences', () => {
  const turns = foldCaptionTurns([
    { text: '你好。', translation_status: 'original', language: 'zh', speaker: '1', start_ms: 1000, end_ms: 1800 },
    { text: '世界。', translation_status: 'original', language: 'zh', speaker: '1', start_ms: 2000, end_ms: 2600 },
    { text: 'Hello world.', translation_status: 'translation', language: 'en', source_language: 'zh' },
    { text: '<end>' }
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.source, '你好。世界。');
  assert.equal(turns[0]?.translation, 'Hello world.');
  assert.equal(turns[0]?.startMs, 1000);
  assert.equal(turns[0]?.endMs, 2600);
  assert.equal(turns[0]?.speaker, '1');
  assert.equal(turns[0]?.language, 'zh');
  assert.equal(turns[0]?.interim, false);
});

test('caption turns split when the speaker changes and keep interim text open', () => {
  const turns = foldCaptionTurns([
    { text: 'Hi. ', translation_status: 'original', language: 'en', speaker: '1', start_ms: 0, end_ms: 300 },
    { text: 'Hola.', translation_status: 'translation', language: 'es' },
    { text: '<end>' },
    { text: '你好', translation_status: 'original', language: 'zh', speaker: '2', start_ms: 800, end_ms: 1200 }
  ], [
    { text: '。', translation_status: 'original', language: 'zh', speaker: '2' },
    { text: ' Hello.', translation_status: 'translation', language: 'en' }
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.translation, 'Hola.');
  assert.equal(turns[0]?.interim, false);
  assert.equal(turns[1]?.source, '你好。');
  assert.equal(turns[1]?.translation, 'Hello.');
  assert.equal(turns[1]?.language, 'zh');
  assert.equal(turns[1]?.interim, true);
  const flushed = foldCaptionTurns([
    { text: '你好。', translation_status: 'original', language: 'zh', speaker: '2', start_ms: 800, end_ms: 1200 },
    { text: 'Hello.', translation_status: 'translation', language: 'en' }
  ], [], true);
  assert.equal(flushed[0]?.interim, false);
  assert.equal(flushed[0]?.translation, 'Hello.');
});

test('incremental caption folding matches folding the whole token list', () => {
  const batches: TranscriptToken[][] = [
    [
      { text: '你好。', translation_status: 'original', language: 'zh', speaker: '1', start_ms: 1000, end_ms: 1800, is_final: true },
      { text: '世界。', translation_status: 'original', language: 'zh', speaker: '1', start_ms: 2000, end_ms: 2600, is_final: true }
    ],
    [
      { text: 'Hello', translation_status: 'translation', is_final: true },
      { text: ' world.', translation_status: 'translation', is_final: false }
    ],
    [
      { text: ' world.', translation_status: 'translation', is_final: true },
      { text: '<end>', is_final: true },
      { text: 'Next', translation_status: 'original', language: 'en', speaker: '2', is_final: true }
    ]
  ];
  const fold = createCaptionFold();
  const finals: TranscriptToken[] = [];
  for (const batch of batches) {
    const incoming = batch.filter((token) => token.text === '<end>' || token.is_final);
    const interim = batch.filter((token) => token.text !== '<end>' && !token.is_final);
    ingestCaptionTokens(fold, incoming);
    finals.push(...incoming);
    assert.deepEqual(projectCaptionTurns(fold, interim), foldCaptionTurns(finals, interim));
  }
  assert.deepEqual(projectCaptionTurns(fold, [], true), foldCaptionTurns(finals, [], true));
});

const ruSentence = (index: number): TranscriptToken => ({ text: ` ${String(index).padStart(2, '0')}${'а'.repeat(97)}.`, translation_status: 'original', language: 'ru', speaker: '1' });
const zhSentence = (index: number): TranscriptToken => ({ text: `句子${index}。`, translation_status: 'translation', language: 'zh', source_language: 'ru' });

test('long monologue splits at sentence boundaries once the translation catches up', () => {
  const tokens: TranscriptToken[] = [];
  for (let index = 1; index <= 6; index += 1) tokens.push(ruSentence(index), zhSentence(index));
  const turns = foldCaptionTurns(tokens, [], true);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.source, [1, 2, 3].map((index) => ruSentence(index).text.trim()).join(' '));
  assert.equal(turns[0]?.translation, '句子1。句子2。句子3。');
  assert.equal(turns[1]?.source.startsWith('04'), true);
  assert.equal(turns[1]?.translation, '句子4。句子5。句子6。');
});

test('long turn waits while the translation lags behind the source', () => {
  const turns = foldCaptionTurns([
    ruSentence(1), zhSentence(1), ruSentence(2), zhSentence(2), ruSentence(3),
    ruSentence(4), zhSentence(3), zhSentence(4), ruSentence(5)
  ], [], true);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.translation, '句子1。句子2。句子3。句子4。');
  assert.equal(turns[0]?.source.endsWith(ruSentence(4).text.trim()), true);
  assert.equal(turns[1]?.source, ruSentence(5).text.trim());
});

test('late translation tail moves the next sentence opening into the new turn', () => {
  const timed = (token: TranscriptToken, start: number): TranscriptToken => ({ ...token, start_ms: start, end_ms: start + 900 });
  const turns = foldCaptionTurns([
    timed(ruSentence(1), 0), zhSentence(1), timed(ruSentence(2), 1000), zhSentence(2), timed(ruSentence(3), 2000), { ...zhSentence(3), text: '句子' },
    { text: ' Дальше', translation_status: 'original', language: 'ru', speaker: '1', start_ms: 3000, end_ms: 3300 },
    { text: '3。', translation_status: 'translation', language: 'zh', source_language: 'ru' },
    { text: ' значит.', translation_status: 'original', language: 'ru', speaker: '1', start_ms: 3400, end_ms: 3800 },
    zhSentence(4)
  ], [], true);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.translation, '句子1。句子2。句子3。');
  assert.equal(turns[0]?.source.endsWith('.'), true);
  assert.equal(turns[0]?.endMs, 2900);
  assert.equal(turns[1]?.source, 'Дальше значит.');
  assert.equal(turns[1]?.translation, '句子4。');
  assert.equal(turns[1]?.startMs, 3000);
  assert.equal(turns[1]?.endMs, 3800);
});

test('long turn still splits when the translation merges sentences', () => {
  const turns = foldCaptionTurns([
    ruSentence(1), ruSentence(2), { ...zhSentence(1), text: '句子1和2。' }, ruSentence(3), zhSentence(3), ruSentence(4), zhSentence(4)
  ], [], true);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.translation, '句子1和2。句子3。');
  assert.equal(turns[1]?.translation, '句子4。');
});

const ruClause = (index: number, end: string): TranscriptToken => ({ text: ` ${index}${'б'.repeat(118)}${end}`, translation_status: 'original', language: 'ru', speaker: '1' });
const zhClause = (index: number, end: string): TranscriptToken => ({ text: `分句${index}${end}`, translation_status: 'translation', language: 'zh', source_language: 'ru' });

test('a translated comma does not split a turn below the clause limit', () => {
  const turns = foldCaptionTurns([
    ruClause(1, ','), zhClause(1, '，'), ruClause(2, ','), zhClause(2, '，'), ruClause(3, '.')
  ], [], true);
  assert.equal(turns.length, 1);
});

test('a very long sentence splits at the latest translated comma', () => {
  const turns = foldCaptionTurns([
    ruClause(1, ','), zhClause(1, '，'), ruClause(2, ','), zhClause(2, '，'), ruClause(3, ','), zhClause(3, '，'), ruClause(4, '.'), zhClause(4, '。')
  ], [], true);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.source.endsWith(','), true);
  assert.equal(turns[0]?.translation, '分句1，分句2，分句3，');
  assert.equal(turns[1]?.source.startsWith('4'), true);
  assert.equal(turns[1]?.translation, '分句4。');
});

test('an already translated clause is never pushed into the next turn', () => {
  const turns = foldCaptionTurns([
    ruSentence(1), zhSentence(1), ruSentence(2), zhSentence(2), ruSentence(3), ruClause(4, ','), zhSentence(3), zhClause(4, '，'), ruClause(5, ','), zhClause(5, '，'), ruClause(6, '.'), zhClause(6, '。')
  ], [], true);
  for (const turn of turns) assert.deepEqual(clauseIds(turn.translation, /(?:句子|分句)(\d+)/g), clauseIds(turn.source, /(?:^| )0?(\d)/g));
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.translation, '句子1。句子2。句子3。分句4，');
});

test('hard turn limit splits even without a translation', () => {
  const tokens = Array.from({ length: 9 }, (_, index) => ruSentence(index + 1));
  const turns = foldCaptionTurns(tokens, [], true);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.source.length >= HARD_TURN_CHARS, true);
  assert.equal(turns[1]?.source, ruSentence(9).text.trim());
});

test('chinese turns close at shorter lengths than russian ones', () => {
  const zhSource = (index: number): TranscriptToken => ({ text: `第${index}句${'中'.repeat(27)}。`, translation_status: 'original', language: 'zh', speaker: '1' });
  const enSentence = (index: number): TranscriptToken => ({ text: ` Sentence ${index}.`, translation_status: 'translation', language: 'en', source_language: 'zh' });
  const tokens: TranscriptToken[] = [];
  for (let index = 1; index <= 4; index += 1) tokens.push(zhSource(index), enSentence(index));
  const turns = foldCaptionTurns(tokens, [], true);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.translation, 'Sentence 1. Sentence 2. Sentence 3.');
  assert.equal(turns[1]?.translation, 'Sentence 4.');
});

test('unpunctuated speech is force split at a word boundary', () => {
  const tokens: TranscriptToken[] = [];
  for (let index = 0; index < 250; index += 1) tokens.push({ text: ' сло', translation_status: 'original', language: 'ru', speaker: '1' }, { text: 'во', translation_status: 'original', language: 'ru', speaker: '1' });
  const turns = foldCaptionTurns(tokens, [], true);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.source.length >= FORCE_TURN_CHARS, true);
  assert.equal(turns[0]?.source.endsWith('слово'), true);
  assert.equal(turns[1]?.source.startsWith('слово'), true);
  assert.equal(`${turns[0]?.source} ${turns[1]?.source}`.split(' ').length, 250);
});

test('incremental folding matches whole-list folding for long turns', () => {
  const stream: TranscriptToken[] = [];
  for (let index = 1; index <= 7; index += 1) stream.push({ ...ruSentence(index), is_final: true }, { ...zhSentence(index), is_final: index % 2 === 0 });
  const fold = createCaptionFold();
  const finals: TranscriptToken[] = [];
  for (let start = 0; start < stream.length; start += 3) {
    const batch = stream.slice(start, start + 3);
    const incoming = batch.filter((token) => token.is_final);
    const interim = batch.filter((token) => !token.is_final);
    ingestCaptionTokens(fold, incoming);
    finals.push(...incoming);
    assert.deepEqual(projectCaptionTurns(fold, interim), foldCaptionTurns(finals, interim));
  }
  assert.deepEqual(projectCaptionTurns(fold, [], true), foldCaptionTurns(finals, [], true));
});

function lectureStream(seed: number, sentences: number) {
  let state = seed;
  const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  const words = ['закон', 'безопасность', 'гражданской', 'обороне', 'то', 'есть', 'да', 'вот', 'субъектов', 'федерации', 'система', 'власти'];
  const tokens: TranscriptToken[] = [];
  let carry: TranscriptToken[] = [];
  let clauseId = 0;
  let ms = 0;
  for (let sentence = 0; sentence < sentences; sentence += 1) {
    const clauses = 1 + Math.floor(random() * 3);
    for (let part = 0; part < clauses; part += 1) {
      clauseId += 1;
      const last = part === clauses - 1;
      const source: TranscriptToken[] = [{ text: ` c${clauseId}`, translation_status: 'original', language: 'ru', speaker: '1' }];
      const count = 4 + Math.floor(random() * 10);
      for (let index = 0; index < count; index += 1) {
        const word = words[Math.floor(random() * words.length)]!;
        const cut = Math.max(1, Math.floor(word.length / 2));
        source.push({ text: ` ${word.slice(0, cut)}`, translation_status: 'original', language: 'ru', speaker: '1' }, { text: word.slice(cut), translation_status: 'original', language: 'ru', speaker: '1' });
      }
      source.push({ text: last ? (random() < 0.2 ? '?' : '.') : ',', translation_status: 'original', language: 'ru', speaker: '1' });
      for (const token of source) { token.start_ms = ms; token.end_ms = ms + 120; ms += 150; }
      const translation = `译${clauseId}${'内容'.repeat(1 + Math.floor(random() * 4))}${last ? '。' : '，'}`;
      const pieces: TranscriptToken[] = [];
      for (let index = 0; index < translation.length; index += 2) pieces.push({ text: translation.slice(index, index + 2), translation_status: 'translation', language: 'zh', source_language: 'ru' });
      // The tail of the previous translation chunk sometimes finalizes after the first word of the next source chunk.
      tokens.push(source[0]!, ...carry, ...source.slice(1));
      const split = random() < 0.3 ? 1 : pieces.length;
      tokens.push(...pieces.slice(0, split));
      carry = pieces.slice(split);
    }
  }
  tokens.push(...carry);
  return tokens;
}

function clauseIds(text: string, pattern: RegExp) {
  return [...text.matchAll(pattern)].map((match) => Number(match[1]));
}

test('simulated lecture keeps every translation with its own source clauses', () => {
  for (const seed of [1, 7, 42, 2026]) {
    const stream = lectureStream(seed, 60);
    const turns = foldCaptionTurns(stream, [], true);
    assert.equal(turns.length > 5, true, `seed ${seed} produced ${turns.length} turns`);
    const clauseStart = new Map<number, number>();
    const clauseEnd = new Map<number, number>();
    let current = 0;
    for (const token of stream) {
      if (token.translation_status === 'translation') continue;
      const id = /^ c(\d+)$/.exec(token.text)?.[1];
      if (id) { current = Number(id); clauseStart.set(current, token.start_ms!); }
      clauseEnd.set(current, token.end_ms!);
    }
    const allSource: number[] = [];
    const allTranslation: number[] = [];
    for (const turn of turns) {
      assert.equal(turn.source.length < HARD_TURN_CHARS, true, `seed ${seed} turn of ${turn.source.length} chars`);
      const ids = clauseIds(turn.source, /\bc(\d+)\b/g);
      assert.equal(turn.startMs, clauseStart.get(ids[0]!), `seed ${seed} start of turn ${ids[0]}`);
      assert.equal(turn.endMs, clauseEnd.get(ids[ids.length - 1]!), `seed ${seed} end of turn ${ids[0]}`);
      assert.deepEqual(clauseIds(turn.translation, /译(\d+)/g), clauseIds(turn.source, /\bc(\d+)\b/g), `seed ${seed} misaligned turn`);
      allSource.push(...clauseIds(turn.source, /\bc(\d+)\b/g));
      allTranslation.push(...clauseIds(turn.translation, /译(\d+)/g));
    }
    assert.deepEqual(allSource, allTranslation);
    const fold = createCaptionFold();
    const finals: TranscriptToken[] = [];
    let position = 0;
    let step = seed;
    while (position < stream.length) {
      step = (step * 31 + 7) % 97;
      const size = 1 + (step % 9);
      const incoming = stream.slice(position, position + size).map((token) => ({ ...token, is_final: true }));
      const interim = stream.slice(position + size, position + size + (step % 5)).map((token) => ({ ...token, is_final: false }));
      ingestCaptionTokens(fold, incoming);
      finals.push(...incoming);
      position += size;
      assert.deepEqual(projectCaptionTurns(fold, interim), foldCaptionTurns(finals, interim));
    }
  }
});

test('meeting markdown includes a missing summary and timed lines', () => {
  const markdown = buildMeetingMarkdown({
    title: '周会',
    createdAt: new Date('2026-09-26T09:00:00.000Z'),
    durationMs: 125000,
    languageA: 'zh',
    languageB: 'en',
    summaryMarkdown: null,
    segments: [{ sourceText: '你好', translationText: 'Hello', startMs: 65000, endMs: 67000 }]
  });
  assert.match(markdown, /# 周会/);
  assert.match(markdown, /尚未生成/);
  assert.match(markdown, /\[00:01:05\] Hello/);
  const withSpeaker = buildMeetingMarkdown({
    title: '周会', createdAt: new Date('2026-09-26T09:00:00.000Z'), durationMs: 1000, languageA: 'zh', languageB: 'en', summaryMarkdown: '**结论**\n\n```\nE=mc^2\n```',
    segments: [{ sourceText: '你好', translationText: 'Hello', startMs: 1000, endMs: 2000, speaker: '1' }]
  });
  assert.match(withSpeaker, /说话人 1/);
  assert.match(markdown, /原文：你好/);
  assert.equal(formatClock(null), '--:--:--');
});

test('wav header describes 16 kHz mono PCM', () => {
  const header = wavHeader(32000);
  assert.equal(header.subarray(0, 4).toString(), 'RIFF');
  assert.equal(header.readUInt32LE(4), 36 + 32000);
  assert.equal(header.subarray(8, 12).toString(), 'WAVE');
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(header.readUInt32LE(24), 16000);
  assert.equal(header.readUInt16LE(34), 16);
  assert.equal(header.readUInt32LE(40), 32000);
});

test('key hint shows only the last four characters', () => {
  assert.equal(keyHint('sk-live-secret'), 'cret');
  assert.equal(keyHint('short'), '');
  const cipher = encryptSecret('sk-live-secret');
  assert.equal(decryptSecret(cipher), 'sk-live-secret');
  assert.equal(cipher.includes('sk-live-secret'), false);
  assert.equal(decryptSecret('v1.bad'), null);
});

test('summary endpoints reject private and plaintext public hosts', () => {
  assert.equal(assessSummaryEndpoint('http://127.0.0.1:11434/v1', []), null);
  assert.equal(assessSummaryEndpoint('http://localhost:11434/v1', []), null);
  assert.equal(assessSummaryEndpoint('https://api.example.com/v1', ['8.8.8.8']), null);
  assert.equal(assessSummaryEndpoint('http://api.example.com/v1', ['8.8.8.8']), 'https-required');
  assert.equal(assessSummaryEndpoint('https://api.example.com/v1', ['10.1.1.1']), 'blocked');
  assert.equal(assessSummaryEndpoint('https://api.example.com/v1', ['127.0.0.1']), 'blocked');
  assert.equal(assessSummaryEndpoint('https://169.254.169.254/', []), 'blocked');
  assert.equal(assessSummaryEndpoint('not a url', []), 'invalid');
  assert.equal(isDisallowedIp('192.168.1.1'), true);
  assert.equal(isDisallowedIp('172.16.0.1'), true);
  assert.equal(isDisallowedIp('8.8.8.8'), false);
  assert.equal(isDisallowedIp('::ffff:10.0.0.8'), true);
  assert.equal(isDisallowedIp('fe80::1'), true);
  assert.equal(isDisallowedIp('fd00::1'), true);
});

test('long records are chunked and then merged', async () => {
  const entry = (index: number): SummaryEntry => ({ timestamp: `00:0${index}:00`, original: '原', translation: '译'.repeat(4000) });
  const entries = [entry(1), entry(2)];
  assert.equal(chunkEntries(entries, 6000).length, 2);
  const calls: string[] = [];
  const controller = new AbortController();
  const text = await summarize(entries, {
    template: 'meeting',
    outputLanguage: '中文',
    maxChars: 6000,
    chat: async (messages) => {
      calls.push(messages[0]?.content ?? '');
      if (calls.length === 1) controller.abort();
      return `部分 ${calls.length}`;
    },
    signal: controller.signal
  }).catch((error: Error) => error.message);
  assert.equal(text, '纪要已取消。');
  assert.equal(calls.length, 1);

  const merged = await summarize(entries, {
    template: 'classroom',
    outputLanguage: 'English',
    maxChars: 6000,
    chat: async (messages) => messages[0]?.content.includes('合并') ? '最终笔记' : '提取'
  });
  assert.equal(merged, '最终笔记');
  const single = buildRequestMessages([{ timestamp: '00:00:01', original: '甲', translation: 'A' }], 'meeting', '中文');
  assert.match(single[0]?.content ?? '', /会议概述/);
  assert.match(single[1]?.content ?? '', /\[00:00:01\] A/);
  const merge = buildMergeMessages(['甲', '乙'], 'meeting', '中文', '00:00:01 – 00:10:00');
  assert.match(merge[1]?.content ?? '', /第 1 部分/);
  assert.match(merge[1]?.content ?? '', /第 2 部分/);
});

test('one-way soniox config hints only the spoken language', () => {
  const config = buildSonioxConfig({ id: 'session-1', mode: 'one_way', languageA: 'zh', languageB: null, targetLanguage: 'en' }, []);
  assert.equal(Object.hasOwn(config, 'api_key'), false);
  assert.deepEqual(config.language_hints, ['zh']);
  assert.equal(config.language_hints_strict, true);
  assert.deepEqual(config.translation, { type: 'one_way', target_language: 'en' });
  assert.equal(config.client_reference_id, 'session-1');
  assert.equal(config.context.terms, undefined);
  assert.equal(config.context.translation_terms, undefined);
  assert.equal(config.context.general[0]?.value, 'lecture or meeting captions');
  assert.match(config.context.general[1]?.value ?? '', /Chinese \(zh\)/);
  assert.match(config.context.general[1]?.value ?? '', /English \(en\)/);
});

test('two-way soniox config hints both spoken languages without strict mode', () => {
  const config = buildSonioxConfig({ id: 'session-2', mode: 'two_way', languageA: 'RU', languageB: 'zh-CN', targetLanguage: null }, [
    { source: '  МГУ  ', target: '莫斯科大学' },
    { source: 'МГУ', target: '另一译法' },
    { source: ' ', target: '空白' }
  ]);
  assert.deepEqual(config.language_hints, ['ru', 'zh']);
  assert.equal(Object.hasOwn(config, 'language_hints_strict'), false);
  assert.deepEqual(config.translation, { type: 'two_way', language_a: 'ru', language_b: 'zh' });
  assert.deepEqual(config.context.terms, ['МГУ']);
  assert.deepEqual(config.context.translation_terms, [{ source: 'МГУ', target: '莫斯科大学' }]);
});

test('soniox context drops terms that would exceed the character budget', () => {
  const terms = Array.from({ length: 40 }, (_, index) => ({ source: `term-${index}-${'x'.repeat(400)}`, target: `译-${index}-${'y'.repeat(400)}` }));
  const config = buildSonioxConfig({ id: 'session-3', mode: 'one_way', languageA: 'en', languageB: null, targetLanguage: 'es' }, terms);
  assert.ok((config.context.terms?.length ?? 0) > 0);
  assert.ok((config.context.terms?.length ?? 0) < terms.length);
  assert.equal(JSON.stringify(config.context).length <= 8000, true);
  assert.equal(config.context.terms?.[0]?.startsWith('term-0-'), true);
  const fit = glossaryInjection({ id: 'session-3', mode: 'one_way', languageA: 'en', languageB: null, targetLanguage: 'es' }, terms);
  assert.equal(fit.used, config.context.terms?.length);
  assert.equal(fit.dropped, terms.length - fit.used);
  assert.ok(fit.dropped > 0);
});

test('two-way glossary sends both directions and does not repeat an unchanged name', () => {
  const fit = glossaryInjection(
    { id: 'session-4', mode: 'two_way', languageA: 'zh', languageB: 'en', targetLanguage: null },
    [{ source: '高血压', target: 'hypertension' }, { source: "St John's", target: "St John's" }],
    { languageA: 'zh', languageB: 'en', presetKey: 'medical' }
  );
  assert.equal(fit.aligned, true);
  assert.deepEqual(fit.context.translation_terms, [
    { source: '高血压', target: 'hypertension' },
    { source: 'hypertension', target: '高血压' },
    { source: "St John's", target: "St John's" }
  ]);
  assert.deepEqual(fit.context.terms, ['高血压', 'hypertension', "St John's"]);
  assert.equal(fit.context.general.find((item) => item.key === 'domain')?.value, 'Healthcare');
  assert.match(fit.context.general.find((item) => item.key === 'language')?.value ?? '', /Chinese \(zh\)/);
});

test('one-way glossary flips when the stored direction is reversed', () => {
  const fit = glossaryInjection(
    { id: 'session-5', mode: 'one_way', languageA: 'en', languageB: null, targetLanguage: 'zh-CN' },
    [{ source: '高血压', target: 'hypertension' }],
    { languageA: 'zh', languageB: 'en' }
  );
  assert.equal(fit.aligned, true);
  assert.deepEqual(fit.context.terms, ['hypertension']);
  assert.deepEqual(fit.context.translation_terms, [{ source: 'hypertension', target: '高血压' }]);
  assert.equal(fit.context.general.some((item) => item.key === 'domain'), false);
});

test('mismatched glossary languages stay stored and report unaligned', () => {
  const fit = glossaryInjection(
    { id: 'session-6', mode: 'two_way', languageA: 'ru', languageB: 'en', targetLanguage: null },
    [{ source: '高血压', target: 'hypertension' }],
    { languageA: 'zh', languageB: 'en' }
  );
  assert.equal(fit.aligned, false);
  assert.deepEqual(fit.context.terms, ['高血压']);
  assert.deepEqual(fit.context.translation_terms, [{ source: '高血压', target: 'hypertension' }]);
});

test('pinned glossary source wins and is packed before larger terms', () => {
  const bulky = Array.from({ length: 12 }, (_, index) => ({ source: `term-${index}-${'x'.repeat(500)}`, target: `译-${index}-${'y'.repeat(500)}` }));
  const fit = glossaryInjection(
    { id: 'session-7', mode: 'one_way', languageA: 'en', languageB: null, targetLanguage: 'zh' },
    [{ source: 'MRI', target: '核磁共振' }, { source: 'MRI', target: '磁共振', pinned: true }, ...bulky],
    { languageA: 'en', languageB: 'zh' }
  );
  assert.equal(fit.context.terms?.[0], 'MRI');
  assert.deepEqual(fit.context.translation_terms?.[0], { source: 'MRI', target: '磁共振' });
  assert.ok(fit.dropped > 0);
  assert.equal(JSON.stringify(fit.context).length <= 8000, true);
});

test('course glossaries stay russian to chinese and add a subject domain', () => {
  const seen = new Map<string, string>();
  for (const key of ['analysis', 'algebra', 'discrete', 'pascal', 'practice', 'history', 'safety'] as const) {
    const preset = GLOSSARY_PRESETS.find((item) => item.key === key);
    assert.ok(preset);
    assert.equal(preset.languageA, 'ru');
    assert.equal(preset.languageB, 'zh');
    assert.ok(preset.terms.length >= 16);
    assert.equal(new Set(preset.terms.map((term) => term.source)).size, preset.terms.length);
    assert.ok(preset.terms.every((term) => term.source.trim() && term.target.trim()));
    for (const term of preset.terms) {
      assert.equal(seen.has(term.source), false, `${term.source} is already in ${seen.get(term.source)}`);
      seen.set(term.source, key);
    }
  }
  const fit = glossaryInjection(
    { id: 'session-course', mode: 'one_way', languageA: 'ru', languageB: null, targetLanguage: 'zh' },
    GLOSSARY_PRESETS.find((item) => item.key === 'algebra')?.terms ?? [],
    { languageA: 'ru', languageB: 'zh', presetKey: 'algebra' }
  );
  assert.equal(fit.aligned, true);
  assert.equal(fit.context.general.find((item) => item.key === 'domain')?.value, 'Linear algebra');
  assert.equal(fit.context.translation_terms?.some((term) => term.source === 'метод Гаусса' && term.target === '高斯消元法'), true);
});

test('a two-way glossary entry is omitted entirely when both directions do not fit', () => {
  const huge = { source: 'A'.repeat(3500), target: 'B'.repeat(3500), pinned: true };
  const fit = glossaryInjection(
    { id: 'session-8', mode: 'two_way', languageA: 'en', languageB: 'es', targetLanguage: null },
    [huge, { source: 'MRI', target: 'RM' }],
    { languageA: 'en', languageB: 'es' }
  );
  assert.equal(fit.dropped, 1);
  assert.deepEqual(fit.droppedTerms, [huge.source]);
  assert.deepEqual(fit.context.translation_terms, [
    { source: 'MRI', target: 'RM' },
    { source: 'RM', target: 'MRI' }
  ]);
  assert.deepEqual(fit.context.terms, ['MRI', 'RM']);
});

test('platform summary charges at least one minute and skips unlimited plans', () => {
  assert.equal(summaryChargeSeconds(0, false), 0);
  assert.equal(summaryChargeSeconds(10, false), 60);
  assert.equal(summaryChargeSeconds(2001, false), 120);
  assert.equal(summaryChargeSeconds(9000, true), 0);
  assert.deepEqual(splitQuotaCharge(180, 100, 50), { planSeconds: 100, addonSeconds: 50, covered: false });
  assert.deepEqual(splitQuotaCharge(90, 100, 50), { planSeconds: 90, addonSeconds: 0, covered: true });
});

test('session conflict and share tokens keep a stable contract', () => {
  assert.match(sessionConflictMessage, /占用额度/);
  assert.match(quotaExhaustedMessage, /额度已用完/);
  const token = 'share-token';
  assert.equal(hashShareToken(token), hashShareToken(token));
  assert.notEqual(hashShareToken(token), hashShareToken('other-token'));
  assert.equal(hashShareToken(token).length, 64);
});

test('same language pairs are rejected before a soniox session starts', () => {
  const same = sameLanguageResponse({ type: 'two_way', languageA: 'zh', languageB: 'ZH' });
  assert.equal(same?.status, 400);
  assert.equal(same?.code, 'same_language');
  assert.equal(same?.message, '源语言和目标语言不能相同。');
  assert.equal(sameLanguageResponse({ type: 'one_way', languageA: 'zh-CN', targetLanguage: 'zh' })?.status, 400);
  assert.equal(sameLanguageResponse({ type: 'one_way', languageA: 'ru', targetLanguage: 'zh' }), null);
  assert.equal(sameLanguageResponse({ type: 'two_way', languageA: 'en', languageB: 'es' }), null);
});

test('share links close after revocation or expiry', () => {
  const now = new Date('2026-09-26T12:00:00.000Z');
  assert.equal(shareIsActive({ revokedAt: null, expiresAt: null }, now), true);
  assert.equal(shareIsActive({ revokedAt: now, expiresAt: null }, now), false);
  assert.equal(shareIsActive({ revokedAt: null, expiresAt: new Date('2026-09-26T12:00:00.000Z') }, now), false);
  assert.equal(shareIsActive({ revokedAt: null, expiresAt: new Date('2026-09-27T12:00:00.000Z') }, now), true);
});

test('audience page waits out the save gap before saying nothing was saved', () => {
  assert.equal(audienceViewPhase({ ended: false, room: 'live' }), 'live');
  assert.equal(audienceViewPhase({ ended: false, room: 'saving' }), 'saving');
  assert.equal(audienceViewPhase({ ended: true, room: 'saving' }), 'saving');
  assert.equal(audienceViewPhase({ ended: true, room: 'live' }), 'saving');
  assert.equal(audienceViewPhase({ ended: false, room: null }), 'waiting');
  assert.equal(audienceViewPhase({ ended: true, room: null }), 'ended');
});

test('audience links close after revocation or expiry', () => {
  const now = new Date('2026-09-26T12:00:00.000Z');
  const open = { audienceToken: 'token', audienceTokenHash: 'hash', audienceIncludeAudio: false, audienceRevokedAt: null, audienceExpiresAt: null };
  assert.equal(audienceIsOpen(open, now), true);
  assert.equal(audienceIsOpen({ ...open, audienceToken: null }, now), true);
  assert.equal(audienceIsOpen({ ...open, audienceTokenHash: null }, now), false);
  assert.equal(audienceIsOpen({ ...open, audienceRevokedAt: now }, now), false);
  assert.equal(audienceIsOpen({ ...open, audienceExpiresAt: now }, now), false);
  assert.equal(audienceIsOpen({ ...open, audienceExpiresAt: new Date('2026-09-27T12:00:00.000Z') }, now), true);
  assert.equal(audienceReveal(open)?.token, 'token');
  assert.equal(audienceReveal({ ...open, audienceToken: null })?.token, null);
  assert.equal(audienceReveal({ ...open, audienceRevokedAt: now }), null);
});

test('glossary import explains duplicates, bad lines, and the 200 term cap', () => {
  const result = classifyGlossaryImport('已有\t旧译\n新词\t新译\n坏行\n超长\t' + 'x'.repeat(201) + '\n另一个\t译法', ['已有']);
  assert.deepEqual(result.accepted, [{ source: '新词', target: '新译' }, { source: '另一个', target: '译法' }]);
  assert.equal(result.skippedDuplicate, 1);
  assert.equal(result.skippedInvalid, 2);
  const capped = classifyGlossaryImport(['甲\t乙', '丙\t丁'].join('\n'), Array.from({ length: 999 }, (_, index) => `已有${index}`));
  assert.equal(capped.accepted.length, 1);
  assert.equal(capped.skippedLimit, 1);
});

test('summary task lines can be copied from the action sections', () => {
  const items = extractActionItems('## 核心内容\n- 不是待办\n## 待办事项\n- 周五发布\n- [ ] 确认日期\n## 决策事项\n- 不做\n## Homework\n- Read chapter 2');
  assert.deepEqual(items, ['周五发布', '确认日期', 'Read chapter 2']);
});

test('audio playback tokens expire and stay bound to one transcript', () => {
  const token = signAudioPlayback('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 1_000);
  assert.equal(verifyAudioPlayback(token, '11111111-1111-1111-1111-111111111111', 1_000 + 1000), '22222222-2222-2222-2222-222222222222');
  assert.equal(verifyAudioPlayback(token, '33333333-3333-3333-3333-333333333333', 1_000 + 1000), null);
  assert.equal(verifyAudioPlayback(token, '11111111-1111-1111-1111-111111111111', 1_000 + 31 * 60 * 1000), null);
});
