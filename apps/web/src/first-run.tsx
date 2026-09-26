import { useEffect, useState } from 'react';
import { PLANS } from '@linguaflow/shared';
import { tr } from './lib/i18n';

export function FirstRun({ pair, plan, minutesLeft, onOpen, onDone }: { pair: string; plan: string; minutesLeft: string; onOpen: () => void; onDone: () => void }) {
  const [step, setStep] = useState(0);
  useEffect(() => { onOpen(); }, []);
  const freeMinutes = PLANS.free.monthlySeconds === null ? 0 : Math.round(PLANS.free.monthlySeconds / 60);
  const freeSession = Math.round(PLANS.free.maxSessionSeconds / 60);
  const steps = [
    tr('选好这场的两种语言。现在是 {pair}。课堂是一个人讲，对话是两边都说。').replace('{pair}', pair),
    tr('免费套餐每月 {free} 分钟，单次最长 {session} 分钟。你当前是 {plan}，现在可用 {left}。').replace('{free}', String(freeMinutes)).replace('{session}', String(freeSession)).replace('{plan}', plan).replace('{left}', minutesLeft),
    tr('点「开始翻译」，说大约一分钟。字幕会出现在上面。')
  ];
  function finish() {
    localStorage.setItem('linguaflow_seen_guide', '1');
    onDone();
  }
  return <section className="guide-card" aria-label={tr('开始之前')}>
    <p className="eyebrow">{tr('第 {step} 步，共 3 步').replace('{step}', String(step + 1))}</p>
    <p>{steps[step]}</p>
    <div className="list-item-actions">
      {step < 2 && <button type="button" className="primary-button" onClick={() => setStep((value) => value + 1)}>{tr('下一步')}</button>}
      {step === 2 && <button type="button" className="primary-button" onClick={finish}>{tr('知道了，我来试一分钟')}</button>}
      <button type="button" className="link-button" onClick={finish}>{tr('跳过')}</button>
    </div>
  </section>;
}
