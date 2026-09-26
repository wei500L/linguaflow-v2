import { algebraTerms } from './presets/algebra.js';
import { analysisTerms } from './presets/analysis.js';
import { classroomTerms, legalTerms, medicalTerms } from './presets/general.js';
import { discreteTerms } from './presets/discrete.js';
import { historyTerms } from './presets/history.js';
import { pascalTerms } from './presets/pascal.js';
import { practiceTerms } from './presets/practice.js';
import { safetyTerms } from './presets/safety.js';

export const GLOSSARY_PRESET_KEYS = [
  'analysis', 'algebra', 'discrete', 'pascal', 'practice', 'history', 'safety',
  'classroom', 'medical', 'legal'
] as const;

export type GlossaryPresetKey = typeof GLOSSARY_PRESET_KEYS[number];

export type GlossaryPreset = {
  key: GlossaryPresetKey;
  name: string;
  languageA: string;
  languageB: string;
  terms: Array<{ source: string; target: string }>;
};

function preset(key: GlossaryPresetKey, name: string, languageA: string, languageB: string, rows: Array<[string, string]>): GlossaryPreset {
  return { key, name, languageA, languageB, terms: rows.map(([source, target]) => ({ source, target })) };
}

export const GLOSSARY_PRESETS: GlossaryPreset[] = [
  preset('analysis', '数学分析', 'ru', 'zh', analysisTerms),
  preset('algebra', '线性代数', 'ru', 'zh', algebraTerms),
  preset('discrete', '离散数学', 'ru', 'zh', discreteTerms),
  preset('pascal', 'Pascal', 'ru', 'zh', pascalTerms),
  preset('practice', '计算机实践', 'ru', 'zh', practiceTerms),
  preset('history', '历史', 'ru', 'zh', historyTerms),
  preset('safety', '生命安全', 'ru', 'zh', safetyTerms),
  preset('classroom', '课堂', 'ru', 'zh', classroomTerms),
  preset('medical', '医学', 'zh', 'en', medicalTerms),
  preset('legal', '法律', 'zh', 'en', legalTerms)
];

export function findGlossaryPreset(key: string) {
  return GLOSSARY_PRESETS.find((item) => item.key === key) ?? null;
}
