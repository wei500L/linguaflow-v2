import { type RefObject } from 'react';
import { tr } from './lib/i18n';

export type Segment = { source: string; translation: string; speaker?: string; language?: string; interim?: boolean };
export type CaptionView = 'both' | 'translation' | 'source';
export type SessionStatus = 'idle' | 'opening' | 'connecting' | 'running' | 'reconnecting' | 'stopping';

export const CAPTION_VIEWS: Array<{ value: CaptionView; label: string }> = [
  { value: 'both', label: '双语' },
  { value: 'translation', label: '译文' },
  { value: 'source', label: '原文' }
];

export const CAPTION_SIZES: Array<{ value: string; label: string }> = [
  { value: 'sm', label: '小' },
  { value: 'md', label: '中' },
  { value: 'lg', label: '大' }
];

export function CaptionToolbar({ view, onView, onCopy, onExport }: { view: CaptionView; onView: (next: CaptionView) => void; onCopy: () => void; onExport: () => void }) {
  return <div className="caption-toolbar">
    <span>{tr('字幕显示')}</span>
    {CAPTION_VIEWS.map((item) => <button key={item.value} type="button" className={view === item.value ? 'active' : ''} onClick={() => onView(item.value)}>{tr(item.label)}</button>)}
    <button type="button" onClick={onCopy}>{tr('复制字幕')}</button>
    <button type="button" onClick={onExport}>{tr('导出文本')}</button>
  </div>;
}

type CaptionStageProps = {
  stageRef: RefObject<HTMLDivElement | null>;
  segments: Segment[];
  visibleCaptions: Segment[];
  hiddenCaptions: number;
  captionSize: string;
  captionView: CaptionView;
  sessionStatus: SessionStatus;
  twoWay: boolean;
  languageB: string;
  speakerNames: Record<string, string>;
  withToolbar: boolean;
  enterClass: (position: number, interim: boolean, total: number) => string;
  onScroll: () => void;
  onShowEarlier: () => void;
  onRenameSpeaker: (speaker: string | null) => void;
};

export function CaptionStage({
  stageRef, segments, visibleCaptions, hiddenCaptions, captionSize, captionView,
  sessionStatus, twoWay, languageB, speakerNames, withToolbar, enterClass, onScroll, onShowEarlier, onRenameSpeaker
}: CaptionStageProps) {
  const empty = segments.length === 0;
  const running = sessionStatus === 'running';
  return <div
    ref={stageRef}
    className={`subtitle-stage caption-${captionSize}${withToolbar ? ' with-toolbar' : ''}`}
    aria-live="polite"
    aria-relevant="additions text"
    onScroll={onScroll}
  >
    {empty && sessionStatus === 'idle' && <div className="empty-state">
      <div className="empty-icon">◌</div>
      <h2>{tr('准备好开始翻译')}</h2>
      <p>{tr('选择语言并点击下方按钮，说话时字幕会实时出现在这里。')}</p>
    </div>}
    {empty && sessionStatus === 'opening' && <div className="listening-indicator" role="status">
      <i />{tr('正在打开麦克风…')}
      <p>{tr('请允许浏览器使用麦克风，允许后即可开始说话。')}</p>
    </div>}
    {empty && sessionStatus === 'connecting' && <div className="listening-indicator" role="status"><i />{tr('正在连接翻译…')}</div>}
    {empty && sessionStatus === 'reconnecting' && <div className="listening-indicator" role="status"><i />{tr('正在恢复…')}</div>}
    {empty && running && <div className="listening-indicator" role="status"><i />{tr('正在聆听')}</div>}

    {!empty && <div className="subtitle-spacer" />}
    {hiddenCaptions > 0 && <button type="button" className="earlier-captions" onClick={onShowEarlier}>{tr('更早的字幕')}</button>}
    {visibleCaptions.map((segment, index) => {
      const position = hiddenCaptions + index;
      const spoken = (segment.language ?? '').toLowerCase().split('-')[0];
      const right = twoWay && Boolean(spoken) && spoken === languageB.toLowerCase().split('-')[0];
      const big = captionView === 'source' ? (segment.source || segment.translation) : (segment.translation || segment.source);
      const small = captionView === 'both' && segment.translation && segment.source ? segment.source : '';
      const speakerName = segment.speaker ? speakerNames[segment.speaker] ?? `${tr('说话人')} ${segment.speaker}` : '';
      const meta = segment.language?.toUpperCase() ?? '';
      const classes = [
        'subtitle-segment',
        twoWay ? 'chat-bubble' : '',
        right ? 'right' : '',
        position === segments.length - 1 ? 'current' : '',
        segment.interim ? 'interim' : ''
      ].filter(Boolean).join(' ') + enterClass(position, Boolean(segment.interim), segments.length);
      return <article className={classes} key={`line-${position}`}>
        {speakerName && <button type="button" className="speaker-label speaker-rename" onClick={() => onRenameSpeaker(segment.speaker ?? null)}>{speakerName}</button>}
        {!speakerName && meta && <span className="speaker-label">{meta}</span>}
        <div className="translation-line">{big || '…'}</div>
        {small && <div className="source-line">{small}</div>}
      </article>;
    })}
  </div>;
}
