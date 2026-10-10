import { useEffect, useState } from 'react';
import { REFERRAL } from '@linguaflow/shared';
import { api } from './lib/api';
import { tr } from './lib/i18n';
import { ListSkeleton, PanelShell } from './panel-shell';

type ReferralView = {
  code: string;
  link: string;
  limits: { pending: number; pendingCap: number; qualifiedThisMonth: number; monthlyCap: number; qualifiedLifetime: number; lifetimeCap: number };
  reward: { inviteeMinutes: number; inviterMinutes: number; qualifyMinutes: number };
  incoming: { status: string; expiresAt: string } | null;
  items: Array<{ id: string; status: string; email: string; createdAt: string; inviterGrantedSeconds: number }>;
};

type AdminReferral = {
  id: string;
  status: string;
  reason: string | null;
  inviteeEmailIdentity: string;
  signupIp: string | null;
  weakDevice: boolean;
  createdAt: string;
  inviterEmail: string | null;
};

const referralReasonText: Record<string, string> = {
  self_referral: '自己邀请自己',
  device_overlap: '同一台设备',
  disposable_email: '一次性邮箱',
  identity_used: '这个邮箱身份已用过',
  pending_full: '待完成已满',
  same_ip_burst: '同一网络邀请过多',
  inviter_velocity: '邀请过快',
  domain_burst: '同一域名过多',
  weak_device: '设备指纹较弱',
  inviter_monthly_capped: '月度上限',
  inviter_lifetime_capped: '终身上限',
  expired: '已过期',
  admin_rejected: '管理员拒绝',
  inviter_missing: '邀请人不存在'
};

function formatWhen(iso: string | null) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(document.documentElement.lang === 'en' ? 'en' : 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fill(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), tr(template));
}

function rewardDuration(minutes: number) {
  if (minutes > 0 && minutes % 60 === 0) return tr('{count} 小时').replace('{count}', String(minutes / 60));
  return tr('{count} 分钟').replace('{count}', String(minutes));
}

function rewardCopy(youMinutes = REFERRAL.inviterSeconds / 60, friendMinutes = REFERRAL.inviteeSeconds / 60) {
  return {
    qualify: REFERRAL.qualifySeconds / 60,
    you: rewardDuration(youMinutes),
    friend: rewardDuration(friendMinutes)
  };
}

function inviteStatusLabel(status: string, inviterGrantedSeconds = 0) {
  if (status === 'qualified' && inviterGrantedSeconds <= 0) return tr('已达奖励上限');
  if (status === 'qualified') return tr('已到账');
  if (status === 'expired') return tr('已过期');
  if (status === 'grant_due') return tr('待发放');
  if (status === 'pending' || status === 'held') return tr('待完成');
  return tr('未发放');
}

export function InviteWelcome({ code }: { code: string }) {
  return <div className="invite-welcome" role="status">
    <p className="eyebrow">{tr('朋友邀请')}</p>
    <strong>{code}</strong>
    <p>{fill('注册后完成一场至少 {qualify} 分钟的翻译，你获得 {friend}加时包，邀请人获得 {you}。', rewardCopy())}</p>
  </div>;
}

export function InviteEntry({ onOpen }: { onOpen: () => void }) {
  return <div className="redeem-box">
    <p className="eyebrow">INVITE</p>
    <h3>{tr('邀请朋友')}</h3>
    <p className="panel-description">{fill('朋友完成一场至少 {qualify} 分钟的翻译后，你获得 {you}加时包，朋友获得 {friend}。', rewardCopy())}</p>
    <button className="secondary-button" type="button" onClick={onOpen}>{tr('打开邀请页')}</button>
  </div>;
}

export function InvitePanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<ReferralView | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    void api<ReferralView>('/v1/me/referral').then(setData).catch((err) => setError(err instanceof Error ? err.message : tr('操作失败')));
  }, []);
  async function copy(value: string, success: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(success);
    } catch {
      setMessage(tr('当前浏览器不允许复制，请手动选择文本。'));
    }
  }
  const minutes = rewardCopy(data?.reward.inviterMinutes, data?.reward.inviteeMinutes);
  return <PanelShell title={tr('邀请朋友')} onClose={onClose} wide>
    {!data && !error && <ListSkeleton label={tr('正在加载邀请…')} />}
    {error && <div className="form-message" role="alert">{error}</div>}
    {data && <>
      {data.incoming && <div className="invite-welcome" role="status">
        <p className="eyebrow">{tr('你的邀请')}</p>
        <p>{fill('你的邀请奖励会在完成一场至少 {qualify} 分钟的翻译后发放，共 {friend}加时包。', minutes)}</p>
        <p className="panel-description">{fill('请在 {date} 前完成这场翻译。', { date: formatWhen(data.incoming.expiresAt) })}</p>
      </div>}
      <p className="panel-description">{fill('朋友用你的邀请注册，并完成一场至少 {qualify} 分钟的实时翻译。你获得 {you}加时包，朋友获得 {friend}。加时包不按月清零。', minutes)}</p>
      <ol className="invite-steps">
        <li><strong>{tr('发送链接')}</strong><span>{tr('朋友打开链接后，注册页会带上你的邀请码。')}</span></li>
        <li><strong>{tr('朋友注册')}</strong><span>{tr('邀请码可以改。留空就只是普通注册。')}</span></li>
        <li><strong>{tr('完成一场翻译')}</strong><span>{fill('一场至少 {qualify} 分钟，而且要在注册后 14 天内完成。', minutes)}</span></li>
      </ol>
      <div className="invite-share">
        <div>
          <p className="eyebrow">{tr('邀请码')}</p>
          <p className="invite-code">{data.code}</p>
        </div>
        <label>{tr('邀请链接')}<input readOnly value={data.link} aria-label={tr('邀请链接')} /></label>
        <div className="invite-actions">
          <button className="primary-button" type="button" onClick={() => void copy(data.link, tr('邀请链接已复制。'))}>{tr('复制邀请链接')}</button>
          <button className="secondary-button" type="button" onClick={() => void copy(data.code, tr('邀请码已复制。'))}>{tr('复制邀请码')}</button>
        </div>
        {message && <p className="panel-description" role="status">{message}</p>}
      </div>
      <div className="admin-stat-grid usage-grid">
        <div><small>{tr('待完成')}</small><strong>{data.limits.pending}/{data.limits.pendingCap}</strong></div>
        <div><small>{tr('本月已成功')}</small><strong>{data.limits.qualifiedThisMonth}/{data.limits.monthlyCap}</strong></div>
        <div><small>{tr('累计已成功')}</small><strong>{data.limits.qualifiedLifetime}/{data.limits.lifetimeCap}</strong></div>
        <div><small>{tr('你获得')}</small><strong>{rewardDuration(data.reward.inviterMinutes)}</strong></div>
      </div>
      <div className="usage-list">
        <h3>{tr('邀请记录')}</h3>
        {data.items.length === 0 && <div className="panel-empty">{tr('还没有邀请记录。')}</div>}
        <div className="panel-list">
          {data.items.map((item) => <div className="panel-list-item" key={item.id}>
            <span><strong>{item.email}</strong><small>{formatWhen(item.createdAt)}</small></span>
            <small>{inviteStatusLabel(item.status, item.inviterGrantedSeconds)}</small>
          </div>)}
        </div>
      </div>
    </>}
  </PanelShell>;
}

function adminStatus(status: string) {
  if (status === 'held') return tr('暂扣');
  if (status === 'grant_due') return tr('待发放');
  if (status === 'pending') return tr('待完成');
  if (status === 'qualified') return tr('已到账');
  if (status === 'expired') return tr('已过期');
  return tr('未发放');
}

export function ReferralReview() {
  const [heldOnly, setHeldOnly] = useState(false);
  const [items, setItems] = useState<AdminReferral[]>([]);
  const [error, setError] = useState('');
  async function load(held = heldOnly) {
    setItems(await api<AdminReferral[]>(held ? '/v1/admin/referrals?status=held' : '/v1/admin/referrals'));
  }
  useEffect(() => { void load(false).catch((err) => setError(err instanceof Error ? err.message : tr('操作失败'))); }, []);
  async function review(id: string, action: 'approve' | 'reject') {
    setError('');
    try {
      await api(`/v1/admin/referrals/${id}/${action}`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? tr(err.message) : tr('操作失败'));
    }
  }
  return <section className="invite-review">
    <div className="invite-review-head">
      <h3>{tr('邀请审核')}</h3>
      <button className="secondary-button" type="button" onClick={() => { const next = !heldOnly; setHeldOnly(next); void load(next).catch((err) => setError(err instanceof Error ? err.message : tr('操作失败'))); }}>{heldOnly ? tr('全部邀请') : tr('只看暂扣')}</button>
    </div>
    {error && <div className="form-message" role="alert">{error}</div>}
    {items.length === 0 && <p className="panel-description">{tr('还没有邀请。')}</p>}
    <div className="panel-list">
      {items.map((item) => <div className="panel-list-item" key={item.id}>
        <span>
          <strong>{item.inviteeEmailIdentity}</strong>
          <small>{item.inviterEmail ?? tr('已注销账户')} · {adminStatus(item.status)}{item.reason ? ` · ${tr(referralReasonText[item.reason] ?? item.reason)}` : ''}{item.signupIp ? ` · ${item.signupIp}` : ''}{item.weakDevice ? ` · ${tr('设备指纹较弱')}` : ''} · {formatWhen(item.createdAt)}</small>
        </span>
        <span className="list-item-actions">
          {item.status === 'held' && <button className="secondary-button" type="button" onClick={() => void review(item.id, 'approve')}>{tr('通过')}</button>}
          {item.status !== 'rejected' && item.status !== 'expired' && <button className="danger-button" type="button" onClick={() => void review(item.id, 'reject')}>{tr('拒绝')}</button>}
        </span>
      </div>)}
    </div>
  </section>;
}
