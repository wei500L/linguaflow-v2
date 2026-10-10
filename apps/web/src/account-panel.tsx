import { useEffect, useState } from 'react';
import { api, apiResponse, clearToken, setToken } from './lib/api';
import { formatDuration } from './format';
import { tr } from './lib/i18n';
import { PanelShell } from './panel-shell';

export function AccountPanel({ onClose, email, displayName, onProfile }: { onClose: () => void; email: string; displayName: string; onProfile: () => void }) {
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
      const result = await api<{ token?: string }>('/v1/me/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
      if (result.token) setToken(result.token);
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
