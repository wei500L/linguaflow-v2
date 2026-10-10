import { useEffect, useState } from 'react';
import { LANGUAGE_OPTIONS } from '@linguaflow/shared';
import { api, apiResponse } from './lib/api';
import { glossaryOptionLabel, languageNative, sameLanguageCode } from './lib/glossary';
import { tr } from './lib/i18n';
import { ListSkeleton, PanelShell } from './panel-shell';

export type GlossaryTerm = { id: string; source: string; target: string; pinned?: boolean };
export type Glossary = { id: string; name: string; languageA: string; languageB: string; terms?: GlossaryTerm[] };

function LanguagePairFields({ a, b, onA, onB }: { a: string; b: string; onA: (value: string) => void; onB: (value: string) => void }) {
  return <div className="term-row"><select value={a} onChange={(event) => onA(event.target.value)} aria-label={tr('原语言')}>{LANGUAGE_OPTIONS.map((option) => <option value={option.code} key={option.code}>{option.nativeName}</option>)}</select><span>→</span><select value={b} onChange={(event) => onB(event.target.value)} aria-label={tr('翻译为')}>{LANGUAGE_OPTIONS.map((option) => <option value={option.code} key={`b-${option.code}`}>{option.nativeName}</option>)}</select></div>;
}

export function GlossaryPanel({ onClose, languageA, languageB, activeId, onActive, onList }: { onClose: () => void; languageA: string; languageB: string; activeId: string; onActive: (id: string) => void; onList: (items: Glossary[]) => void }) {
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
  return <PanelShell title={tr('术语库')} onClose={onClose}><p className="panel-description">{tr('单向按当前会话方向注入。方向相反时会自动对调。双向会话会同时使用反向译法。')}</p><div className="glossary-switch"><select value={activeId} onChange={(event) => onActive(event.target.value)} aria-label={tr('选择术语库')}><option value="">{tr('不使用术语库')}</option>{items.map((item) => <option value={item.id} key={item.id}>{glossaryOptionLabel(item)}</option>)}</select></div><div className="term-form"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={tr('词库名称')} aria-label={tr('词库名称')} /><LanguagePairFields a={createLangA} b={createLangB} onA={setCreateLangA} onB={setCreateLangB} />{sameLanguageCode(createLangA, createLangB) && <p className="form-message" role="alert">{tr('源语言和目标语言不能相同。')}</p>}<button className="primary-button" onClick={() => void createGlossary()} disabled={saving || !name.trim() || sameLanguageCode(createLangA, createLangB)}>{tr('新建词库')}</button></div><div className="preset-groups"><div><p className="eyebrow">{tr('课程词库')}</p><p className="panel-description">{tr('每门课单独一份。点一次只新建这一门。')}</p><div className="list-item-actions"><button className="secondary-button" onClick={() => void usePreset('analysis')} disabled={saving}>{tr('数学分析词库')}</button><button className="secondary-button" onClick={() => void usePreset('algebra')} disabled={saving}>{tr('线性代数词库')}</button><button className="secondary-button" onClick={() => void usePreset('discrete')} disabled={saving}>{tr('离散数学词库')}</button><button className="secondary-button" onClick={() => void usePreset('pascal')} disabled={saving}>{tr('Pascal 词库')}</button><button className="secondary-button" onClick={() => void usePreset('practice')} disabled={saving}>{tr('计算机实践词库')}</button><button className="secondary-button" onClick={() => void usePreset('history')} disabled={saving}>{tr('历史词库')}</button><button className="secondary-button" onClick={() => void usePreset('safety')} disabled={saving}>{tr('生命安全词库')}</button></div></div><div><p className="eyebrow">{tr('通用词库')}</p><div className="list-item-actions"><button className="secondary-button" onClick={() => void usePreset('classroom')} disabled={saving}>{tr('课堂词库')}</button><button className="secondary-button" onClick={() => void usePreset('medical')} disabled={saving}>{tr('医学词库')}</button><button className="secondary-button" onClick={() => void usePreset('legal')} disabled={saving}>{tr('法律词库')}</button></div></div></div>{selected && <div className="term-form"><div className="term-row"><input value={source} onChange={(event) => setSource(event.target.value)} placeholder={languageNative(selected.languageA)} aria-label={tr('原文术语')} /><span>→</span><input value={target} onChange={(event) => setTarget(event.target.value)} placeholder={languageNative(selected.languageB)} aria-label={tr('指定译法')} /></div><button className="primary-button" onClick={() => void addTerm()} disabled={saving || !source.trim() || !target.trim()}>{saving ? tr('添加中…') : tr('添加术语')}</button></div>}{message && <div className="form-message success-message" role="status">{message}</div>}{error && <div className="form-message" role="alert">{error}</div>}<div className="panel-list">{loading && <ListSkeleton label={tr('正在加载术语库…')} />}{!loading && !items.length && <div className="panel-empty">{tr('还没有术语库。')}</div>}{selected && !selected.terms?.length && <div className="panel-empty">{tr('还没有词条。')}</div>}{orderedTerms.map((term) => <div className="panel-list-item" key={term.id}>{editingId === term.id ? <div className="term-edit"><input value={draftSource} onChange={(event) => setDraftSource(event.target.value)} aria-label={tr('原文术语')} /><span>→</span><input value={draftTarget} onChange={(event) => setDraftTarget(event.target.value)} aria-label={tr('指定译法')} /><button className="secondary-button" onClick={() => void saveTerm(term)} disabled={saving}>{tr('保存')}</button><button className="secondary-button" onClick={() => setEditingId(null)}>{tr('取消')}</button></div> : <div className="term-line"><span><strong>{term.pinned ? '★ ' : ''}{term.source}</strong><small>{term.target}</small></span><span className="list-item-actions"><button className="secondary-button" onClick={() => void pinTerm(term)}>{term.pinned ? tr('取消优先') : tr('优先')}</button><button className="secondary-button" onClick={() => { setEditingId(term.id); setDraftSource(term.source); setDraftTarget(term.target); }}>{tr('编辑')}</button><button className="danger-button" onClick={() => void removeTerm(term)}>{tr('删除词条')}</button></span></div>}</div>)}{selected && <div className="glossary-tools"><div className="term-form"><label>{tr('词库名称')}<input value={glossaryName} onChange={(event) => setGlossaryName(event.target.value)} /></label><div className="term-row"><LanguagePairFields a={langA} b={langB} onA={setLangA} onB={setLangB} /></div>{sameLanguageCode(langA, langB) && <p className="form-message" role="alert">{tr('源语言和目标语言不能相同。')}</p>}<div className="list-item-actions"><button className="secondary-button" onClick={() => void saveGlossary()} disabled={saving || sameLanguageCode(langA, langB)}>{tr('保存词库')}</button><button className="secondary-button" onClick={() => void exportTerms()}>{tr('导出术语')}</button><button className="danger-button" onClick={() => void removeGlossary(selected)}>{tr('删除')}</button></div></div><label>{tr('导入术语')}<textarea className="summary-editor" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={tr('每行一条，原文和译法用 Tab 分开。')} /></label><button className="secondary-button" onClick={() => void importTerms()} disabled={saving || !importText.trim()}>{tr('导入')}</button></div>}</div></PanelShell>;
}
