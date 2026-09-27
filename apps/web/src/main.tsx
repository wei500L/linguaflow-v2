import { StrictMode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createCaptionFold, ingestCaptionTokens, projectCaptionTurns, LANGUAGE_OPTIONS, PLANS, type Entitlement, type RealtimeEvent, type TranscriptToken } from '@linguaflow/shared';
import { api, ApiError, apiResponse, clearToken, getToken, isTokenExpired, setToken, tokenExpiresWithin } from './lib/api';
import { createPcmStream, listAudioInputs, type AudioSource } from './lib/audio';
import { glossaryOptionLabel, languageNative, sameLanguageCode } from './lib/glossary';
import { getLang, tr, useLang } from './lib/i18n';
import { LanguageToggle } from './language-toggle';
import { LegalPage, MarketingPage } from './marketing';
import { PanelShell } from './panel-shell';
import { SharePage } from './share-page';
import { TranscriptPanel } from './transcript-panel';
import { AudienceLink } from './audience-link';
import { FirstRun } from './first-run';
import { LivePage } from './live-page';
import './styles.css';

type Segment = { source: string; translation: string; speaker?: string; language?: string; interim?: boolean };
type Profile = { id: string; email: string; displayName?: string | null; role: string };
type Panel = 'none' | 'transcripts' | 'glossary' | 'pricing' | 'admin' | 'account';
type SessionStatus = 'idle' | 'opening' | 'connecting' | 'running' | 'reconnecting' | 'stopping';
type ServiceStatus = 'checking' | 'online' | 'offline';

function AuthScreen({ onLogin }: { onLogin: () => void }) {
  const [mode, setMode] = useState<'login' | 'register' | 'code_login' | 'reset'>('login');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [code, setCode] = useState('');
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const [cooldown, setCooldown] = useState(0); const [showPassword, setShowPassword] = useState(false); const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (cooldown <= 0) return; const timer = window.setTimeout(() => setCooldown(cooldown - 1), 1000); return () => window.clearTimeout(timer); }, [cooldown]);
  async function sendVerificationCode() { const path = mode === 'register' ? '/v1/auth/email/register/code' : mode === 'reset' ? '/v1/auth/email/password-reset/code' : '/v1/auth/email/login/code'; await api(path, { method: 'POST', body: JSON.stringify({ email }) }); setCooldown(60); setMessage(tr('验证码已发送，请查收邮箱。')); codeInput.current?.focus(); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      if (mode === 'register') {
        if (!code) {
          await sendVerificationCode();
          return;
        }
        const result = await api<{ token: string }>('/v1/auth/email/register', { method: 'POST', body: JSON.stringify({ email, password, code }) });
        setToken(result.token); onLogin();
      } else if (mode === 'code_login') {
        const result = await api<{ token: string }>('/v1/auth/email/login/code/verify', { method: 'POST', body: JSON.stringify({ email, code }) });
        setToken(result.token); onLogin();
      } else if (mode === 'reset') {
        await api('/v1/auth/email/password-reset', { method: 'POST', body: JSON.stringify({ email, code, password }) });
        setMode('login'); setMessage(tr('密码已重置，请登录。'));
      } else {
        const result = await api<{ token: string }>('/v1/auth/email/login/password', { method: 'POST', body: JSON.stringify({ email, password }) });
        setToken(result.token); onLogin();
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : tr('操作失败')); } finally { setBusy(false); }
  }
  return <main className="auth-layout"><section className="auth-pitch"><div className="brand-mark">L</div><p className="eyebrow">LINGUAFLOW</p><h1>{tr('让每一次对话，')}<br /><em>{tr('自然地抵达')}</em></h1><p>{tr('实时语音识别、翻译与字幕记录，适用于会议、课堂和跨语言交流。')}</p><div className="demo-card"><span>ZH · 00:18</span><strong>{tr('欢迎来到 LinguaFlow')}</strong><small>Welcome to LinguaFlow</small></div></section><form className="auth-card" onSubmit={submit}><div className="auth-card-header"><LanguageToggle /><h2>{mode === 'register' ? tr('创建账户') : mode === 'reset' ? tr('重置密码') : tr('登录 LinguaFlow')}</h2><p>{tr('继续使用你的实时翻译工作区')}</p></div><label>{tr('邮箱')}<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@example.com" autoComplete="email" /></label>{mode !== 'code_login' && <label>{mode === 'reset' ? tr('新密码') : tr('密码')}<input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} placeholder={tr('至少 8 位字符')} autoComplete={mode === 'reset' || mode === 'register' ? 'new-password' : 'current-password'} /><button type="button" className="password-toggle" aria-label={showPassword ? tr('隐藏密码') : tr('显示密码')} onClick={() => setShowPassword((value) => !value)}>{showPassword ? tr('隐藏') : tr('显示')}</button></label>}{mode !== 'login' && <label>{tr('验证码')}<input ref={codeInput} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder={tr('邮箱验证码')} required={mode !== 'register'} autoComplete="one-time-code" /></label>}{mode !== 'login' && <button type="button" className="link-button" disabled={cooldown > 0 || busy} onClick={() => void sendVerificationCode().catch((error) => setMessage(error.message))}>{cooldown > 0 ? `${cooldown} ${tr('秒后重发')}` : tr('发送验证码')}</button>}{message && <div className="form-message" role="alert">{message}</div>}<button className="primary-button" disabled={busy}>{busy ? tr('处理中…') : mode === 'login' ? tr('登录') : mode === 'register' ? tr('完成注册') : mode === 'reset' ? tr('重置密码') : tr('验证码登录')}</button><button type="button" className="link-button" onClick={() => { setMode('code_login'); setMessage(''); }}>{tr('验证码登录')}</button><button type="button" className="link-button" onClick={() => { setMode('reset'); setMessage(''); }}>{tr('忘记密码')}</button><button type="button" className="link-button" onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setMessage(''); setCode(''); }}>{mode === 'register' ? tr('返回登录') : tr('创建账户')}</button><p className="auth-legal"><a href="/privacy">{tr('隐私政策')}</a><a href="/terms">{tr('服务条款')}</a></p></form></main>;
}

function Topbar({ entitlement, onLogout, onPanel, isAdmin, serviceStatus }: { entitlement: Entitlement | null; onLogout: () => void; onPanel: (panel: Panel) => void; isAdmin: boolean; serviceStatus: ServiceStatus }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const statusLabel = serviceStatus === 'checking' ? tr('检查服务中') : serviceStatus === 'online' ? tr('实时服务正常') : tr('实时服务异常');
  const openPanel = (next: Panel) => { onPanel(next); setMenuOpen(false); };
  return <header className="topbar"><div className="wordmark"><span className="brand-mark small">L</span><strong>LinguaFlow</strong></div><div className="topbar-actions"><div className="desktop-nav"><LanguageToggle /><button className="topbar-link" onClick={() => onPanel('transcripts')}>{tr('字幕库')}</button><button className="topbar-link" onClick={() => onPanel('glossary')}>{tr('术语库')}</button><button className="topbar-link" onClick={() => onPanel('pricing')}>{tr('会员')}</button><button className="topbar-link" onClick={() => onPanel('account')}>{tr('账户')}</button>{isAdmin && <button className="topbar-link" onClick={() => onPanel('admin')}>{tr('后台')}</button>}</div><div className="mobile-menu-wrap"><button className="mobile-menu-button" aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((open) => !open)}>{tr('菜单')}</button>{menuOpen && <div className="mobile-menu" role="menu"><LanguageToggle /><button onClick={() => openPanel('transcripts')} role="menuitem">{tr('字幕库')}</button><button onClick={() => openPanel('glossary')} role="menuitem">{tr('术语库')}</button><button onClick={() => openPanel('pricing')} role="menuitem">{tr('会员')}</button><button onClick={() => openPanel('account')} role="menuitem">{tr('账户')}</button>{isAdmin && <button onClick={() => openPanel('admin')} role="menuitem">{tr('后台')}</button>}</div>}</div><span className={`status-pill ${serviceStatus}`}><i />{statusLabel}</span>{entitlement && <span className="quota-pill">{entitlement.plan.toUpperCase()} · {entitlement.remainingSeconds === Number.MAX_SAFE_INTEGER ? '∞' : Math.ceil(entitlement.remainingSeconds / 60)} 分钟</span>}<button className="icon-button" onClick={onLogout} aria-label={tr('退出登录')} title={tr('退出登录')}>↪</button></div></header>;
}

type GlossaryTerm = { id: string; source: string; target: string; pinned?: boolean };
type Glossary = { id: string; name: string; languageA: string; languageB: string; terms?: GlossaryTerm[] };

function LanguagePairFields({ a, b, onA, onB }: { a: string; b: string; onA: (value: string) => void; onB: (value: string) => void }) {
  return <div className="term-row"><select value={a} onChange={(event) => onA(event.target.value)} aria-label={tr('原语言')}>{LANGUAGE_OPTIONS.map((option) => <option value={option.code} key={option.code}>{option.nativeName}</option>)}</select><span>→</span><select value={b} onChange={(event) => onB(event.target.value)} aria-label={tr('翻译为')}>{LANGUAGE_OPTIONS.map((option) => <option value={option.code} key={`b-${option.code}`}>{option.nativeName}</option>)}</select></div>;
}

function GlossaryPanel({ onClose, languageA, languageB, activeId, onActive, onList }: { onClose: () => void; languageA: string; languageB: string; activeId: string; onActive: (id: string) => void; onList: (items: Glossary[]) => void }) {
  const [items, setItems] = useState<Glossary[]>([]); const [name, setName] = useState('我的术语库'); const [source, setSource] = useState(''); const [target, setTarget] = useState(''); const [draftSource, setDraftSource] = useState(''); const [draftTarget, setDraftTarget] = useState(''); const [editingId, setEditingId] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [glossaryName, setGlossaryName] = useState(''); const [langA, setLangA] = useState(languageA); const [langB, setLangB] = useState(languageB); const [createLangA, setCreateLangA] = useState(languageA); const [createLangB, setCreateLangB] = useState(languageB); const [importText, setImportText] = useState('');
  const selected = items.find((item) => item.id === activeId) ?? null;
  async function refresh() {
    setLoading(true); setError('');
    try {
      const rows = await api<Glossary[]>('/v1/me/glossaries');
      setItems(rows);
      onList(rows);
      if (activeId && !rows.some((item) => item.id === activeId)) onActive('');
    } catch (err) { setError(err instanceof Error ? err.message : '术语库加载失败'); } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (!selected) return; setGlossaryName(selected.name); setLangA(selected.languageA); setLangB(selected.languageB); }, [selected?.id, selected?.name, selected?.languageA, selected?.languageB]);
  async function createGlossary() {
    if (!name.trim() || saving || sameLanguageCode(createLangA, createLangB)) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const created = await api<Glossary>('/v1/me/glossaries', { method: 'POST', body: JSON.stringify({ name: name.trim(), languageA: createLangA, languageB: createLangB }) });
      onActive(created.id); setName('我的术语库'); setMessage(tr('词库已创建。')); await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : '创建术语库失败'); } finally { setSaving(false); }
  }
  async function addTerm() {
    if (!selected || !source.trim() || !target.trim() || saving) return;
    setSaving(true); setError(''); setMessage('');
    try {
      await api(`/v1/me/glossaries/${selected.id}/terms`, { method: 'POST', body: JSON.stringify({ source: source.trim(), target: target.trim() }) });
      setSource(''); setTarget(''); setMessage(tr('术语已添加。')); await refresh();
    } catch (err) { setError(err instanceof Error ? tr(err.message) : tr('添加术语失败')); } finally { setSaving(false); }
  }
  async function saveTerm(term: GlossaryTerm) {
    if (!selected || !draftSource.trim() || !draftTarget.trim() || saving) return;
    setSaving(true); setError(''); setMessage('');
    try {
      await api(`/v1/me/glossaries/${selected.id}/terms/${term.id}`, { method: 'PATCH', body: JSON.stringify({ source: draftSource.trim(), target: draftTarget.trim() }) });
      setEditingId(null); setMessage(tr('术语已更新。')); await refresh();
    } catch (err) { setError(err instanceof Error ? tr(err.message) : '更新术语失败'); } finally { setSaving(false); }
  }
  async function removeTerm(term: GlossaryTerm) {
    if (!selected || !window.confirm(tr('确定删除这个词条吗？'))) return;
    setError('');
    try { await api(`/v1/me/glossaries/${selected.id}/terms/${term.id}`, { method: 'DELETE' }); if (editingId === term.id) setEditingId(null); await refresh(); }
    catch (err) { setError(err instanceof Error ? tr(err.message) : '删除术语失败'); }
  }
  async function pinTerm(term: GlossaryTerm) {
    if (!selected || saving) return;
    setSaving(true); setError('');
    try {
      await api(`/v1/me/glossaries/${selected.id}/terms/${term.id}`, { method: 'PATCH', body: JSON.stringify({ source: term.source, target: term.target, pinned: !term.pinned }) });
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : tr('更新术语失败')); }
    finally { setSaving(false); }
  }
  async function usePreset(preset: 'analysis' | 'algebra' | 'discrete' | 'pascal' | 'practice' | 'history' | 'safety' | 'classroom' | 'medical' | 'legal') {
    setSaving(true); setError('');
    try {
      const created = await api<Glossary>('/v1/me/glossaries/from-preset', { method: 'POST', body: JSON.stringify({ preset }) });
      onActive(created.id); setMessage(tr('预置词库已加入。')); await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : tr('创建术语库失败')); }
    finally { setSaving(false); }
  }
  async function removeGlossary(item: Glossary) {
    if (!window.confirm(tr('确定删除“{name}”吗？').replace('{name}', item.name))) return;
    try { await api(`/v1/me/glossaries/${item.id}`, { method: 'DELETE' }); if (activeId === item.id) onActive(''); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : '删除术语库失败'); }
  }
  async function saveGlossary() {
    if (!selected || !glossaryName.trim() || saving || sameLanguageCode(langA, langB)) return;
    setSaving(true); setError(''); setMessage('');
    try {
      await api(`/v1/me/glossaries/${selected.id}`, { method: 'PATCH', body: JSON.stringify({ name: glossaryName.trim(), languageA: langA, languageB: langB }) });
      setMessage(tr('词库已保存。')); await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : '更新术语失败'); } finally { setSaving(false); }
  }
  async function importTerms() {
    if (!selected || !importText.trim() || saving) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const result = await api<{ added: number; skippedDuplicate: number; skippedInvalid: number; skippedLimit: number }>(`/v1/me/glossaries/${selected.id}/import`, { method: 'POST', body: JSON.stringify({ text: importText }) });
      const notes = [tr('已导入 {count} 条。').replace('{count}', String(result.added))];
      if (result.skippedDuplicate) notes.push(tr('跳过重复 {count} 条。').replace('{count}', String(result.skippedDuplicate)));
      if (result.skippedInvalid) notes.push(tr('跳过格式不对 {count} 条。').replace('{count}', String(result.skippedInvalid)));
      if (result.skippedLimit) notes.push(tr('跳过超出上限 {count} 条。').replace('{count}', String(result.skippedLimit)));
      setImportText(''); setMessage(notes.join(' ')); await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : '添加术语失败'); } finally { setSaving(false); }
  }
  async function exportTerms() {
    if (!selected) return;
    try {
      const response = await apiResponse(`/v1/me/glossaries/${selected.id}/export`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `${selected.name}.txt`; document.body.append(anchor); anchor.click(); anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) { setError(err instanceof Error ? err.message : '导出失败'); }
  }
  const orderedTerms = [...(selected?.terms ?? [])].sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)));
  return <PanelShell title={tr('术语库')} onClose={onClose}><p className="panel-description">{tr('单向按当前会话方向注入。方向相反时会自动对调。双向会话会同时使用反向译法。')}</p><div className="glossary-switch"><select value={activeId} onChange={(event) => onActive(event.target.value)} aria-label={tr('选择术语库')}><option value="">{tr('不使用术语库')}</option>{items.map((item) => <option value={item.id} key={item.id}>{glossaryOptionLabel(item)}</option>)}</select></div><div className="term-form"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={tr('词库名称')} aria-label={tr('词库名称')} /><LanguagePairFields a={createLangA} b={createLangB} onA={setCreateLangA} onB={setCreateLangB} />{sameLanguageCode(createLangA, createLangB) && <p className="form-message" role="alert">{tr('源语言和目标语言不能相同。')}</p>}<button className="primary-button" onClick={() => void createGlossary()} disabled={saving || !name.trim() || sameLanguageCode(createLangA, createLangB)}>{tr('新建词库')}</button></div><div className="preset-groups"><div><p className="eyebrow">{tr('课程词库')}</p><p className="panel-description">{tr('每门课单独一份。点一次只新建这一门。')}</p><div className="list-item-actions"><button className="secondary-button" onClick={() => void usePreset('analysis')} disabled={saving}>{tr('数学分析词库')}</button><button className="secondary-button" onClick={() => void usePreset('algebra')} disabled={saving}>{tr('线性代数词库')}</button><button className="secondary-button" onClick={() => void usePreset('discrete')} disabled={saving}>{tr('离散数学词库')}</button><button className="secondary-button" onClick={() => void usePreset('pascal')} disabled={saving}>{tr('Pascal 词库')}</button><button className="secondary-button" onClick={() => void usePreset('practice')} disabled={saving}>{tr('计算机实践词库')}</button><button className="secondary-button" onClick={() => void usePreset('history')} disabled={saving}>{tr('历史词库')}</button><button className="secondary-button" onClick={() => void usePreset('safety')} disabled={saving}>{tr('生命安全词库')}</button></div></div><div><p className="eyebrow">{tr('通用词库')}</p><div className="list-item-actions"><button className="secondary-button" onClick={() => void usePreset('classroom')} disabled={saving}>{tr('课堂词库')}</button><button className="secondary-button" onClick={() => void usePreset('medical')} disabled={saving}>{tr('医学词库')}</button><button className="secondary-button" onClick={() => void usePreset('legal')} disabled={saving}>{tr('法律词库')}</button></div></div></div>{selected && <div className="term-form"><div className="term-row"><input value={source} onChange={(event) => setSource(event.target.value)} placeholder={languageNative(selected.languageA)} aria-label={tr('原文术语')} /><span>→</span><input value={target} onChange={(event) => setTarget(event.target.value)} placeholder={languageNative(selected.languageB)} aria-label={tr('指定译法')} /></div><button className="primary-button" onClick={() => void addTerm()} disabled={saving || !source.trim() || !target.trim()}>{saving ? tr('添加中…') : tr('添加术语')}</button></div>}{message && <div className="form-message success-message" role="status">{message}</div>}{error && <div className="form-message" role="alert">{error}</div>}<div className="panel-list">{loading && <div className="panel-empty">{tr('正在加载术语库…')}</div>}{!loading && !items.length && <div className="panel-empty">{tr('还没有术语库。')}</div>}{selected && !selected.terms?.length && <div className="panel-empty">{tr('还没有词条。')}</div>}{orderedTerms.map((term) => <div className="panel-list-item" key={term.id}>{editingId === term.id ? <div className="term-edit"><input value={draftSource} onChange={(event) => setDraftSource(event.target.value)} aria-label={tr('原文术语')} /><span>→</span><input value={draftTarget} onChange={(event) => setDraftTarget(event.target.value)} aria-label={tr('指定译法')} /><button className="secondary-button" onClick={() => void saveTerm(term)} disabled={saving}>{tr('保存')}</button><button className="secondary-button" onClick={() => setEditingId(null)}>{tr('取消')}</button></div> : <div className="term-line"><span><strong>{term.pinned ? '★ ' : ''}{term.source}</strong><small>{term.target}</small></span><span className="list-item-actions"><button className="secondary-button" onClick={() => void pinTerm(term)}>{term.pinned ? tr('取消优先') : tr('优先')}</button><button className="secondary-button" onClick={() => { setEditingId(term.id); setDraftSource(term.source); setDraftTarget(term.target); }}>{tr('编辑')}</button><button className="danger-button" onClick={() => void removeTerm(term)}>{tr('删除词条')}</button></span></div>}</div>)}{selected && <div className="glossary-tools"><div className="term-form"><label>{tr('词库名称')}<input value={glossaryName} onChange={(event) => setGlossaryName(event.target.value)} /></label><div className="term-row"><LanguagePairFields a={langA} b={langB} onA={setLangA} onB={setLangB} /></div>{sameLanguageCode(langA, langB) && <p className="form-message" role="alert">{tr('源语言和目标语言不能相同。')}</p>}<div className="list-item-actions"><button className="secondary-button" onClick={() => void saveGlossary()} disabled={saving || sameLanguageCode(langA, langB)}>{tr('保存词库')}</button><button className="secondary-button" onClick={() => void exportTerms()}>{tr('导出术语')}</button><button className="danger-button" onClick={() => void removeGlossary(selected)}>{tr('删除')}</button></div></div><label>{tr('导入术语')}<textarea className="summary-editor" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={tr('每行一条，原文和译法用 Tab 分开。')} /></label><button className="secondary-button" onClick={() => void importTerms()} disabled={saving || !importText.trim()}>{tr('导入')}</button></div>}</div></PanelShell>;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds >= Number.MAX_SAFE_INTEGER / 2) return tr('无限');
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes <= 0) return `${rest} ${tr('秒')}`;
  if (rest === 0) return `${minutes} ${tr('分钟')}`;
  return `${minutes} ${tr('分钟')} ${rest} ${tr('秒')}`;
}

function formatDate(iso: string | null) {
  if (!iso) return tr('无到期日');
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(document.documentElement.lang === 'en' ? 'en' : 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatRemain(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

const planFit = { free: '适合先试一次短对话。', plus: '适合课堂和两小时以内的会议。', pro: '适合半天讲座和连续会议。', ultra: '适合全天活动。每月分钟不限，单次最长 12 小时。' } as const;
type Redemption = { id: string; redeemedAt: string; grantedPlan: string | null; grantedMonths: number | null; grantedAddonSeconds: number };

function PricingPanel({ onClose, entitlement, onRefresh }: { onClose: () => void; entitlement: Entitlement | null; onRefresh: () => void }) {
  const [code, setCode] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  useEffect(() => { void api<{ items: Redemption[] }>('/v1/billing/redemptions').then((result) => setRedemptions(result.items)).catch(() => undefined); }, [entitlement?.plan, entitlement?.addonSeconds]);
  async function redeem() { if (!code.trim() || busy) return; setBusy(true); try { await api('/v1/billing/redeem', { method: 'POST', body: JSON.stringify({ code: code.trim() }) }); setMessage(tr('激活成功，额度已更新。')); onRefresh(); } catch (error) { setMessage(error instanceof Error ? error.message : '激活失败'); } finally { setBusy(false); } }
  const monthlyLeft = entitlement?.remainingSeconds ?? 0;
  const addon = entitlement?.addonSeconds ?? 0;
  const usable = monthlyLeft >= Number.MAX_SAFE_INTEGER / 2 ? monthlyLeft : monthlyLeft + addon;
  return <PanelShell title={tr('套餐与激活码')} onClose={onClose}>{entitlement && <div className="usage-card"><p className="eyebrow">{tr('当前额度')}</p><div className="admin-stat-grid usage-grid"><div><small>{tr('当前套餐')}</small><strong>{entitlement.plan.toUpperCase()}</strong></div><div><small>{tr('到期时间')}</small><strong>{entitlement.plan === 'free' || !entitlement.planExpiresAt ? tr('无到期日') : formatDate(entitlement.planExpiresAt)}</strong></div><div><small>{tr('本月已用')}</small><strong>{formatDuration(entitlement.usedSecondsThisPeriod)}</strong></div><div><small>{tr('本月剩余')}</small><strong>{formatDuration(monthlyLeft)}</strong></div><div><small>{tr('加时包')}</small><strong>{formatDuration(addon)}</strong></div><div><small>{tr('现在可用')}</small><strong>{formatDuration(usable)}</strong></div></div><p className="panel-description">{tr('本月已用分钟将在此日期重置：')} {formatDate(entitlement.periodEnd)}</p>{entitlement.status === 'expired' && <p className="panel-description">{tr('付费套餐已到期，当前已回到 Free。')}</p>}<p className="panel-description">{tr('先扣本月套餐分钟，用完后扣加时包。加时包不会按月清零。付费套餐到期后回到 Free，并重新计算本月已用分钟。单次会话不会超过套餐的单次上限，也不会超过当时剩余的套餐分钟加加时包。')}</p></div>}<p className="panel-description">{tr('四个套餐都能使用实时字幕、术语库、录音、导出和纪要。差别是每月分钟和单次时长。')}</p><p className="panel-description">{tr('套餐通过激活码开通，不能在应用内购买。')}</p><div className="plan-grid">{(['free', 'plus', 'pro', 'ultra'] as const).map((plan) => <div className={`plan-card ${entitlement?.plan === plan ? 'selected' : ''}`} key={plan}><p>{PLANS[plan].label}</p><strong>{PLANS[plan].monthlySeconds === null ? tr('无限') : Math.round(PLANS[plan].monthlySeconds / 60)} {tr('分钟/月')}</strong><small>{tr('单次最多')} {Math.round(PLANS[plan].maxSessionSeconds / 60)} {tr('分钟')}</small><small>{tr(planFit[plan])}</small></div>)}</div><div className="redeem-box"><p className="eyebrow">ACTIVATION CODE</p><h3>{tr('使用激活码')}</h3><div className="redeem-row"><input value={code} onChange={(event) => setCode(event.target.value)} placeholder={tr('激活码')} aria-label={tr('激活码')} autoComplete="off" /><button className="primary-button" onClick={() => void redeem()} disabled={busy}>{busy ? tr('兑换中…') : tr('兑换')}</button></div>{message && <p className="panel-description" role="status">{message}</p>}</div><div className="usage-list"><h3>{tr('兑换记录')}</h3>{redemptions.length === 0 && <p className="panel-description">{tr('还没有兑换记录。')}</p>}{redemptions.map((item) => <p className="panel-description" key={item.id}>{formatDate(item.redeemedAt)} · {item.grantedPlan ? tr('开通 {plan}').replace('{plan}', item.grantedPlan.toUpperCase()) : tr('加时包')}{item.grantedMonths ? ` · ${tr('{count} 个月').replace('{count}', String(item.grantedMonths))}` : ''}{item.grantedAddonSeconds ? ` · ${tr('加时 {minutes} 分钟').replace('{minutes}', String(Math.round(item.grantedAddonSeconds / 60)))}` : ''}</p>)}</div></PanelShell>;
}

function AccountPanel({ onClose, email, displayName, onProfile }: { onClose: () => void; email: string; displayName: string; onProfile: () => void }) {
  const [currentPassword, setCurrentPassword] = useState(''); const [newPassword, setNewPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState(displayName); const [nextEmail, setNextEmail] = useState(''); const [emailCode, setEmailCode] = useState(''); const [deleteEmail, setDeleteEmail] = useState('');
  const [apiBase, setApiBase] = useState(''); const [model, setModel] = useState(''); const [apiKey, setApiKey] = useState(''); const [providerNote, setProviderNote] = useState('');
  const [usage, setUsage] = useState<Array<{ id: string; kind: string; source: string; seconds: number; createdAt: string; title: string | null }>>([]);
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { setName(displayName); }, [displayName]);
  useEffect(() => { void api<{ items: Array<{ id: string; kind: string; source: string; seconds: number; createdAt: string; title: string | null }> }>('/v1/me/usage').then((result) => setUsage(result.items)).catch(() => undefined); void api<{ apiBase?: string; model?: string; hasKey?: boolean; keyHint?: string }>('/v1/me/summary-provider').then((value) => { setApiBase(value.apiBase ?? ''); setModel(value.model ?? ''); setProviderNote(value.keyHint ? `${tr('已保存密钥末四位')} ${value.keyHint}` : ''); }).catch(() => undefined); }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setMessage(''); setError('');
    if (newPassword !== confirmPassword) { setError(tr('两次输入的新密码不一致。')); return; }
    setBusy(true);
    try {
      await api('/v1/me/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setMessage(tr('密码已更新。'));
    } catch (err) { setError(err instanceof Error ? tr(err.message) : tr('修改密码失败')); }
    finally { setBusy(false); }
  }
  async function saveName(event: React.FormEvent) {
    event.preventDefault(); setMessage(''); setError(''); setBusy(true);
    try { await api('/v1/me/profile', { method: 'PATCH', body: JSON.stringify({ displayName: name.trim() }) }); setMessage(tr('显示名已保存。')); onProfile(); }
    catch (err) { setError(err instanceof Error ? err.message : tr('修改密码失败')); }
    finally { setBusy(false); }
  }
  async function sendEmailCode() {
    setMessage(''); setError('');
    try { await api('/v1/me/email/code', { method: 'POST', body: JSON.stringify({ email: nextEmail.trim() }) }); setMessage(tr('验证码已发送，请查收邮箱。')); }
    catch (err) { setError(err instanceof Error ? err.message : tr('操作失败')); }
  }
  async function changeEmail(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    try { await api('/v1/me/email', { method: 'POST', body: JSON.stringify({ email: nextEmail.trim(), code: emailCode }) }); setMessage(tr('邮箱已更新。')); onProfile(); }
    catch (err) { setError(err instanceof Error ? err.message : tr('操作失败')); }
    finally { setBusy(false); }
  }
  async function saveProvider(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    try {
      const saved = await api<{ keyHint?: string }>('/v1/me/summary-provider', { method: 'PUT', body: JSON.stringify({ apiBase, model, apiKey: apiKey || undefined }) });
      setApiKey(''); setProviderNote(saved.keyHint ? `${tr('已保存密钥末四位')} ${saved.keyHint}` : ''); setMessage(tr('模型已保存。密钥不会再次显示。'));
    } catch (err) { setError(err instanceof Error ? err.message : tr('保存模型失败')); }
    finally { setBusy(false); }
  }
  async function exportData() {
    try {
      const response = await apiResponse('/v1/me/export');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'linguaflow-export.json'; document.body.append(anchor); anchor.click(); anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) { setError(err instanceof Error ? err.message : tr('导出失败')); }
  }
  async function removeAccount(event: React.FormEvent) {
    event.preventDefault();
    if (deleteEmail.trim().toLowerCase() !== email.toLowerCase()) { setError(tr('邮箱确认不一致。')); return; }
    setBusy(true);
    try { await api('/v1/me/delete', { method: 'POST', body: JSON.stringify({ email: deleteEmail.trim() }) }); clearToken(); window.location.reload(); }
    catch (err) { setError(err instanceof Error ? err.message : tr('操作失败')); setBusy(false); }
  }
  return <PanelShell title={tr('账户')} onClose={onClose}><p className="panel-description">{tr('登录邮箱')}</p><p className="account-email">{email}</p><form className="term-form" onSubmit={(event) => void saveName(event)}><label>{tr('显示名')}<input value={name} onChange={(event) => setName(event.target.value)} required /></label><button className="secondary-button" disabled={busy}>{tr('保存显示名')}</button></form><form className="term-form" onSubmit={(event) => void submit(event)}><h3>{tr('修改密码')}</h3><label>{tr('当前密码')}<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></label><label>{tr('新密码')}<input type="password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" required placeholder={tr('至少 8 位字符')} /></label><label>{tr('确认新密码')}<input type="password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required /></label>{message && <div className="form-message success-message" role="status">{message}</div>}{error && <div className="form-message" role="alert">{error}</div>}<button className="primary-button" disabled={busy}>{busy ? tr('保存中…') : tr('更新密码')}</button></form><form className="term-form" onSubmit={(event) => void changeEmail(event)}><h3>{tr('更换邮箱')}</h3><label>{tr('新邮箱')}<input type="email" value={nextEmail} onChange={(event) => setNextEmail(event.target.value)} required /></label><label>{tr('验证码')}<input value={emailCode} onChange={(event) => setEmailCode(event.target.value)} inputMode="numeric" /></label><button type="button" className="link-button" onClick={() => void sendEmailCode()}>{tr('发送验证码')}</button><button className="secondary-button" disabled={busy}>{tr('确认更换')}</button></form><form className="term-form" onSubmit={(event) => void saveProvider(event)}><h3>{tr('我的模型')}</h3><p className="panel-description">{tr('总结请求由 LinguaFlow 服务器发出，请填写服务器能够访问的地址。本机开发时可使用 http://127.0.0.1。')}</p><label>{tr('API 地址')}<input value={apiBase} onChange={(event) => setApiBase(event.target.value)} placeholder="https://api.openai.com/v1" autoComplete="off" /></label><label>{tr('模型名称')}<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" autoComplete="off" /></label><label>{tr('API 密钥')}<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" /></label>{providerNote && <p className="provider-note">{providerNote}</p>}<button className="secondary-button" disabled={busy || !apiBase.trim() || !model.trim()}>{tr('保存模型')}</button></form><div className="usage-list"><h3>{tr('用量记录')}</h3>{usage.length === 0 && <p className="panel-description">{tr('暂无用量。')}</p>}{usage.map((item) => <p className="panel-description" key={item.id}>{item.kind === 'summary' ? tr('平台纪要') : tr('实时翻译')} · {item.source === 'addon' ? tr('加时包') : tr('套餐分钟')} · {formatDuration(item.seconds)}{item.title ? ` · ${item.title}` : ''}</p>)}</div>{message && <div className="form-message success-message" role="status">{message}</div>}<button type="button" className="secondary-button" onClick={() => void exportData()}>{tr('导出数据')}</button><p className="auth-legal"><a href="/privacy">{tr('隐私政策')}</a><a href="/terms">{tr('服务条款')}</a></p><form className="term-form" onSubmit={(event) => void removeAccount(event)}><h3>{tr('注销账户')}</h3><p className="panel-description">{tr('注销后字幕、录音和术语库都会删除。')}</p><label>{tr('输入邮箱以确认注销')}<input type="email" value={deleteEmail} onChange={(event) => setDeleteEmail(event.target.value)} required /></label><button className="danger-button" disabled={busy}>{tr('确认注销')}</button></form></PanelShell>;
}

type AdminUser = { id: string; email: string; displayName?: string | null; plan?: string | null; addonSeconds?: number | null };
type AdminCode = { id: string; codePrefix: string; plan: string | null; months: number | null; addonSeconds: number; redemptionCount: number; maxRedemptions: number; expiresAt: string | null; disabled: boolean; note: string | null };
type AdminSession = { id: string; email: string | null; mode: string; status: string };
type UsageTotal = { kind: string; source: string; seconds: number };

function AdminPanel({ onClose }: { onClose: () => void }) {
  const [count, setCount] = useState(1); const [plan, setPlan] = useState('plus'); const [months, setMonths] = useState(1); const [addonMinutes, setAddonMinutes] = useState(0); const [maxRedemptions, setMaxRedemptions] = useState(1); const [expiresInDays, setExpiresInDays] = useState(''); const [note, setNote] = useState(''); const [codes, setCodes] = useState<string[]>([]);
  const [savedCodes, setSavedCodes] = useState<AdminCode[]>([]); const [users, setUsers] = useState<AdminUser[]>([]); const [query, setQuery] = useState(''); const [sessions, setSessions] = useState<AdminSession[]>([]); const [totals, setTotals] = useState<UsageTotal[]>([]); const [activeSessions, setActiveSessions] = useState(0);
  const [grantPlan, setGrantPlan] = useState('plus'); const [grantMonths, setGrantMonths] = useState(1); const [grantMinutes, setGrantMinutes] = useState(60);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function load() {
    const [codeRows, sessionRows, usage, userRows] = await Promise.all([
      api<AdminCode[]>('/v1/admin/activation-codes'),
      api<AdminSession[]>('/v1/admin/realtime-sessions'),
      api<{ activeSessions: number; totals: UsageTotal[] }>('/v1/admin/usage'),
      api<AdminUser[]>(`/v1/admin/users${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`)
    ]);
    setSavedCodes(codeRows); setSessions(sessionRows); setTotals(usage.totals); setActiveSessions(usage.activeSessions); setUsers(userRows);
  }
  useEffect(() => { void load().catch((err) => setError(err instanceof Error ? err.message : '生成激活码失败')); }, []);
  async function generate() { if (busy) return; setBusy(true); setError(''); try { const result = await api<{ codes: string[] }>('/v1/admin/activation-codes', { method: 'POST', body: JSON.stringify({ count, plan, months, addonSeconds: addonMinutes * 60, maxRedemptions, expiresInDays: expiresInDays.trim() ? Math.max(1, Number(expiresInDays) || 1) : undefined, note: note.trim() || undefined }) }); setCodes(result.codes); await load(); } catch (err) { setError(err instanceof Error ? err.message : '生成激活码失败'); } finally { setBusy(false); } }
  async function copyCodes() { try { await navigator.clipboard.writeText(codes.join('\n')); } catch { setError('当前浏览器不允许复制激活码。'); } }
  async function disableCode(id: string) { setError(''); try { await api(`/v1/admin/activation-codes/${id}`, { method: 'PATCH', body: JSON.stringify({ disabled: true }) }); await load(); } catch (err) { setError(err instanceof Error ? err.message : '操作失败'); } }
  async function grant(userId: string) { setError(''); try { await api(`/v1/admin/users/${userId}/plan`, { method: 'POST', body: JSON.stringify({ plan: grantPlan, months: grantMonths }) }); await load(); } catch (err) { setError(err instanceof Error ? err.message : '操作失败'); } }
  async function grantAddon(userId: string) { setError(''); try { await api(`/v1/admin/users/${userId}/addon`, { method: 'POST', body: JSON.stringify({ minutes: grantMinutes }) }); await load(); } catch (err) { setError(err instanceof Error ? err.message : '操作失败'); } }
  async function terminate(id: string) { setError(''); try { await api(`/v1/admin/realtime-sessions/${id}/terminate`, { method: 'POST' }); await load(); } catch (err) { setError(err instanceof Error ? err.message : '操作失败'); } }
  return <PanelShell title={tr('管理后台')} onClose={onClose} wide><div className="admin-stat-grid"><div><small>{tr('进行中的会话')}</small><strong>{activeSessions}</strong></div><div><small>{tr('用量汇总')}</small><strong>{totals.reduce((sum, item) => sum + item.seconds, 0) ? formatDuration(totals.reduce((sum, item) => sum + item.seconds, 0)) : tr('暂无用量。')}</strong></div></div>{totals.map((item) => <p className="panel-description" key={`${item.kind}-${item.source}`}>{item.kind === 'summary' ? tr('平台纪要') : tr('实时翻译')} · {item.source === 'addon' ? tr('加时包') : tr('套餐分钟')} · {formatDuration(item.seconds)}</p>)}<div className="term-form"><label>{tr('搜用户')}<input value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="secondary-button" onClick={() => void load()}>{tr('搜用户')}</button></div><div className="term-form"><label>{tr('套餐')}<select value={grantPlan} onChange={(event) => setGrantPlan(event.target.value)}><option value="plus">Plus</option><option value="pro">Pro</option><option value="ultra">Ultra</option><option value="free">Free</option></select></label><label>{tr('月数')}<input type="number" min="1" max="120" value={grantMonths} onChange={(event) => setGrantMonths(Math.min(120, Math.max(1, Number(event.target.value) || 1)))} /></label><label>{tr('加时包分钟')}<input type="number" min="1" value={grantMinutes} onChange={(event) => setGrantMinutes(Math.max(1, Number(event.target.value) || 1))} /></label></div><div className="panel-list">{users.map((user) => <div className="panel-list-item" key={user.id}><span><strong>{user.email}</strong><small>{(user.plan ?? 'free').toUpperCase()} · {tr('加时包')} {formatDuration(user.addonSeconds ?? 0)}</small></span><span className="list-item-actions"><button className="secondary-button" onClick={() => void grant(user.id)}>{tr('开通')}</button><button className="secondary-button" onClick={() => void grantAddon(user.id)}>{tr('增加加时包')}</button></span></div>)}</div><div className="term-form"><label>{tr('套餐')}<select value={plan} onChange={(event) => setPlan(event.target.value)}><option value="plus">Plus</option><option value="pro">Pro</option><option value="ultra">Ultra</option></select></label><label>{tr('月数')}<input type="number" min="1" max="120" value={months} onChange={(event) => setMonths(Math.min(120, Math.max(1, Number(event.target.value) || 1)))} /></label><label>{tr('加时包分钟')}<input type="number" min="0" value={addonMinutes} onChange={(event) => setAddonMinutes(Math.max(0, Number(event.target.value) || 0))} /></label><label>{tr('可兑换次数')}<input type="number" min="1" max="10000" value={maxRedemptions} onChange={(event) => setMaxRedemptions(Math.min(10000, Math.max(1, Number(event.target.value) || 1)))} /></label><label>{tr('有效天数')}<input type="number" min="1" max="3650" value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)} placeholder={tr('留空则不限')} /></label><label>{tr('生成数量')}<input type="number" min="1" max="100" value={count} onChange={(event) => setCount(Math.min(100, Math.max(1, Number(event.target.value) || 1)))} /></label><label>{tr('备注')}<input value={note} onChange={(event) => setNote(event.target.value)} /></label><button className="primary-button" onClick={() => void generate()} disabled={busy}>{busy ? tr('生成中…') : tr('生成激活码')}</button></div>{error && <div className="form-message" role="alert">{error}</div>}{codes.length > 0 && <div className="generated-codes"><div className="generated-codes-header"><span>已生成 {codes.length} 个</span><button className="link-button" onClick={() => void copyCodes()}>{tr('复制全部')}</button></div>{codes.map((code) => <code key={code}>{code}</code>)}</div>}<h3>{tr('激活码列表')}</h3><div className="panel-list">{savedCodes.map((code) => <div className="panel-list-item" key={code.id}><span><strong>{code.codePrefix}…</strong><small>{(code.plan ?? 'addon').toUpperCase()} · {code.months ?? 0} · {tr('兑换 {count} 次').replace('{count}', `${code.redemptionCount}/${code.maxRedemptions}`)}{code.expiresAt ? ` · ${tr('到期')} ${formatDate(code.expiresAt)}` : ''}{code.disabled ? ' · disabled' : ''}</small></span>{!code.disabled && <button className="danger-button" onClick={() => void disableCode(code.id)}>{tr('作废')}</button>}</div>)}</div><h3>{tr('进行中的会话')}</h3>{sessions.length === 0 && <p className="panel-description">{tr('没有进行中的会话。')}</p>}<div className="panel-list">{sessions.map((session) => <div className="panel-list-item" key={session.id}><span><strong>{session.email ?? session.id}</strong><small>{session.mode} · {session.status}</small></span><button className="danger-button" onClick={() => void terminate(session.id)}>{tr('终止')}</button></div>)}</div></PanelShell>;
}

function LanguageSelect({ label, value, options, onChange, disabled }: { label: string; value: string; options: Array<{ code: string; nativeName: string; englishName: string }>; onChange: (value: string) => void; disabled?: boolean }) {
  return <label className="select-field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>{options.map((option) => <option value={option.code} key={option.code}>{option.nativeName} · {option.code.toUpperCase()}</option>)}</select></label>;
}

type CaptionView = 'both' | 'translation' | 'source';
const CAPTION_PAGE = 80;
type ActiveSession = { id: string; mode: 'one_way' | 'two_way'; status: string; title: string | null; languageA: string; languageB: string | null; targetLanguage: string | null };

function App() {
  useLang();
  const [authenticated, setAuthenticated] = useState(Boolean(getToken()) && !isTokenExpired());
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null); const [panel, setPanel] = useState<Panel>('none');
  const [mode, setMode] = useState<'one_way' | 'two_way'>('one_way');
  const [languageA, setLanguageA] = useState(() => localStorage.getItem('linguaflow_lang_a') || 'ru'); const [languageB, setLanguageB] = useState(() => localStorage.getItem('linguaflow_lang_b') || 'zh');
  const [glossaryId, setGlossaryId] = useState(() => localStorage.getItem('linguaflow_glossary') || ''); const [glossaryChoices, setGlossaryChoices] = useState<Glossary[]>([]);
  const [languages, setLanguages] = useState<Array<{ code: string; nativeName: string; englishName: string }>>([]);
  const [audioSource, setAudioSource] = useState<AudioSource>('microphone'); const [recordAudio, setRecordAudio] = useState(() => localStorage.getItem('linguaflow_record_audio') !== '0'); const [dockOpen, setDockOpen] = useState(false); const [showJump, setShowJump] = useState(false); const dockRef = useRef<HTMLElement>(null); const stageRef = useRef<HTMLDivElement>(null); const followLatest = useRef(true); const scrolling = useRef(false); const captionFold = useRef(createCaptionFold()); const captionLimitRef = useRef(CAPTION_PAGE); const windowEndRef = useRef(0); const scrollAnchor = useRef(0);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('idle'); const [serviceStatus, setServiceStatus] = useState<ServiceStatus>('checking'); const [segments, setSegments] = useState<Segment[]>([]); const [error, setError] = useState('');
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null); const [endedTranscriptId, setEndedTranscriptId] = useState<string | null>(null); const [focusTranscriptId, setFocusTranscriptId] = useState<string | null>(null);
  const [recordAck, setRecordAck] = useState(() => localStorage.getItem('linguaflow_record_ack') === '1');
  const [conflictSession, setConflictSession] = useState<ActiveSession | null>(null); const [captionLimit, setCaptionLimit] = useState(CAPTION_PAGE); const [windowEnd, setWindowEnd] = useState(0); const [paused, setPaused] = useState(false); const pausedRef = useRef(false);
  const [captionSize, setCaptionSize] = useState(() => localStorage.getItem('linguaflow_caption_size') || 'md'); const [glossaryDropped, setGlossaryDropped] = useState(0); const [glossaryDroppedTerms, setGlossaryDroppedTerms] = useState<string[]>([]); const [glossaryUsed, setGlossaryUsed] = useState(0); const [glossaryAligned, setGlossaryAligned] = useState(true); const [fullscreen, setFullscreen] = useState(false);
  const [sessionTitle, setSessionTitle] = useState(''); const [closePrompt, setClosePrompt] = useState(false); const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(() => localStorage.getItem('linguaflow_seen_guide') !== '1'); const [captionView, setCaptionView] = useState<CaptionView>(() => { const saved = localStorage.getItem('linguaflow_caption_view'); return saved === 'translation' || saved === 'source' ? saved : 'both'; });
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({}); const [namingSpeaker, setNamingSpeaker] = useState<string | null>(null); const [speakerDraft, setSpeakerDraft] = useState('');
  const [mics, setMics] = useState<Array<{ id: string; label: string }>>([]); const [micId, setMicId] = useState(() => localStorage.getItem('linguaflow_mic') || ''); const [liveNotice, setLiveNotice] = useState('');
  const acceptAudio = useRef(false); const userStop = useRef(false); const recoverLock = useRef(false); const readyWait = useRef<((ok: boolean) => void) | null>(null); const speakerNamesRef = useRef<Record<string, string>>({}); const closeTitleRef = useRef('');
  const limitSeconds = useRef<number | null>(null); const readyAt = useRef<number | null>(null); const savedTranscriptId = useRef<string | null>(null);
  const statusRef = useRef<SessionStatus>('idle'); const generation = useRef(0); const authToken = useRef(getToken()); const sessionId = useRef<string | null>(null); const socket = useRef<WebSocket | null>(null); const audio = useRef<{ stop: () => Promise<void> } | null>(null); const keepalive = useRef<number | null>(null); const startupTimer = useRef<number | null>(null); const drain = useRef<(() => void) | null>(null); const upstreamDone = useRef(false); const audioQueue = useRef<ArrayBuffer[]>([]);
  const running = sessionStatus === 'running'; const busySession = sessionStatus !== 'idle';
  function updateSessionStatus(next: SessionStatus) { statusRef.current = next; setSessionStatus(next); }
  useEffect(() => { const expire = () => { void stop(); clearToken(); setAuthenticated(false); }; window.addEventListener('linguaflow:auth-expired', expire); const timer = window.setInterval(() => { if (getToken() && isTokenExpired()) expire(); }, 30_000); return () => { window.removeEventListener('linguaflow:auth-expired', expire); window.clearInterval(timer); }; }, []);
  useEffect(() => { let alive = true; async function check() { try { const response = await fetch((import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3000' : '')) + '/health'); if (alive) setServiceStatus(response.ok ? 'online' : 'offline'); } catch { if (alive) setServiceStatus('offline'); } } void check(); const timer = window.setInterval(() => void check(), 30_000); return () => { alive = false; window.clearInterval(timer); }; }, []);

  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock) {
      document.documentElement.style.removeProperty('--dock-height');
      document.documentElement.style.removeProperty('--app-height');
      return;
    }
    const apply = () => {
      document.documentElement.style.setProperty('--dock-height', `${dock.offsetHeight}px`);
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${viewport}px`);
    };
    apply();
    const observer = 'ResizeObserver' in window ? new ResizeObserver(apply) : null;
    observer?.observe(dock);
    window.addEventListener('resize', apply);
    window.visualViewport?.addEventListener('resize', apply);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', apply);
      window.visualViewport?.removeEventListener('resize', apply);
      document.documentElement.style.removeProperty('--dock-height');
      document.documentElement.style.removeProperty('--app-height');
    };
  }, [authenticated, dockOpen, sessionStatus]);
  useEffect(() => { document.documentElement.lang = getLang() === 'en' ? 'en' : 'zh-CN'; document.title = getLang() === 'en' ? 'LinguaFlow · Live Translation' : 'LinguaFlow · 实时双语翻译'; if (authenticated) { api<Entitlement>('/v1/me/entitlement').then(setEntitlement).catch(() => setAuthenticated(false)); api<Profile>('/v1/me/profile').then(setProfile).catch(() => undefined); api<Array<{ code: string; nativeName: string; englishName: string }>>('/v1/me/languages').then((items) => { setLanguages(items); if (!items.some((item) => item.code === languageA)) setLanguageA(items[0]?.code ?? 'zh'); if (!items.some((item) => item.code === languageB)) setLanguageB(items[1]?.code ?? items[0]?.code ?? 'en'); }).catch(() => undefined); } }, [authenticated]);
  useEffect(() => { authToken.current = getToken(); }, [authenticated]);
  useEffect(() => { localStorage.setItem('linguaflow_lang_a', languageA); localStorage.setItem('linguaflow_lang_b', languageB); }, [languageA, languageB]);
  useEffect(() => { localStorage.setItem('linguaflow_record_audio', recordAudio ? '1' : '0'); }, [recordAudio]);
  useEffect(() => { localStorage.setItem('linguaflow_glossary', glossaryId); }, [glossaryId]);
  useEffect(() => { localStorage.setItem('linguaflow_caption_size', captionSize); }, [captionSize]);
  useEffect(() => { localStorage.setItem('linguaflow_caption_view', captionView); }, [captionView]);
  useEffect(() => {
    if (sessionStatus !== 'running' && sessionStatus !== 'reconnecting') return;
    const handle = window.setTimeout(() => {
      const title = sessionTitle.trim().slice(0, 120);
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'title', title }));
    }, 400);
    return () => window.clearTimeout(handle);
  }, [sessionTitle, sessionStatus]);
  useEffect(() => { localStorage.setItem('linguaflow_mic', micId); }, [micId]);
  useEffect(() => { if (!authenticated) return; void listAudioInputs().then(setMics).catch(() => undefined); }, [authenticated, dockOpen, sessionStatus]);
  useEffect(() => { const onChange = () => setFullscreen(Boolean(document.fullscreenElement)); document.addEventListener('fullscreenchange', onChange); return () => document.removeEventListener('fullscreenchange', onChange); }, []);
  useEffect(() => { if (!authenticated) return; let alive = true; api<{ session: ActiveSession | null }>('/v1/realtime/sessions/active').then((result) => { if (alive && result.session && statusRef.current === 'idle') setConflictSession(result.session); }).catch(() => undefined); return () => { alive = false; }; }, [authenticated]);
  useEffect(() => {
    if (!authenticated || !glossaryId) { setGlossaryDropped(0); setGlossaryDroppedTerms([]); setGlossaryUsed(0); setGlossaryAligned(true); return; }
    const params = new URLSearchParams({ type: mode, languageA });
    if (mode === 'one_way') params.set('targetLanguage', languageB); else params.set('languageB', languageB);
    let alive = true;
    api<{ used?: number; dropped: number; droppedTerms?: string[]; aligned?: boolean }>(`/v1/me/glossaries/${glossaryId}/coverage?${params}`).then((result) => { if (alive) { setGlossaryUsed(result.used ?? 0); setGlossaryDropped(result.dropped); setGlossaryDroppedTerms(result.droppedTerms ?? []); setGlossaryAligned(result.aligned !== false); } }).catch(() => { if (alive) { setGlossaryDropped(0); setGlossaryDroppedTerms([]); setGlossaryUsed(0); setGlossaryAligned(true); } });
    return () => { alive = false; };
  }, [authenticated, glossaryId, mode, languageA, languageB]);
  useEffect(() => {
    if (sessionStatus !== 'running') return;
    const timer = window.setInterval(() => {
      if (!tokenExpiresWithin(2 * 60 * 60 * 1000)) return;
      void api<{ token: string }>('/v1/auth/refresh', { method: 'POST' }).then((result) => setToken(result.token)).catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [sessionStatus]);
  useEffect(() => {
    if (sessionStatus !== 'running') return;
    const tick = () => {
      const limit = limitSeconds.current;
      const started = readyAt.current;
      if (limit === null || started === null) return;
      setRemainingSeconds(Math.max(0, limit - Math.floor((Date.now() - started) / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [sessionStatus]);
  useEffect(() => { if (!authenticated) return; let alive = true; api<Glossary[]>('/v1/me/glossaries').then((rows) => { if (!alive) return; setGlossaryChoices(rows); if (glossaryId && !rows.some((row) => row.id === glossaryId)) setGlossaryId(''); }).catch(() => undefined); return () => { alive = false; }; }, [authenticated, panel]);
  function rememberCaptionLimit(next: number) {
    captionLimitRef.current = next;
    setCaptionLimit(next);
  }
  function publishCaptions(interim: TranscriptToken[] = [], pinToEnd = followLatest.current) {
    const next = projectCaptionTurns(captionFold.current, interim);
    if (pinToEnd) {
      windowEndRef.current = next.length;
      setWindowEnd(next.length);
    }
    setSegments(next);
  }
  function showEarlierCaptions() {
    const end = Math.min(windowEndRef.current, segments.length);
    if (end <= captionLimitRef.current) return;
    followLatest.current = false;
    setShowJump(true);
    const el = stageRef.current;
    if (el) scrollAnchor.current = el.scrollHeight;
    rememberCaptionLimit(Math.min(end, captionLimitRef.current + CAPTION_PAGE));
  }
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    if (followLatest.current) {
      scrollAnchor.current = 0;
      scrolling.current = true;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => { scrolling.current = false; });
      return;
    }
    const before = scrollAnchor.current;
    if (!before) return;
    scrollAnchor.current = 0;
    const delta = el.scrollHeight - before;
    if (delta <= 0) return;
    scrolling.current = true;
    el.scrollTop += delta;
    requestAnimationFrame(() => { scrolling.current = false; });
  }, [segments, captionLimit, windowEnd, sessionStatus]);
  function onStageScroll() {
    if (scrolling.current) return;
    const el = stageRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = distance < 48;
    followLatest.current = next;
    setShowJump(!next && el.scrollHeight > el.clientHeight);
    if (next) {
      if (captionLimitRef.current !== CAPTION_PAGE) rememberCaptionLimit(CAPTION_PAGE);
      if (windowEndRef.current !== segments.length) {
        windowEndRef.current = segments.length;
        setWindowEnd(segments.length);
      }
      return;
    }
    if (el.scrollTop < 72 && el.scrollHeight > el.clientHeight + 8) showEarlierCaptions();
  }
  function jumpLatest() {
    followLatest.current = true;
    setShowJump(false);
    windowEndRef.current = segments.length;
    setWindowEnd(segments.length);
    if (captionLimitRef.current !== CAPTION_PAGE) rememberCaptionLimit(CAPTION_PAGE);
    const el = stageRef.current;
    if (!el) return;
    scrolling.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => { scrolling.current = false; });
  }
  const currentLabel = useMemo(() => mode === 'one_way' ? `${languageA.toUpperCase()} → ${languageB.toUpperCase()}` : `${languageA.toUpperCase()} ↔ ${languageB.toUpperCase()}`, [mode, languageA, languageB]);
  const activeGlossary = glossaryChoices.find((item) => item.id === glossaryId) ?? null;
  const glossaryPairLabel = activeGlossary ? `${languageNative(activeGlossary.languageA)} → ${languageNative(activeGlossary.languageB)}` : '';
  const sessionPairLabel = `${languageNative(languageA)} ${mode === 'one_way' ? '→' : '↔'} ${languageNative(languageB)}`;

  function consumeTokens(tokens: TranscriptToken[]) {
    const interim: TranscriptToken[] = [];
    const finals: TranscriptToken[] = [];
    for (const token of tokens) {
      if (token.text === '<end>' || token.is_final) finals.push(token);
      else interim.push(token);
    }
    if (finals.length) ingestCaptionTokens(captionFold.current, finals);
    publishCaptions(interim);
  }

  const sameLanguage = languageA.toLowerCase().split('-')[0] === languageB.toLowerCase().split('-')[0];
  function pumpAudio(socket: WebSocket | null) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (audioQueue.current.length && socket.bufferedAmount < 262_144) {
      const next = audioQueue.current.shift();
      if (next) socket.send(next);
    }
  }
  async function flushQueuedAudio(socket: WebSocket | null) {
    const started = Date.now();
    while (socket && socket.readyState === WebSocket.OPEN && audioQueue.current.length && Date.now() - started < 2_000) {
      pumpAudio(socket);
      if (!audioQueue.current.length) return;
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
  }
  function sendChunk(chunk: ArrayBuffer) {
    if (pausedRef.current) return;
    audioQueue.current.push(chunk);
    if (audioQueue.current.length > 200) audioQueue.current.shift();
    if (acceptAudio.current) pumpAudio(socket.current);
  }
  function bindSocket(ws: WebSocket) {
    socket.current = ws;
    ws.onmessage = (event) => {
      if (socket.current !== ws || userStop.current) return;
      try {
        const data = JSON.parse(event.data) as RealtimeEvent;
        if (data.type === 'ready') {
          if (typeof data.allowedSeconds === 'number') { limitSeconds.current = data.allowedSeconds; readyAt.current = Date.now(); }
          acceptAudio.current = true;
          pumpAudio(ws);
          if (keepalive.current !== null) window.clearInterval(keepalive.current);
          keepalive.current = window.setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'keepalive' })); }, 15_000);
          if (startupTimer.current !== null) window.clearTimeout(startupTimer.current); startupTimer.current = null;
          setError('');
          updateSessionStatus('running');
          readyWait.current?.(true);
          readyWait.current = null;
        }
        if (data.type === 'snapshot') {
          captionFold.current = createCaptionFold();
          ingestCaptionTokens(captionFold.current, data.tokens);
          if (data.speakerNames) { speakerNamesRef.current = data.speakerNames; setSpeakerNames(data.speakerNames); }
          followLatest.current = true;
          publishCaptions([], true);
        }
        if (data.type === 'transcript') consumeTokens(data.tokens);
        if (data.type === 'error') { setError(data.code === 'quota_exhausted' ? tr('额度已用完，本次会话已结束。') : data.code === 'session_limit_reached' ? tr('单次时长已到，本次会话已结束。') : data.message ?? data.code); if (data.code === 'quota_exhausted' || data.code === 'session_limit_reached') void stop(); else { releaseUpstream(); void stop({ alreadyFinished: true }); } }
        if (data.type === 'finished') { if (data.transcriptId) savedTranscriptId.current = data.transcriptId; releaseUpstream(); void stop({ alreadyFinished: true }); }
      } catch { setError(tr('收到无法识别的实时消息。')); releaseUpstream(); void stop({ alreadyFinished: true }); }
    };
    ws.onerror = () => { if (socket.current === ws) setError(tr('连接中断，正在恢复…')); };
    ws.onclose = () => {
      if (socket.current !== ws) return;
      readyWait.current?.(false);
      readyWait.current = null;
      if (userStop.current || statusRef.current === 'stopping' || statusRef.current === 'idle') return;
      if (upstreamDone.current) { void stop({ alreadyFinished: true }); return; }
      if (!recoverLock.current) void recover();
    };
  }
  async function recover() {
    if (recoverLock.current || userStop.current) return;
    const current = sessionId.current;
    if (!current) return;
    recoverLock.current = true;
    acceptAudio.current = false;
    updateSessionStatus('reconnecting');
    setError(tr('连接中断，正在恢复…'));
    let restored = false;
    for (let attempt = 0; attempt < 3 && !userStop.current; attempt += 1) {
      try {
        const session = await api<{ websocketUrl: string; websocketProtocols: string[] }>(`/v1/realtime/sessions/${current}/reconnect`, { method: 'POST' });
        if (userStop.current) break;
        const opened = new Promise<boolean>((resolve) => { readyWait.current = resolve; });
        bindSocket(new WebSocket(session.websocketUrl, session.websocketProtocols));
        restored = await opened;
        if (restored) break;
      } catch (err) {
        readyWait.current = null;
        if (err instanceof ApiError && (err.status === 404 || err.status === 409)) break;
        await new Promise((resolve) => window.setTimeout(resolve, 800));
      }
    }
    if (!restored && !userStop.current && statusRef.current !== 'idle' && statusRef.current !== 'stopping') {
      userStop.current = true;
      recoverLock.current = false;
      setError(tr('无法恢复连接，会话已结束。'));
      releaseUpstream();
      void stop({ alreadyFinished: true });
      return;
    }
    recoverLock.current = false;
  }
  async function ensureAudio(gen: number) {
    if (audio.current) return true;
    const stream = await createPcmStream(sendChunk, audioSource, () => { if (generation.current === gen) { setError(tr('音频来源已结束，会话已停止。')); void stop(); } }, audioSource === 'microphone' ? micId || undefined : undefined);
    if (generation.current !== gen) { await stream.stop(); return false; }
    audio.current = stream;
    void listAudioInputs().then(setMics).catch(() => undefined);
    return true;
  }
  async function start() {
    if (statusRef.current !== 'idle') return;
    if (sameLanguage) { setError(tr('源语言和目标语言不能相同。')); return; }
    const id = ++generation.current;
    userStop.current = false;
    acceptAudio.current = false;
    speakerNamesRef.current = {};
    setSpeakerNames({}); setNamingSpeaker(null); setLiveNotice(''); setClosePrompt(false); closeTitleRef.current = sessionTitle.trim().slice(0, 120);
    setError(''); setSegments([]); setDockOpen(false); setShowJump(false); setEndedTranscriptId(null); setRemainingSeconds(null); setPaused(false); pausedRef.current = false; setConflictSession(null); followLatest.current = true; captionFold.current = createCaptionFold(); windowEndRef.current = 0; setWindowEnd(0); if (captionLimitRef.current !== CAPTION_PAGE) rememberCaptionLimit(CAPTION_PAGE); upstreamDone.current = false; audioQueue.current = []; savedTranscriptId.current = null; limitSeconds.current = null; readyAt.current = null;
    updateSessionStatus('opening');
    try {
      if (!await ensureAudio(id)) return;
      updateSessionStatus('connecting');
      startupTimer.current = window.setTimeout(() => { if (generation.current === id && (statusRef.current === 'connecting' || statusRef.current === 'opening')) { setError(tr('连接超时，请重试。')); void stop(); } }, 15_000);
      const glossary = glossaryId ? { glossaryId } : {};
      const named = sessionTitle.trim().slice(0, 120);
      const title = named ? { title: named } : {};
      const session = await api<{ sessionId: string; websocketUrl: string; websocketProtocols: string[] }>('/v1/realtime/sessions', { method: 'POST', body: JSON.stringify(mode === 'one_way' ? { type: 'one_way', languageA, targetLanguage: languageB, recordAudio, ...glossary, ...title } : { type: 'two_way', languageA, languageB, recordAudio, ...glossary, ...title }) });
      if (generation.current !== id) { setLiveSessionId(null); void api(`/v1/realtime/sessions/${session.sessionId}`, { method: 'DELETE', headers: authToken.current ? { authorization: `Bearer ${authToken.current}` } : undefined }).catch(() => undefined); return; }
      sessionId.current = session.sessionId;
      setLiveSessionId(session.sessionId);
      bindSocket(new WebSocket(session.websocketUrl, session.websocketProtocols));
    } catch (err) {
      if (generation.current !== id) return;
      const cause = err as DOMException;
      if (err instanceof ApiError && err.code === 'session_conflict') { setError(tr('上一场翻译还在占用额度。')); const fallbackId = err.sessionId ?? null; if (fallbackId) setConflictSession({ id: fallbackId, mode, status: 'active', title: null, languageA: '', languageB: null, targetLanguage: null }); void api<{ session: ActiveSession | null }>('/v1/realtime/sessions/active').then((result) => { if (statusRef.current !== 'idle' || sessionId.current) return; if (result.session) setConflictSession(result.session); }).catch(() => undefined); }
      else if (err instanceof ApiError && err.code === 'quota_exhausted') setError(tr('额度已用完，无法开始新的翻译。'));
      else setError(cause.name === 'NotAllowedError' || cause.name === 'NotFoundError' ? tr('音频权限被拒绝，请在浏览器中允许访问后重试。') : err instanceof Error ? tr(err.message) : tr('无法开始翻译'));
      void stop();
    }
  }
  function releaseUpstream() { upstreamDone.current = true; drain.current?.(); }
  async function stop(options?: { alreadyFinished?: boolean }) {
    if (statusRef.current === 'idle' || statusRef.current === 'stopping') return;
    userStop.current = true;
    acceptAudio.current = false;
    setClosePrompt(false);
    readyWait.current?.(false);
    readyWait.current = null;
    updateSessionStatus('stopping');
    if (startupTimer.current !== null) window.clearTimeout(startupTimer.current); startupTimer.current = null;
    if (keepalive.current !== null) window.clearInterval(keepalive.current); keepalive.current = null;
    const ws = socket.current;
    const stream = audio.current; audio.current = null;
    await stream?.stop().catch(() => undefined);
    if (!options?.alreadyFinished && !upstreamDone.current && ws?.readyState === WebSocket.OPEN) {
      await flushQueuedAudio(ws);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'speakers', names: speakerNamesRef.current }));
        ws.send(JSON.stringify({ type: 'stop', title: closeTitleRef.current || undefined }));
      }
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 8_000);
        drain.current = () => { window.clearTimeout(timer); resolve(); };
      });
      drain.current = null;
    }
    ++generation.current;
    socket.current = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
    const id = sessionId.current; sessionId.current = null;
    if (id && getToken()) await api(`/v1/realtime/sessions/${id}`, { method: 'DELETE' }).catch(() => undefined);
    if (getToken()) void api<Entitlement>('/v1/me/entitlement').then(setEntitlement).catch(() => undefined);
    const saved = savedTranscriptId.current;
    savedTranscriptId.current = null;
    limitSeconds.current = null;
    readyAt.current = null;
    setRemainingSeconds(null);
    updateSessionStatus('idle');
    closeTitleRef.current = '';
    setLiveSessionId(null);
    if (saved) { setEndedTranscriptId(saved); setSessionTitle(''); }
  }
  function requestClose() {
    if (statusRef.current !== 'running' && statusRef.current !== 'reconnecting') { void stop(); return; }
    if (sessionTitle.trim()) { confirmClose(); return; }
    setClosePrompt(true);
  }
  function confirmClose() {
    closeTitleRef.current = sessionTitle.trim().slice(0, 120);
    setClosePrompt(false);
    void stop();
  }
  async function logout() { await stop(); clearToken(); setAuthenticated(false); }
  async function endConflict(thenStart = false) {
    const id = conflictSession?.id;
    if (!id) return;
    await api(`/v1/realtime/sessions/${id}`, { method: 'DELETE' }).catch(() => undefined);
    setConflictSession(null); setError('');
    if (thenStart) await start();
  }
  function applyActiveSession(session: ActiveSession) {
    if (!session.languageA) return;
    setMode(session.mode === 'two_way' ? 'two_way' : 'one_way');
    setLanguageA(session.languageA);
    const paired = session.mode === 'two_way' ? session.languageB : session.targetLanguage ?? session.languageB;
    if (paired) setLanguageB(paired);
    setSessionTitle(session.title ?? '');
  }
  async function resumeConflict() {
    const pending = conflictSession;
    if (!pending || statusRef.current !== 'idle') return;
    userStop.current = false;
    acceptAudio.current = false;
    setConflictSession(null); setError(''); setLiveNotice('');
    followLatest.current = true;
    const gen = ++generation.current;
    sessionId.current = pending.id;
    setLiveSessionId(pending.id);
    captionFold.current = createCaptionFold();
    windowEndRef.current = 0;
    setWindowEnd(0);
    setSegments([]);
    applyActiveSession(pending);
    updateSessionStatus('opening');
    let session = pending;
    try {
      const result = await api<{ session: ActiveSession | null }>('/v1/realtime/sessions/active');
      if (generation.current !== gen) return;
      if (result.session?.id === pending.id) session = result.session;
    } catch { /* Use the session captured when the conflict was detected. */ }
    if (generation.current !== gen) return;
    applyActiveSession(session);
    try {
      if (!await ensureAudio(gen)) return;
      await recover();
    } catch (err) {
      setError(err instanceof Error ? tr(err.message) : tr('无法恢复连接，会话已结束。'));
      void stop();
    }
  }
  function liveText() {
    return segments.filter((segment) => !segment.interim && (segment.source || segment.translation)).map((segment) => {
      const who = segment.speaker ? speakerNames[segment.speaker] ?? segment.speaker : '';
      const source = segment.source;
      const translation = segment.translation;
      const body = captionView === 'source' ? source : captionView === 'translation' ? (translation || source) : [translation, source].filter(Boolean).join('\n');
      return who ? `${who}\n${body}` : body;
    }).join('\n\n');
  }
  async function copyLive() {
    try { await navigator.clipboard.writeText(liveText()); setLiveNotice(tr('已复制当前字幕。')); }
    catch { setError(tr('当前浏览器不允许复制，请手动选择文本。')); }
  }
  function exportLive() {
    const blob = new Blob([liveText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${sessionTitle.trim() || 'linguaflow'}.txt`; document.body.append(anchor); anchor.click(); anchor.remove();
    URL.revokeObjectURL(url);
  }
  function renameLiveSpeaker() {
    if (!namingSpeaker || !speakerDraft.trim()) return;
    const next = { ...speakerNamesRef.current, [namingSpeaker]: speakerDraft.trim() };
    speakerNamesRef.current = next;
    setSpeakerNames(next);
    setNamingSpeaker(null);
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'speakers', names: next }));
  }
  function togglePause() { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); if (pausedRef.current) audioQueue.current = []; }
  async function toggleFullscreen() {
    const node = stageRef.current?.parentElement;
    if (!node) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await node.requestFullscreen();
  }
  async function reloadProfile() { const next = await api<Profile>('/v1/me/profile'); setProfile(next); }
  const captionEnd = Math.min(windowEnd, segments.length);
  const hiddenCaptions = Math.max(0, captionEnd - captionLimit);
  const visibleCaptions = segments.slice(hiddenCaptions, captionEnd);
  const path = window.location.pathname;
  if (path === '/privacy' || path === '/en/privacy') return <LegalPage kind="privacy" />;
  if (path === '/terms' || path === '/en/terms') return <LegalPage kind="terms" />;
  const shareToken = path.match(/^\/s\/([^/]+)\/?$/)?.[1];
  if (shareToken) return <SharePage token={decodeURIComponent(shareToken)} />;
  const liveToken = path.match(/^\/live\/([^/]+)\/?$/)?.[1];
  if (liveToken) return <LivePage token={decodeURIComponent(liveToken)} />;
  if (!authenticated && path !== '/') return <MarketingPage />;
  if (!authenticated) return <AuthScreen onLogin={() => setAuthenticated(true)} />;
  return <div className="app-shell"><Topbar entitlement={entitlement} onLogout={logout} onPanel={setPanel} isAdmin={profile?.role === 'admin'} serviceStatus={serviceStatus} /><main className="workspace"><section className="stage"><div ref={stageRef} className={`subtitle-stage caption-${captionSize}${segments.length > 0 || running || sessionStatus === 'reconnecting' ? ' with-toolbar' : ''}`} aria-live="polite" aria-relevant="additions text" onScroll={onStageScroll}>{segments.length === 0 && sessionStatus === 'idle' && <div className="empty-state"><div className="empty-icon">◌</div><h2>{tr('准备好开始翻译')}</h2><p>{tr('选择语言并点击下方按钮，说话时字幕会实时出现在这里。')}</p></div>}{segments.length === 0 && sessionStatus === 'opening' && <div className="listening-indicator" role="status"><i />{tr('正在打开麦克风…')}<p>{tr('请允许浏览器使用麦克风，允许后即可开始说话。')}</p></div>}{segments.length === 0 && sessionStatus === 'connecting' && <div className="listening-indicator" role="status"><i />{tr('正在连接翻译…')}</div>}{segments.length === 0 && sessionStatus === 'reconnecting' && <div className="listening-indicator" role="status"><i />{tr('正在恢复…')}</div>}{segments.length > 0 && <div className="subtitle-spacer" />}{hiddenCaptions > 0 && <button type="button" className="earlier-captions" onClick={showEarlierCaptions}>{tr('更早的字幕')}</button>}{visibleCaptions.map((segment, index) => { const position = hiddenCaptions + index; const spoken = (segment.language ?? '').toLowerCase().split('-')[0]; const right = mode === 'two_way' && spoken && spoken === languageB.toLowerCase().split('-')[0]; const big = captionView === 'source' ? (segment.source || segment.translation) : (segment.translation || segment.source); const small = captionView === 'both' && segment.translation && segment.source ? segment.source : ''; const speakerName = segment.speaker ? speakerNames[segment.speaker] ?? `${tr('说话人')} ${segment.speaker}` : ''; const meta = [segment.language?.toUpperCase() ?? ''].filter(Boolean).join(' · '); return <article className={`subtitle-segment ${mode === 'two_way' ? 'chat-bubble' : ''} ${right ? 'right' : ''} ${position === segments.length - 1 ? 'current' : ''} ${segment.interim ? 'interim' : ''}`} key={segment.interim ? 'live' : `line-${position}`}>{speakerName && <button type="button" className="speaker-label speaker-rename" onClick={() => { setNamingSpeaker(segment.speaker ?? null); setSpeakerDraft(speakerNames[segment.speaker ?? ''] ?? segment.speaker ?? ''); }}>{speakerName}</button>}{meta && <span className="speaker-label">{meta}</span>}<div className="translation-line">{big || '…'}</div>{small && <div className="source-line">{small}</div>}</article>; })}{segments.length === 0 && running && <div className="listening-indicator" role="status"><i />{tr('正在聆听')}</div>}</div>{(segments.length > 0 || running || sessionStatus === 'reconnecting') && <div className="caption-toolbar"><span>{tr('字幕显示')}</span><button type="button" className={captionView === 'both' ? 'active' : ''} onClick={() => setCaptionView('both')}>{tr('双语')}</button><button type="button" className={captionView === 'translation' ? 'active' : ''} onClick={() => setCaptionView('translation')}>{tr('译文')}</button><button type="button" className={captionView === 'source' ? 'active' : ''} onClick={() => setCaptionView('source')}>{tr('原文')}</button><button type="button" onClick={() => void copyLive()}>{tr('复制字幕')}</button><button type="button" onClick={exportLive}>{tr('导出文本')}</button></div>}{namingSpeaker && <form className="speaker-rename-form" onSubmit={(event) => { event.preventDefault(); renameLiveSpeaker(); }}><label>{tr('改名为')}<input value={speakerDraft} onChange={(event) => setSpeakerDraft(event.target.value)} aria-label={tr('说话人名称')} /></label><button className="secondary-button" type="submit">{tr('保存')}</button><button type="button" className="secondary-button" onClick={() => setNamingSpeaker(null)}>{tr('取消')}</button></form>}{liveNotice && <p className="live-notice" role="status">{liveNotice}</p>}{showJump && <button type="button" className="jump-latest" onClick={jumpLatest}>{tr('回到最新')}</button>}</section><aside ref={dockRef} className={`control-dock ${dockOpen ? 'open' : 'collapsed'}`}>{dockOpen && <div className="dock-settings"><div className="dock-tabs"><button className={mode === 'one_way' ? 'active' : ''} onClick={() => !busySession && setMode('one_way')} disabled={busySession}>{tr('课堂模式')}</button><button className={mode === 'two_way' ? 'active' : ''} onClick={() => !busySession && setMode('two_way')} disabled={busySession}>{tr('对话模式')}</button></div><div className="language-row"><LanguageSelect label={tr('原语言')} value={languageA} options={languages} onChange={setLanguageA} disabled={busySession} /><span className="swap">{mode === 'one_way' ? '→' : '↔'}</span><LanguageSelect label={tr(mode === 'one_way' ? '翻译为' : '第二语言')} value={languageB} options={languages} onChange={setLanguageB} disabled={busySession} /></div>{sameLanguage && <p className="audio-hint">{tr('源语言和目标语言不能相同。')}</p>}<label className="audio-source"><span>{tr('选择术语库')}</span><select value={glossaryId} onChange={(event) => setGlossaryId(event.target.value)} disabled={busySession}><option value="">{tr('不使用术语库')}</option>{glossaryChoices.map((item) => <option value={item.id} key={item.id}>{glossaryOptionLabel(item)}</option>)}</select></label><label className="audio-source"><span>{tr('音频来源')}</span><select value={audioSource} onChange={(event) => setAudioSource(event.target.value as AudioSource)} disabled={busySession}><option value="microphone">{tr('麦克风')}</option><option value="system">{tr('系统声音 / 屏幕共享')}</option></select></label>{audioSource === 'microphone' && <label className="audio-source"><span>{tr('选择麦克风')}</span><select value={micId} onChange={(event) => setMicId(event.target.value)} disabled={busySession}><option value="">{tr('系统默认麦克风')}</option>{mics.map((mic) => <option value={mic.id} key={mic.id}>{mic.label}</option>)}</select></label>}{audioSource === 'system' && <p className="audio-hint">{tr('共享窗口时请勾选“共享声音”。')}</p>}{glossaryId && (glossaryUsed > 0 || !glossaryAligned || glossaryDropped > 0) && <p className="audio-hint">{glossaryUsed > 0 && <>{tr('本次会注入 {count} 条。').replace('{count}', String(glossaryUsed))} </>}{!glossaryAligned && <>{tr('这个术语库是 {glossary}，这场是 {session}。译法仍按词库方向注入。').replace('{glossary}', glossaryPairLabel).replace('{session}', sessionPairLabel)} </>}{glossaryDropped > 0 && <>{tr('有 {count} 条术语超出上限，本次不会注入。').replace('{count}', String(glossaryDropped))}{glossaryDroppedTerms.length ? ` ${glossaryDroppedTerms.slice(0, 6).join('、')}` : ''} {tr('可把必须使用的词标为优先。')}</>}</p>}<div className="stage-tools"><span>{tr('字号')}</span><button type="button" className={captionSize === 'sm' ? 'active' : ''} onClick={() => setCaptionSize('sm')}>{tr('小')}</button><button type="button" className={captionSize === 'md' ? 'active' : ''} onClick={() => setCaptionSize('md')}>{tr('中')}</button><button type="button" className={captionSize === 'lg' ? 'active' : ''} onClick={() => setCaptionSize('lg')}>{tr('大')}</button><button type="button" onClick={() => void toggleFullscreen()}>{fullscreen ? tr('退出全屏') : tr('全屏')}</button></div></div>}{showGuide && sessionStatus === 'idle' && !conflictSession && <FirstRun pair={currentLabel} plan={entitlement?.plan.toUpperCase() ?? 'FREE'} minutesLeft={entitlement ? (entitlement.remainingSeconds >= Number.MAX_SAFE_INTEGER / 2 ? tr('无限') : `${Math.ceil(entitlement.remainingSeconds / 60)} ${tr('分钟')}`) : '…'} onOpen={() => setDockOpen(true)} onDone={() => setShowGuide(false)} />}{conflictSession && sessionStatus === 'idle' && <div className="record-notice" role="status"><p>{tr('上一场翻译还在占用额度。')}</p><button type="button" className="primary-button" onClick={() => void resumeConflict()}>{tr('恢复这场')}</button><button type="button" className="secondary-button" onClick={() => void endConflict(false)}>{tr('结束上一场')}</button><button type="button" className="secondary-button" onClick={() => void endConflict(true)}>{tr('结束上一场并开始')}</button></div>}{!recordAck && recordAudio && sessionStatus === 'idle' && <div className="record-notice" role="status"><p>{tr('录音默认开启。本次语音会保存到你的字幕库，只有你可以回放和删除。如果不需要保存，请先关闭「保存本次语音」。')}</p><button type="button" className="secondary-button" onClick={() => { localStorage.setItem('linguaflow_record_ack', '1'); setRecordAck(true); }}>{tr('知道了')}</button></div>}{endedTranscriptId && sessionStatus === 'idle' && <div className="session-saved" role="status"><span>{tr('本次记录已保存。')}</span><button type="button" className="primary-button" onClick={() => { setFocusTranscriptId(endedTranscriptId); setPanel('transcripts'); }}>{tr('查看本次记录')}</button><button type="button" className="link-button" onClick={() => setEndedTranscriptId(null)}>{tr('关闭')}</button></div>}{running && remainingSeconds !== null && remainingSeconds <= 60 && <div className="error-banner time-warning-banner" role="status">{tr('本次会话即将结束，剩余')} {formatRemain(remainingSeconds)}</div>}{closePrompt && <form className="close-title" onSubmit={(event) => { event.preventDefault(); confirmClose(); }}><label>{tr('这场翻译的名称')}<input value={sessionTitle} onChange={(event) => setSessionTitle(event.target.value)} maxLength={120} placeholder={tr('可选，方便以后查找')} aria-label={tr('这场翻译的名称')} autoFocus /></label><button type="button" className="link-button" onClick={() => setClosePrompt(false)}>{tr('继续翻译')}</button></form>}{error && <div className="error-banner" role="alert">{error}</div>}<label className="audio-source session-title-field"><span>{tr('这场翻译的名称')}</span><input value={sessionTitle} onChange={(event) => setSessionTitle(event.target.value.slice(0, 120))} maxLength={120} placeholder={tr('可选，方便以后查找')} aria-label={tr('这场翻译的名称')} disabled={sessionStatus === 'stopping'} /></label><div className="dock-bar">{liveSessionId && <AudienceLink sessionId={liveSessionId} mode={mode} />}<button type="button" className="dock-toggle" onClick={() => setDockOpen((open) => !open)}>{dockOpen ? tr('收起') : tr('设置')}</button><label className="record-toggle" title={tr('保存本次语音')}><input type="checkbox" checked={recordAudio} onChange={(event) => setRecordAudio(event.target.checked)} disabled={busySession} aria-label={tr('保存本次语音')} /><span>{tr('保存本次语音')}</span></label>{running && <button type="button" className="dock-toggle" onClick={togglePause} title={tr('暂停收音，计时继续')}>{paused ? tr('继续收音') : tr('暂停收音')}</button>}{paused && <span className="audio-hint">{tr('暂停收音，计时继续')}</span>}<button className={`record-button ${running ? 'recording' : ''} ${sessionStatus === 'opening' || sessionStatus === 'connecting' || sessionStatus === 'reconnecting' ? 'arming' : ''}`} disabled={sessionStatus === 'stopping'} onClick={() => void (closePrompt ? confirmClose() : sessionStatus === 'idle' ? start() : requestClose())}><span>{running ? '■' : '●'}</span><span className="record-label">{sessionStatus === 'opening' ? tr('正在打开麦克风…') : sessionStatus === 'connecting' ? tr('连接中…') : sessionStatus === 'reconnecting' ? tr('正在恢复…') : sessionStatus === 'stopping' ? tr('结束中…') : closePrompt ? tr('保存并结束') : running ? tr('结束翻译') : tr('开始翻译')}</span></button><span className={`direction-badge${running && remainingSeconds !== null && remainingSeconds <= 60 ? ' time-warning' : ''}`}>{currentLabel}{running && remainingSeconds !== null ? ` · ${remainingSeconds <= 60 ? tr('即将结束') : tr('剩余')} ${formatRemain(remainingSeconds)}` : ''}</span></div>{dockOpen && <div className="dock-foot"><span>{tr('音频：')}{audioSource === 'system' ? tr('系统声音') : tr('麦克风')}</span><span>{entitlement ? `${PLANS[entitlement.plan].label} ${tr('额度')}` : ''}</span></div>}</aside></main>{panel === 'transcripts' && <TranscriptPanel focusId={focusTranscriptId} onClose={() => { setPanel('none'); setFocusTranscriptId(null); }} />}{panel === 'glossary' && <GlossaryPanel languageA={languageA} languageB={languageB} activeId={glossaryId} onActive={setGlossaryId} onList={setGlossaryChoices} onClose={() => setPanel('none')} />}{panel === 'pricing' && <PricingPanel entitlement={entitlement} onRefresh={() => api<Entitlement>('/v1/me/entitlement').then(setEntitlement)} onClose={() => setPanel('none')} />}{panel === 'admin' && <AdminPanel onClose={() => setPanel('none')} />}{panel === 'account' && <AccountPanel email={profile?.email ?? ''} displayName={profile?.displayName ?? ''} onProfile={() => void reloadProfile()} onClose={() => setPanel('none')} />}</div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
