export const GLOSSARY_TERM_LIMIT = 1000;

export function classifyGlossaryImport(text: string, existingSources: string[]) {
  const seen = new Set(existingSources);
  const accepted: Array<{ source: string; target: string }> = [];
  let skippedDuplicate = 0;
  let skippedInvalid = 0;
  let overflow = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    const source = parts[0]?.trim() ?? '';
    const target = parts.slice(1).join('\t').trim();
    if (!source || !target || source.length > 200 || target.length > 200) {
      skippedInvalid += 1;
      continue;
    }
    if (seen.has(source)) {
      skippedDuplicate += 1;
      continue;
    }
    seen.add(source);
    const room = GLOSSARY_TERM_LIMIT - existingSources.length - accepted.length;
    if (room <= 0) {
      overflow += 1;
      continue;
    }
    accepted.push({ source, target });
  }
  return { accepted, skippedDuplicate, skippedInvalid, skippedLimit: overflow };
}
