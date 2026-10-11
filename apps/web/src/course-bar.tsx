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

export function CourseBar({ disabled, languageA, languageB, recordAudio, glossaryId, onStart }: { disabled: boolean; languageA: string; languageB: string; recordAudio: boolean; glossaryId: string; onStart: (course: CoursePreset) => void }) {
  const [courses, setCourses] = useState<CoursePreset[]>([]);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'one_way' | 'two_way'>('one_way');
  const [keepAudio, setKeepAudio] = useState(recordAudio);
  const [glossary, setGlossary] = useState(glossaryId);
  const [template, setTemplate] = useState<'meeting' | 'classroom' | 'interview' | 'briefing'>('classroom');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLanguages, setEditLanguages] = useState<{ languageA: string; languageB: string } | null>(null);
  useEffect(() => { void api<CoursePreset[]>('/v1/courses').then(setCourses).catch(() => undefined); }, []);
  function beginEdit(course: CoursePreset) {
    setEditingId(course.id);
    setName(course.name);
    setMode(course.mode);
    setKeepAudio(course.recordAudio);
    setGlossary(course.glossaryId ?? '');
    setTemplate(course.summaryTemplate === 'meeting' || course.summaryTemplate === 'interview' || course.summaryTemplate === 'briefing' || course.summaryTemplate === 'classroom' ? course.summaryTemplate : 'classroom');
    setEditLanguages({ languageA: course.languageA, languageB: course.languageB });
  }
  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const body = { name: trimmed, languageA: editLanguages?.languageA ?? languageA, languageB: editLanguages?.languageB ?? languageB, mode, recordAudio: keepAudio, glossaryId: glossary || null, summaryTemplate: template };
    if (editingId) {
      const updated = await api<CoursePreset>(`/v1/courses/${editingId}`, { method: 'PATCH', body: JSON.stringify(body) });
      setCourses((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditingId(null);
      setEditLanguages(null);
      setName('');
      setNotice(tr('课程已更新。下次开始会使用这些设置。'));
      return;
    }
    const created = await api<CoursePreset>('/v1/courses', { method: 'POST', body: JSON.stringify(body) });
    setCourses((current) => [...current, created]);
    setName('');
    setNotice(tr('课程已保存。开始时会使用这门课的语言和课堂笔记。'));
  }
  return <section className="guide-card" aria-label={tr('课程')}>
    <p className="eyebrow">{tr('课程')}</p>
    {courses.length === 0 && <p>{tr('还没有课程。普通听课不需要先建课。')}</p>}
    {courses.map((course) => <div className="list-item-actions" key={course.id}><span>{course.name}</span><button type="button" className="secondary-button" disabled={disabled} onClick={() => onStart(course)}>{tr('用这门课开始')}</button><button type="button" className="link-button" onClick={() => beginEdit(course)}>{tr('修改课程')}</button></div>)}
    <div className="list-item-actions">
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder={tr('课程名称')} aria-label={tr('课程名称')} />
      <select value={mode} onChange={(event) => setMode(event.target.value === 'two_way' ? 'two_way' : 'one_way')} aria-label={tr('翻译方向')}><option value="one_way">{tr('课堂')}</option><option value="two_way">{tr('对话')}</option></select>
      <select value={template} onChange={(event) => setTemplate(event.target.value as typeof template)} aria-label={tr('笔记模板')}><option value="classroom">{tr('课堂笔记')}</option><option value="meeting">{tr('会议纪要')}</option><option value="interview">{tr('访谈')}</option><option value="briefing">{tr('简报')}</option></select>
      <label className="record-toggle"><input type="checkbox" checked={keepAudio} onChange={(event) => setKeepAudio(event.target.checked)} /><span>{tr('保存本次语音')}</span></label>
      <button type="button" className="link-button" onClick={() => void save()}>{editingId ? tr('保存修改') : tr('保存课程')}</button>
    </div>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
