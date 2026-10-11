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

export function CourseBar({ disabled, languageA, languageB, onStart }: { disabled: boolean; languageA: string; languageB: string; onStart: (course: CoursePreset) => void }) {
  const [courses, setCourses] = useState<CoursePreset[]>([]);
  const [name, setName] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { void api<CoursePreset[]>('/v1/courses').then(setCourses).catch(() => undefined); }, []);
  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const created = await api<CoursePreset>('/v1/courses', { method: 'POST', body: JSON.stringify({ name: trimmed, languageA, languageB, mode: 'one_way', summaryTemplate: 'classroom' }) });
    setCourses((current) => [...current, created]);
    setName('');
    setNotice(tr('课程已保存。开始时会使用这门课的语言和课堂笔记。'));
  }
  return <section className="guide-card" aria-label={tr('课程')}>
    <p className="eyebrow">{tr('课程')}</p>
    {courses.length === 0 && <p>{tr('还没有课程。普通听课不需要先建课。')}</p>}
    {courses.map((course) => <div className="list-item-actions" key={course.id}><span>{course.name}</span><button type="button" className="secondary-button" disabled={disabled} onClick={() => onStart(course)}>{tr('用这门课开始')}</button></div>)}
    <div className="list-item-actions">
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder={tr('课程名称')} aria-label={tr('课程名称')} />
      <button type="button" className="link-button" onClick={() => void create()}>{tr('保存课程')}</button>
    </div>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
