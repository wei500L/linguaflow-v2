import { useEffect, useRef, type ReactNode } from 'react';
import { LANGUAGE_OPTIONS } from '@linguaflow/shared';
import { AudienceLink } from './audience-link';
import { CAPTION_SIZES, CAPTION_VIEWS, CaptionToolbar, type CaptionView, type SessionStatus } from './caption-stage';
import { glossaryOptionLabel } from './lib/glossary';
import { tr } from './lib/i18n';
import { PauseIcon, PlayIcon, RecordIcon, StopIcon } from './icons';
import type { AudioSource } from './lib/audio';

type LanguageOption = { code: string; nativeName: string; englishName: string };
type GlossaryChoice = { id: string; name: string; languageA: string; languageB: string };

function LanguageSelect({ label, value, options, onChange, disabled }: { label: string; value: string; options: LanguageOption[]; onChange: (value: string) => void; disabled?: boolean }) {
  const list = options.length ? options : LANGUAGE_OPTIONS;
  return <label className="select-field">
    <span>{label}</span>
    <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
      {list.map((option) => <option value={option.code} key={option.code}>{option.nativeName} · {option.code.toUpperCase()}</option>)}
    </select>
  </label>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="dock-section"><h3 className="dock-section-title">{title}</h3>{children}</section>;
}

/* A small popover for the two things people actually reach for mid-session. */
function CaptionPopover({ view, size, onView, onSize, onCopy, onExport, onClose }: {
  view: CaptionView; size: string;
  onView: (next: CaptionView) => void; onSize: (next: string) => void;
  onCopy: () => void; onExport: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.parentElement?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);
  return <div className="caption-popover" ref={ref} role="dialog" aria-label={tr('字幕显示')}>
    <div className="caption-popover-group">
      <span>{tr('字幕显示')}</span>
      <div className="segmented">
        {CAPTION_VIEWS.map((item) => <button key={item.value} type="button" className={view === item.value ? 'active' : ''} onClick={() => onView(item.value)}>{tr(item.label)}</button>)}
      </div>
    </div>
    <div className="caption-popover-group">
      <span>{tr('字号')}</span>
      <div className="segmented">
        {CAPTION_SIZES.map((item) => <button key={item.value} type="button" className={size === item.value ? 'active' : ''} onClick={() => onSize(item.value)}>{tr(item.label)}</button>)}
      </div>
    </div>
    <div className="list-item-actions">
      <button type="button" className="secondary-button" onClick={onCopy}>{tr('复制字幕')}</button>
      <button type="button" className="secondary-button" onClick={onExport}>{tr('导出文本')}</button>
    </div>
  </div>;
}

export type ControlDockProps = {
  phone: boolean;
  sessionStatus: SessionStatus;
  busySession: boolean;
  running: boolean;
  paused: boolean;
  closePrompt: boolean;
  dockOpen: boolean;
  captionOpen: boolean;
  mode: 'one_way' | 'two_way';
  languages: LanguageOption[];
  languageA: string;
  languageB: string;
  sameLanguage: boolean;
  glossaryId: string;
  glossaryChoices: GlossaryChoice[];
  glossaryHint: ReactNode;
  audioSource: AudioSource;
  mics: Array<{ id: string; label: string }>;
  micId: string;
  recordAudio: boolean;
  voiceBoost: boolean;
  sessionTitle: string;
  liveSessionId: string | null;
  captionView: CaptionView;
  captionSize: string;
  fullscreen: boolean;
  directionLabel: string;
  remainingLabel: string;
  timeWarning: boolean;
  hasCaptions: boolean;
  planLabel: string;
  rejoin: boolean;
  onDockOpen: (open: boolean) => void;
  onCaptionOpen: (open: boolean) => void;
  onMode: (mode: 'one_way' | 'two_way') => void;
  onLanguageA: (value: string) => void;
  onLanguageB: (value: string) => void;
  onGlossary: (value: string) => void;
  onAudioSource: (value: AudioSource) => void;
  onMic: (value: string) => void;
  onRecordAudio: (value: boolean) => void;
  onVoiceBoost: (value: boolean) => void;
  onSessionTitle: (value: string) => void;
  onCaptionView: (value: CaptionView) => void;
  onCaptionSize: (value: string) => void;
  onFullscreen: () => void;
  onPause: () => void;
  onCancel: () => void;
  onPrimary: () => void;
  onCopy: () => void;
  onExport: () => void;
};

export function ControlDock(props: ControlDockProps) {
  const {
    phone, sessionStatus, busySession, running, paused, closePrompt, dockOpen, captionOpen,
    mode, languages, languageA, languageB, sameLanguage, glossaryId, glossaryChoices, glossaryHint,
    audioSource, mics, micId, recordAudio, voiceBoost, sessionTitle, liveSessionId,
    captionView, captionSize, fullscreen, directionLabel, remainingLabel, timeWarning, hasCaptions, planLabel, rejoin
  } = props;

  const primaryLabel = sessionStatus === 'opening' ? tr('正在打开麦克风…')
    : sessionStatus === 'connecting' ? tr('连接中…')
    : sessionStatus === 'reconnecting' ? tr('正在恢复…')
    : sessionStatus === 'stopping' || sessionStatus === 'saving' ? tr('正在保存记录…')
    : closePrompt ? tr('保存并结束')
    : running ? tr('结束翻译')
    : rejoin ? tr('继续这场翻译')
    : tr('开始翻译');
  const arming = sessionStatus === 'opening' || sessionStatus === 'connecting' || sessionStatus === 'reconnecting';
  const cancellable = sessionStatus === 'opening' || sessionStatus === 'connecting';

  const settings = <div className={phone ? 'dock-sheet' : 'dock-panel'}>
    <Section title={tr('语言与模式')}>
      <div className="dock-tabs">
        <button className={mode === 'one_way' ? 'active' : ''} onClick={() => !busySession && props.onMode('one_way')} disabled={busySession}>{tr('课堂模式')}</button>
        <button className={mode === 'two_way' ? 'active' : ''} onClick={() => !busySession && props.onMode('two_way')} disabled={busySession}>{tr('对话模式')}</button>
      </div>
      <div className="language-row">
        <LanguageSelect label={tr('原语言')} value={languageA} options={languages} onChange={props.onLanguageA} disabled={busySession} />
        <span className="swap" aria-hidden="true">{mode === 'one_way' ? '→' : '↔'}</span>
        <LanguageSelect label={tr(mode === 'one_way' ? '翻译为' : '第二语言')} value={languageB} options={languages} onChange={props.onLanguageB} disabled={busySession} />
      </div>
      {sameLanguage && <p className="audio-hint" role="alert">{tr('源语言和目标语言不能相同。')}</p>}
      <label className="audio-source">
        <span>{tr('选择术语库')}</span>
        <select value={glossaryId} onChange={(event) => props.onGlossary(event.target.value)} disabled={busySession}>
          <option value="">{tr('不使用术语库')}</option>
          {glossaryChoices.map((item) => <option value={item.id} key={item.id}>{glossaryOptionLabel(item)}</option>)}
        </select>
      </label>
      {glossaryHint}
    </Section>

    <Section title={tr('音频')}>
      <label className="audio-source">
        <span>{tr('音频来源')}</span>
        <select value={audioSource} onChange={(event) => props.onAudioSource(event.target.value as AudioSource)} disabled={busySession}>
          <option value="microphone">{tr('麦克风')}</option>
          <option value="system">{tr('系统声音 / 屏幕共享')}</option>
        </select>
      </label>
      {audioSource === 'microphone' && <label className="audio-source">
        <span>{tr('选择麦克风')}</span>
        <select value={micId} onChange={(event) => props.onMic(event.target.value)} disabled={busySession}>
          <option value="">{tr('系统默认麦克风')}</option>
          {mics.map((mic) => <option value={mic.id} key={mic.id}>{mic.label}</option>)}
        </select>
      </label>}
      {audioSource === 'system' && <p className="audio-hint">{tr('共享窗口时请勾选“共享声音”。')}</p>}
      <label className="record-toggle" title={tr('保存本次语音')}>
        <input type="checkbox" checked={recordAudio} onChange={(event) => props.onRecordAudio(event.target.checked)} disabled={busySession} aria-label={tr('保存本次语音')} />
        <span>{tr('保存本次语音')}</span>
      </label>
      <div className="stage-tools">
        <button type="button" className={voiceBoost ? 'active' : ''} aria-pressed={voiceBoost} onClick={() => props.onVoiceBoost(!voiceBoost)}>{tr('声音增强')}</button>
      </div>
      <p className="audio-hint">{tr('老师声音偏小时打开。只抬高于环境噪声的语音，并减弱低频隆隆声。字幕和录音走的是同一路声音，翻译过程中可以随时开关。')}</p>
    </Section>

    <Section title={tr('字幕显示')}>
      <div className="stage-tools">
        {CAPTION_VIEWS.map((item) => <button key={item.value} type="button" className={captionView === item.value ? 'active' : ''} onClick={() => props.onCaptionView(item.value)}>{tr(item.label)}</button>)}
      </div>
      <div className="stage-tools">
        <span>{tr('字号')}</span>
        {CAPTION_SIZES.map((item) => <button key={item.value} type="button" className={captionSize === item.value ? 'active' : ''} onClick={() => props.onCaptionSize(item.value)}>{tr(item.label)}</button>)}
        <button type="button" onClick={props.onFullscreen}>{fullscreen ? tr('退出全屏') : tr('全屏')}</button>
      </div>
      {hasCaptions && <div className="list-item-actions">
        <button type="button" className="secondary-button" onClick={props.onCopy}>{tr('复制字幕')}</button>
        <button type="button" className="secondary-button" onClick={props.onExport}>{tr('导出文本')}</button>
      </div>}
    </Section>

    <Section title={tr('这场翻译')}>
      <label className="audio-source session-title-field">
        <span>{tr('这场翻译的名称')}</span>
        <input value={sessionTitle} onChange={(event) => props.onSessionTitle(event.target.value.slice(0, 120))} maxLength={120} placeholder={tr('可选，方便以后查找')} aria-label={tr('这场翻译的名称')} disabled={sessionStatus === 'stopping'} />
      </label>
      <div className="dock-sheet-actions">
        <span className={`direction-badge${timeWarning ? ' time-warning' : ''}`}>{directionLabel}{remainingLabel}</span>
      </div>
    </Section>
  </div>;

  return <aside className="control-dock">
    {dockOpen && settings}
    <div className="dock-bar">
      {liveSessionId && <AudienceLink sessionId={liveSessionId} mode={mode} compact={phone} />}
      {phone && <div className="dock-anchor">
        <button
          type="button"
          className={`dock-icon-button${captionOpen ? ' active' : ''}`}
          aria-expanded={captionOpen}
          aria-label={tr('字幕显示')}
          onClick={() => props.onCaptionOpen(!captionOpen)}
        >Aa</button>
        {captionOpen && <CaptionPopover
          view={captionView}
          size={captionSize}
          onView={props.onCaptionView}
          onSize={props.onCaptionSize}
          onCopy={props.onCopy}
          onExport={props.onExport}
          onClose={() => props.onCaptionOpen(false)}
        />}
      </div>}
      <button type="button" className="dock-toggle" aria-expanded={dockOpen} onClick={() => props.onDockOpen(!dockOpen)}>
        {dockOpen ? tr('收起') : phone ? tr('更多') : tr('设置')}
      </button>
      {/* The main button ignores taps while starting, so a permission sheet's
          dismissal cannot cancel the session. This is the deliberate way out. */}
      {cancellable && <button type="button" className="dock-toggle" onClick={props.onCancel}>{tr('取消')}</button>}
      {running && <button type="button" className="dock-icon-button" onClick={props.onPause} aria-label={paused ? tr('继续收音') : tr('暂停收音')} title={tr('暂停收音，计时继续')}>{paused ? <PlayIcon size={16} /> : <PauseIcon size={16} />}</button>}
      <button
        type="button"
        className={`record-button ${running ? 'recording' : ''} ${arming ? 'arming' : ''}`}
        disabled={sessionStatus === 'stopping'}
        onClick={props.onPrimary}
      >
        {running ? <StopIcon size={16} /> : <RecordIcon size={16} />}
        <span className="record-label">{primaryLabel}</span>
      </button>
      {!phone && <span className={`direction-badge${timeWarning ? ' time-warning' : ''}`}>{directionLabel}{remainingLabel}</span>}
    </div>
    {dockOpen && !phone && <div className="dock-foot">
      <span>{tr('音频：')}{audioSource === 'system' ? tr('系统声音') : tr('麦克风')}{voiceBoost ? ` · ${tr('声音增强')}` : ''}</span>
      <span>{planLabel}</span>
    </div>}
  </aside>;
}

export { CaptionToolbar };
