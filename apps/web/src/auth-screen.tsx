import { useEffect, useRef, useState } from 'react';
import { api, setToken } from './lib/api';
import { captureInvite, clearInvite } from './lib/invite';
import { tr } from './lib/i18n';
import { InviteWelcome } from './invite-panel';
import { LanguageToggle } from './language-toggle';
import { ThemeToggle } from './theme-toggle';

export function authFailure(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'Invalid credentials') return tr('邮箱或密码不正确。');
  if (message === 'Too many login attempts') return tr('尝试次数过多，请 15 分钟后再试。');
  if (message === 'Too many registration attempts' || message === 'Too many attempts') return tr('注册尝试过多，请一小时后再试。');
  if (message === 'Invalid verification code') return tr('验证码不正确。');
  if (message === 'Account not found') return tr('找不到这个账户。');
  if (message === 'Email already registered') return tr('这个邮箱已经注册过了。');
  if (message === 'Check the email and password, then try again' || message.includes('Invalid email') || message.startsWith('[')) return tr('邮箱格式不正确，请检查空格后重试。');
  if (message === 'Load failed' || message === 'Failed to fetch' || message === 'NetworkError when attempting to fetch resource.') return tr('网络中断了，请再试一次。');
  return message ? tr(message) : tr('操作失败');
}

export function AuthScreen({ onLogin }: { onLogin: () => void }) {
  const inviteDefault = useRef(captureInvite());
  const [mode, setMode] = useState<'login' | 'register' | 'code_login' | 'reset'>(inviteDefault.current ? 'register' : 'login');
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const [cooldown, setCooldown] = useState(0); const [showPassword, setShowPassword] = useState(false);
  const formRef = useRef<HTMLFormElement>(null); const codeInput = useRef<HTMLInputElement>(null); const messageRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (cooldown <= 0) return; const timer = window.setTimeout(() => setCooldown(cooldown - 1), 1000); return () => window.clearTimeout(timer); }, [cooldown]);
  useEffect(() => { if (message) messageRef.current?.scrollIntoView({ block: 'nearest' }); }, [message]);
  /* Inputs stay uncontrolled. A phone password manager fills the DOM without a
     React onChange, and the next render was wiping that value before submit. */
  function credentials() {
    const data = new FormData(formRef.current ?? undefined);
    return {
      email: String(data.get('email') ?? '').replace(/\s+/g, ''),
      password: String(data.get('password') ?? '').trim(),
      code: String(data.get('code') ?? '').trim(),
      invite: String(data.get('invite') ?? '').trim()
    };
  }
  async function sendVerificationCode() {
    const { email } = credentials();
    if (!email) { setMessage(tr('请先填写邮箱。')); return; }
    const path = mode === 'register' ? '/v1/auth/email/register/code' : mode === 'reset' ? '/v1/auth/email/password-reset/code' : '/v1/auth/email/login/code';
    await api(path, { method: 'POST', body: JSON.stringify({ email }) });
    setCooldown(60); setMessage(tr('如果这个邮箱可以接收验证码，我们已发送。请查收邮箱。')); codeInput.current?.focus();
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { email, password, code, invite } = credentials();
    if (!email) { setMessage(tr('请先填写邮箱。')); return; }
    if (mode !== 'code_login' && password.length < 8) { setMessage(tr('密码至少 8 位。')); return; }
    if ((mode === 'code_login' || mode === 'reset') && code.length < 6) { setMessage(tr('请填写 6 位验证码。')); return; }
    setBusy(true); setMessage('');
    try {
      if (mode === 'register') {
        if (!code) { await sendVerificationCode(); return; }
        const result = await api<{ token: string }>('/v1/auth/email/register', { method: 'POST', body: JSON.stringify({ email, password, code, inviteCode: invite || undefined }) });
        clearInvite(); setToken(result.token); onLogin();
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
    } catch (error) { setMessage(authFailure(error)); } finally { setBusy(false); }
  }
  return <main className="auth-layout"><section className="auth-pitch"><div className="brand-mark">L</div><p className="eyebrow">LINGUAFLOW</p><h1>{tr('让每一次对话，')}<br /><em>{tr('自然地抵达')}</em></h1><p>{tr('实时语音识别、翻译与字幕记录，适用于会议、课堂和跨语言交流。')}</p><div className="demo-card"><span>ZH · 00:18</span><strong>{tr('欢迎来到 LinguaFlow')}</strong><small>Welcome to LinguaFlow</small></div></section><form ref={(node) => { formRef.current = node; if (node) node.noValidate = true; }} key={mode} className="auth-card" onSubmit={submit}><div className="auth-card-header"><div className="menu-row"><ThemeToggle /><LanguageToggle className="secondary-button" /></div><h2>{mode === 'register' ? tr('创建账户') : mode === 'reset' ? tr('重置密码') : tr('登录 LinguaFlow')}</h2><p>{tr('继续使用你的实时翻译工作区')}</p></div>{mode === 'register' && inviteDefault.current && <InviteWelcome code={inviteDefault.current} />}<label>{tr('邮箱')}<input name="email" type="email" required placeholder="you@example.com" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" inputMode="email" /></label>{mode !== 'code_login' && <label>{mode === 'reset' ? tr('新密码') : tr('密码')}<span className="password-field"><input name="password" type={showPassword ? 'text' : 'password'} required minLength={8} placeholder={tr('至少 8 位字符')} autoComplete={mode === 'reset' || mode === 'register' ? 'new-password' : 'current-password'} autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go" /><button type="button" className="password-toggle" aria-label={showPassword ? tr('隐藏密码') : tr('显示密码')} onClick={() => setShowPassword((value) => !value)}>{showPassword ? tr('隐藏') : tr('显示')}</button></span></label>}{mode === 'register' && <label>{tr('邀请码')}<input name="invite" defaultValue={inviteDefault.current} placeholder={tr('选填')} autoCapitalize="characters" autoCorrect="off" spellCheck={false} /></label>}{mode !== 'login' && <label>{tr('验证码')}<input ref={codeInput} name="code" inputMode="numeric" placeholder={tr('邮箱验证码')} required={mode !== 'register'} autoComplete="one-time-code" enterKeyHint="go" /></label>}{mode !== 'login' && <button type="button" className="link-button" disabled={cooldown > 0 || busy} onClick={() => void sendVerificationCode().catch((error) => setMessage(authFailure(error)))}>{cooldown > 0 ? `${cooldown} ${tr('秒后重发')}` : tr('发送验证码')}</button>}{message && <div ref={messageRef} className="form-message" role="alert">{message}</div>}<button className="primary-button auth-submit" type="submit" disabled={busy}>{busy ? tr('处理中…') : mode === 'login' ? tr('登录') : mode === 'register' ? tr('完成注册') : mode === 'reset' ? tr('重置密码') : tr('验证码登录')}</button><div className="auth-links"><button type="button" className="link-button" onClick={() => { setMode('code_login'); setMessage(''); }}>{tr('验证码登录')}</button><button type="button" className="link-button" onClick={() => { setMode('reset'); setMessage(''); }}>{tr('忘记密码')}</button><button type="button" className="link-button" onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setMessage(''); }}>{mode === 'register' ? tr('返回登录') : tr('创建账户')}</button></div><p className="auth-legal"><a href="/privacy">{tr('隐私政策')}</a><a href="/terms">{tr('服务条款')}</a></p></form></main>;
}
