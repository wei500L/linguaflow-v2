import { LANGUAGE_OPTIONS, type SessionMode } from '@linguaflow/shared';

const CONTEXT_CHAR_LIMIT = 8000;

export type GlossaryTermInput = { source: string; target: string; pinned?: boolean };

export type GlossaryMeta = {
  languageA: string;
  languageB: string;
  presetKey?: string | null;
};

const PRESET_DOMAINS: Record<string, string> = {
  medical: 'Healthcare',
  legal: 'Legal',
  classroom: 'Education',
  analysis: 'Mathematical analysis',
  algebra: 'Linear algebra',
  discrete: 'Discrete mathematics',
  pascal: 'Pascal programming',
  practice: 'Algorithms',
  history: 'History',
  safety: 'Life safety'
};

export type SonioxSessionInput = {
  id: string;
  mode: string;
  languageA: string;
  languageB: string | null;
  targetLanguage: string | null;
};

export type SonioxContext = {
  general: Array<{ key: string; value: string }>;
  terms?: string[];
  translation_terms?: Array<{ source: string; target: string }>;
};

export type SonioxConfig = {
  api_key: string;
  model: 'stt-rt-v5';
  audio_format: 'pcm_s16le';
  sample_rate: 16000;
  num_channels: 1;
  language_hints: string[];
  language_hints_strict?: true;
  enable_language_identification: true;
  enable_speaker_diarization: true;
  enable_endpoint_detection: true;
  client_reference_id: string;
  translation: { type: 'one_way'; target_language: string } | { type: 'two_way'; language_a: string; language_b: string };
  context: SonioxContext;
};

export function languageCode(value?: string | null) {
  return value?.trim().toLowerCase().split('-')[0] ?? '';
}

export function sessionLanguageConflict(body: { type: SessionMode; languageA: string; languageB?: string | null; targetLanguage?: string | null }) {
  const spoken = languageCode(body.languageA);
  const other = languageCode(body.type === 'one_way' ? body.targetLanguage : body.languageB);
  return Boolean(spoken && other && spoken === other);
}

export function sameLanguageResponse(body: { type: SessionMode; languageA: string; languageB?: string | null; targetLanguage?: string | null }) {
  if (!sessionLanguageConflict(body)) return null;
  return { status: 400 as const, code: 'same_language', message: '源语言和目标语言不能相同。' };
}

function languageLabel(code: string) {
  const match = LANGUAGE_OPTIONS.find((item) => item.code === code);
  return match ? `${match.englishName} (${match.code})` : code;
}

type PackUnit = {
  pinned: boolean;
  order: number;
  label: string;
  pairs: Array<{ source: string; target: string }>;
  spoken: string[];
};

function sessionLanguages(session: SonioxSessionInput) {
  const oneWay = session.mode === 'one_way';
  return { oneWay, source: languageCode(session.languageA), target: languageCode(oneWay ? session.targetLanguage : session.languageB) };
}

function glossaryAlignment(session: SonioxSessionInput, glossary?: GlossaryMeta | null) {
  if (!glossary) return { aligned: true, apply: false, reversed: false };
  const { source, target } = sessionLanguages(session);
  const left = languageCode(glossary.languageA);
  const right = languageCode(glossary.languageB);
  if (!left || !right || left === right || !source || !target) return { aligned: false, apply: false, reversed: false };
  if (left === source && right === target) return { aligned: true, apply: true, reversed: false };
  if (left === target && right === source) return { aligned: true, apply: true, reversed: true };
  return { aligned: false, apply: false, reversed: false };
}

function buildUnits(session: SonioxSessionInput, terms: GlossaryTermInput[], glossary?: GlossaryMeta | null) {
  const { oneWay } = sessionLanguages(session);
  const { aligned, apply, reversed } = glossaryAlignment(session, glossary);
  const bidirectional = apply && !oneWay;
  const ordered = terms.map((term, order) => ({ ...term, order })).sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || left.order - right.order);
  const taken = new Set<string>();
  const units: PackUnit[] = [];
  for (const term of ordered) {
    let source = term.source.trim();
    let target = term.target.trim();
    if (!source || !target) continue;
    if (apply && reversed) [source, target] = [target, source];
    if (taken.has(source)) continue;
    const pairs = [{ source, target }];
    const spoken = [source];
    taken.add(source);
    if (bidirectional && source !== target && !taken.has(target)) {
      pairs.push({ source: target, target: source });
      spoken.push(target);
      taken.add(target);
    }
    units.push({ pinned: Boolean(term.pinned), order: term.order, label: source, pairs, spoken });
  }
  return { units, aligned };
}

function packUnits(general: SonioxContext['general'], units: PackUnit[]) {
  const context: SonioxContext = { general };
  const spoken: string[] = [];
  const pairs: Array<{ source: string; target: string }> = [];
  const seenSpoken = new Set<string>();
  const seenSources = new Set<string>();
  let used = 0;
  let dropped = 0;
  const droppedTerms: string[] = [];
  const ordered = [...units].sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.order - right.order);
  for (const unit of ordered) {
    const nextSpoken = unit.spoken.filter((item) => !seenSpoken.has(item));
    const nextPairs = unit.pairs.filter((pair) => !seenSources.has(pair.source));
    if (!nextPairs.length) continue;
    const candidate: SonioxContext = { general, terms: [...spoken, ...nextSpoken], translation_terms: [...pairs, ...nextPairs] };
    if (JSON.stringify(candidate).length > CONTEXT_CHAR_LIMIT) {
      dropped += 1;
      droppedTerms.push(unit.label);
      continue;
    }
    for (const item of nextSpoken) {
      seenSpoken.add(item);
      spoken.push(item);
    }
    for (const pair of nextPairs) {
      seenSources.add(pair.source);
      pairs.push(pair);
    }
    used += 1;
  }
  if (spoken.length) context.terms = spoken;
  if (pairs.length) context.translation_terms = pairs;
  return { context, used, dropped, droppedTerms };
}

function contextGeneral(session: SonioxSessionInput, glossary?: GlossaryMeta | null) {
  const { oneWay, source, target } = sessionLanguages(session);
  const general: SonioxContext['general'] = [
    { key: 'setting', value: oneWay ? 'lecture or meeting captions' : 'bilingual conversation' },
    {
      key: 'instructions',
      value: oneWay
        ? `The spoken language is ${languageLabel(source)}. Transcribe in ${languageLabel(source)} and translate into ${languageLabel(target)}.`
        : `Speakers use ${languageLabel(source)} and ${languageLabel(target)}. Translate each side into the other language.`
    },
    { key: 'language', value: oneWay ? languageLabel(source) : `${languageLabel(source)} and ${languageLabel(target)}` }
  ];
  const domain = glossary?.presetKey ? PRESET_DOMAINS[glossary.presetKey] : undefined;
  if (domain) general.push({ key: 'domain', value: domain });
  return general;
}

export function glossaryInjection(session: SonioxSessionInput, terms: GlossaryTermInput[], glossary?: GlossaryMeta | null) {
  const { units, aligned } = buildUnits(session, terms, glossary);
  return { ...packUnits(contextGeneral(session, glossary), units), aligned };
}

export function buildSonioxConfig(apiKey: string, session: SonioxSessionInput, terms: GlossaryTermInput[], glossary?: GlossaryMeta | null): SonioxConfig {
  const oneWay = session.mode === 'one_way';
  const source = languageCode(session.languageA);
  const target = languageCode(oneWay ? session.targetLanguage : session.languageB);
  const languageHints = [...new Set(oneWay ? [source] : [source, target])].filter(Boolean);
  const packed = glossaryInjection(session, terms, glossary);
  const config: SonioxConfig = {
    api_key: apiKey,
    model: 'stt-rt-v5',
    audio_format: 'pcm_s16le',
    sample_rate: 16000,
    num_channels: 1,
    language_hints: languageHints,
    enable_language_identification: true,
    enable_speaker_diarization: true,
    // Leave endpoint delay, sensitivity, and latency adjustment at Soniox defaults.
    // Raising them finalizes sooner and lowers word and diarization accuracy.
    enable_endpoint_detection: true,
    client_reference_id: session.id,
    translation: oneWay
      ? { type: 'one_way', target_language: target }
      : { type: 'two_way', language_a: source, language_b: target },
    context: packed.context
  };
  if (oneWay) config.language_hints_strict = true;
  return config;
}
