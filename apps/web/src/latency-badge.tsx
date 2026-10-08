import { readoutBand, type LatencyReadout } from './lib/latency';
import { tr } from './lib/i18n';

function formatMs(ms: number | null) {
  if (ms === null) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function LatencyBadge({ readout, paused }: { readout: LatencyReadout; paused: boolean }) {
  if (paused) {
    const label = tr('收音已暂停，暂不测量延迟');
    return <span className="latency-badge pending" role="status" aria-label={label} title={label}>{tr('延迟')} {tr('已暂停')}</span>;
  }
  const { recognition, translation } = readout;
  const label = recognition === null && translation === null
    ? tr('尚未测到字幕延迟')
    : tr('识别延迟 {recognition}，译文延迟 {translation}').replace('{recognition}', formatMs(recognition)).replace('{translation}', formatMs(translation));
  const shown = translation === null
    ? formatMs(recognition)
    : `${tr('识别')} ${formatMs(recognition)} · ${tr('译文')} ${formatMs(translation)}`;
  return <span className={`latency-badge ${readoutBand(readout)}`} role="status" aria-label={label} title={label}>{tr('延迟')} {shown}</span>;
}
