import { useEffect, useRef, useState } from 'react';
import { PLANS } from '@linguaflow/shared';
import { tr } from './lib/i18n';

export function FirstRun({ pair, plan, minutesLeft, onOpen, onDone }: { pair: string; plan: string; minutesLeft: string; onOpen: () => void; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [level, setLevel] = useState(0);
  const [probe, setProbe] = useState('');
  const stopProbe = useRef<(() => void) | null>(null);
  useEffect(() => { onOpen(); }, []);
  useEffect(() => () => stopProbe.current?.(), []);
  const freeMinutes = PLANS.free.monthlySeconds === null ? 0 : Math.round(PLANS.free.monthlySeconds / 60);
  const freeSession = Math.round(PLANS.free.maxSessionSeconds / 60);
  const steps = [
    tr('选好这场的两种语言。现在是 {pair}。课堂是一个人讲，对话是两边都说。').replace('{pair}', pair),
    tr('免费套餐每月 {free} 分钟，单次最长 {session} 分钟。你当前是 {plan}，现在可用 {left}。').replace('{free}', String(freeMinutes)).replace('{session}', String(freeSession)).replace('{plan}', plan).replace('{left}', minutesLeft),
    tr('允许麦克风，或在共享窗口时勾选共享声音。锁屏和切到后台可能暂停收音。你主动暂停时，计时仍会继续。这是示例字幕，不是真实识别：我们把发布时间定在周五。'),
    tr('可以做一次收音测试。它只在这台设备上看音量，不会创建翻译会话，也不会扣额度。')
  ];
  function finish() {
    stopProbe.current?.();
    localStorage.setItem('linguaflow_seen_guide', '1');
    onDone();
  }
  async function testMic() {
    stopProbe.current?.();
    setProbe('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let frame = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) { const sample = (value - 128) / 128; sum += sample * sample; }
        const rms = Math.sqrt(sum / data.length);
        setLevel(rms);
        setProbe(rms < 0.02 ? tr('几乎没有输入。靠近声源，或检查麦克风。') : tr('已经收到声音。'));
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      stopProbe.current = () => { cancelAnimationFrame(frame); stream.getTracks().forEach((track) => track.stop()); void context.close(); };
    } catch { setProbe(tr('没有获得麦克风权限。测试已取消。')); }
  }
  return <section className="guide-card" aria-label={tr('开始之前')}>
    <p className="eyebrow">{tr('第 {step} 步，共 4 步').replace('{step}', String(step + 1))}</p>
    <p>{steps[step]}</p>
    {step === 2 && <p className="panel-description">{typeof navigator.mediaDevices?.getDisplayMedia === 'function' ? tr('这台浏览器可以请求系统声音，但不是每个窗口都有声音。') : tr('这台浏览器不能采集系统声音，请使用麦克风。')}</p>}
    {step === 3 && <>
      <button type="button" className="secondary-button" onClick={() => void testMic()}>{tr('测试麦克风')}</button>
      <meter min={0} max={0.2} value={Math.min(level, 0.2)} aria-label={tr('输入音量')} />
      {probe && <p role="status">{probe}</p>}
    </>}
    <div className="list-item-actions">
      {step < 3 && <button type="button" className="primary-button" onClick={() => { stopProbe.current?.(); setStep((value) => value + 1); }}>{tr('下一步')}</button>}
      {step === 3 && <button type="button" className="primary-button" onClick={finish}>{tr('知道了，我来试一分钟')}</button>}
      <button type="button" className="link-button" onClick={finish}>{tr('跳过')}</button>
    </div>
  </section>;
}
