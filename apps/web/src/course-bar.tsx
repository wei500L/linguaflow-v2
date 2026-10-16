import { useEffect, useState } from 'react';
import { api } from './lib/api';
import { tr } from './lib/i18n';

export type CoursePreset = {
  id: string;
  name: string;
  languageA: string;
  languageB: string;
  mode: 'one_way' | 'two_way';
  glossaryId: string | null;
  recordAudio: boolean;
  summaryTemplate: string;
  titlePattern: string | null;
};

type GlossaryChoice = { id: string; name: string; languageA: string; languageB: string };

export function CourseBar({ disabled, languageA, languageB, recordAudio, glossaryId, onStart }: { disabled: boolean; languageA: string; languageB: string; recordAudio: boolean; glossaryId: string; onStart: (course: CoursePreset) => void }) {
  const [courses, setCourses] = useState<CoursePreset[]>([]);
  const [glossaries, setGlossaries] = useState<GlossaryChoice[]>([]);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'one_way' | 'two_way'>('one_way');
  const [keepAudio, setKeepAudio] = useState(recordAudio);
  const [glossary, setGlossary] = useState(glossaryId);
  const [langA, setLangA] = useState(languageA);
  const [langB, setLangB] = useState(languageB);
  const [template, setTemplate] = useState<'meeting' | 'classroom' | 'interview' | 'briefing'>('classroom');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => {
    void api<CoursePreset[]>('/v1/courses').then(setCourses).catch(() => undefined);
    void api<GlossaryChoice[]>('/v1/me/glossaries').then(setGlossaries).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (editingId) return;
    setGlossary(glossaryId);
    setLangA(languageA);
    setLangB(languageB);
    setKeepAudio(recordAudio);
  }, [glossaryId, languageA, languageB, recordAudio, editingId]);
  function beginEdit(course: CoursePreset) {
    setEditingId(course.id);
    setName(course.name);
    setMode(course.mode);
    setKeepAudio(course.recordAudio);
    setGlossary(course.glossaryId ?? '');
    setLangA(course.languageA);
    setLangB(course.languageB);
    setTemplate(course.summaryTemplate === 'meeting' || course.summaryTemplate === 'interview' || course.summaryTemplate === 'briefing' || course.summaryTemplate === 'classroom' ? course.summaryTemplate : 'classroom');
    setNotice('');
    setError('');
  }
  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError('');
    const body = { name: trimmed, languageA: langA.trim() || languageA, languageB: langB.trim() || languageB, mode, recordAudio: keepAudio, glossaryId: glossary || null, summaryTemplate: template };
    try {
      if (editingId) {
        const updated = await api<CoursePreset>(`/v1/courses/${editingId}`, { method: 'PATCH', body: JSON.stringify(body) });
        setCourses((current) => current.map((item) => item.id === updated.id ? updated : item));
        setEditingId(null);
        setName('');
        setNotice(tr('课程已更新。下次开始会使用这些设置。'));
        return;
      }
      const created = await api<CoursePreset>('/v1/courses', { method: 'POST', body: JSON.stringify(body) });
      setCourses((current) => [...current, created]);
      setName('');
      setNotice(tr('课程已保存。开始时会使用这门课的语言和课堂笔记。'));
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('操作失败'));
    }
  }
  const glossaryLabel = glossaries.find((item) => item.id === glossary)?.name ?? tr('不使用术语库');
  return <section className="guide-card" aria-label={tr('课程')}>
    <p className="eyebrow">{tr('课程')}</p>
    {courses.length === 0 && <p>{tr('还没有课程。普通听课不需要先建课。')}</p>}
    {courses.map((course) => <div className="list-item-actions" key={course.id}><span>{course.name} · {course.languageA} {course.mode === 'two_way' ? '↔' : '→'} {course.languageB}</span><button type="button" className="secondary-button" disabled={disabled} onClick={() => onStart(course)}>{tr('用这门课开始')}</button><button type="button" className="link-button" onClick={() => beginEdit(course)}>{tr('修改课程')}</button></div>)}
    <div className="list-item-actions">
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder={tr('课程名称')} aria-label={tr('课程名称')} />
      <input value={langA} onChange={(event) => setLangA(event.target.value)} aria-label={tr('源语言')} />
      <input value={langB} onChange={(event) => setLangB(event.target.value)} aria-label={tr('目标语言')} />
      <select value={mode} onChange={(event) => setMode(event.target.value === 'two_way' ? 'two_way' : 'one_way')} aria-label={tr('翻译方向')}><option value="one_way">{tr('课堂')}</option><option value="two_way">{tr('对话')}</option></select>
      <select value={template} onChange={(event) => setTemplate(event.target.value as typeof template)} aria-label={tr('笔记模板')}><option value="classroom">{tr('课堂笔记')}</option><option value="meeting">{tr('会议纪要')}</option><option value="interview">{tr('访谈')}</option><option value="briefing">{tr('简报')}</option></select>
      <select value={glossary} onChange={(event) => setGlossary(event.target.value)} aria-label={tr('术语库')}><option value="">{tr('不使用术语库')}</option>{glossaries.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>
      <label className="record-toggle"><input type="checkbox" checked={keepAudio} onChange={(event) => setKeepAudio(event.target.checked)} /><span>{tr('保存本次语音')}</span></label>
      <button type="button" className="link-button" onClick={() => void save()}>{editingId ? tr('保存修改') : tr('保存课程')}</button>
    </div>
    <p className="provider-note">{tr('当前术语库')}：{glossaryLabel}</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p className="form-message" role="alert">{error}</p>}
  </section>;
}
