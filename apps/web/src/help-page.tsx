import { useState } from 'react';
import { api } from './lib/api';
import { tr, useLang } from './lib/i18n';
import { LanguageToggle } from './language-toggle';
import { ThemeToggle } from './theme-toggle';

const topics = [
  ['麦克风权限', '开始翻译时浏览器会询问麦克风。权限必须由你点击触发。拒绝后，到浏览器的站点设置里改为允许，再试一次。'],
  ['没有声音', '先看音量条。如果几乎没有输入，换一个麦克风，或把声源靠近。安静环境不会被当成内容丢失。'],
  ['系统声音', '共享屏幕或窗口时要勾选共享声音。有的窗口本身没有声音，这时请改用麦克风。支持这个接口，也不代表每个窗口都有声音。'],
  ['断网和锁屏', '短时间断网会尝试重连，并重放还在缓冲里的声音。超过缓冲后，丢掉的片段会标成缺口。手机锁屏或切到后台时，系统可能暂停收音；这和你点的暂停不是同一件事。暂停收音时，计时仍会继续。'],
  ['模型和费用', '更新笔记前会显示预计消耗。平台模型按现有分钟规则计费。自备密钥不扣平台分钟，模型服务可能自行收费。只保存字幕修改不会自动生成，也不会扣量。'],
  ['分享', '个人听课不会自动创建听众链接。你打开分享时，课后记录和录音默认关闭。关掉二维码只是收起面板。撤销链接、到期、删除和注销都会停止访问。'],
  ['免费额度', '同一台设备不能重复领取免费额度。同一个网络地址本身不会把两个不同设备判成同一个人。如果被拒绝，可以在下面申请核查。']
] as const;

export function HelpPage() {
  useLang();
  const [category, setCategory] = useState<'audio' | 'network' | 'quota' | 'sharing' | 'notes' | 'account' | 'other'>('other');
  const [body, setBody] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [includeDiag, setIncludeDiag] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const diagnostics = { language: navigator.language, online: String(navigator.onLine), viewport: `${window.innerWidth}x${window.innerHeight}` };
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setMessage('');
    try {
      await api('/v1/support', { method: 'POST', body: JSON.stringify({ kind: category === 'account' ? 'free_review' : 'feedback', category, body, sessionId: sessionId.trim() || undefined, diagnostics: includeDiag ? diagnostics : undefined }) });
      setBody('');
      setMessage(tr('已提交。处理状态会显示在你的申请里，不会自动发邮件。'));
    } catch (err) { setError(err instanceof Error ? err.message : tr('操作失败')); }
  }
  return <main className="marketing-page legal-page">
    <nav className="marketing-nav">
      <a className="wordmark" href="/"><span className="brand-mark small">L</span><strong>LinguaFlow</strong></a>
      <div className="marketing-nav-actions">
        <ThemeToggle />
        <LanguageToggle />
        <a href="/">{tr('打开工作区')}</a>
      </div>
    </nav>
    <article className="legal-card">
      <h1>{tr('帮助')}</h1>
      {topics.map(([title, text]) => <section key={title}><h2>{tr(title)}</h2><p>{tr(text)}</p></section>)}
      <h2>{tr('反馈')}</h2>
      <p>{tr('默认不上传字幕、录音或密钥。诊断信息只有你勾选后才会提交，而且只包含下面这几项。')}</p>
      <form className="term-form" onSubmit={(event) => void submit(event)}>
        <label>{tr('分类')}<select value={category} onChange={(event) => setCategory(event.target.value as typeof category)}><option value="audio">{tr('收音')}</option><option value="network">{tr('网络')}</option><option value="quota">{tr('额度')}</option><option value="sharing">{tr('分享')}</option><option value="notes">{tr('笔记')}</option><option value="account">{tr('免费资格核查')}</option><option value="other">{tr('其他')}</option></select></label>
        <label>{tr('发生了什么')}<textarea value={body} onChange={(event) => setBody(event.target.value)} required maxLength={2000} rows={4} /></label>
        <label>{tr('相关会话编号，可选')}<input value={sessionId} onChange={(event) => setSessionId(event.target.value)} /></label>
        <label className="record-toggle"><input type="checkbox" checked={includeDiag} onChange={(event) => setIncludeDiag(event.target.checked)} /><span>{tr('附带诊断信息')}</span></label>
        {includeDiag && <pre className="panel-description">{JSON.stringify(diagnostics, null, 2)}</pre>}
        <button className="primary-button" type="submit">{tr('提交反馈')}</button>
      </form>
      {message && <p role="status">{message}</p>}
      {error && <p className="form-message" role="alert">{error}</p>}
    </article>
  </main>;
}
