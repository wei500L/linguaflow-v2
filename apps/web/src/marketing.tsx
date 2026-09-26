import { PLANS } from '@linguaflow/shared';
import { tr, useLang } from './lib/i18n';
import { LanguageToggle } from './language-toggle';

const scenes = [
  ['会议', '把会议上的话实时变成双语字幕，结束后导出纪要。'],
  ['课堂', '老师讲一种语言，学生看着自己的语言。'],
  ['跨语言对话', '两个人各说各的语言，字幕分列两边。']
] as const;

const planFit = {
  free: '适合先试一次短对话。',
  plus: '适合课堂和两小时以内的会议。',
  pro: '适合半天讲座和连续会议。',
  ultra: '适合全天活动。每月分钟不限，单次最长 12 小时。'
} as const;

const legal = {
  privacy: {
    title: '隐私政策',
    paragraphs: [
      'LinguaFlow 会保存你的账户、字幕和术语库。录音开关默认打开时，这场语音也会保存在你的账户里，只有你可以回放和删除。',
      '分享链接会把这条字幕给任何拿到链接的人。你可以选择是否附带录音，也可以随时撤销，或在创建时设置过期时间。',
      '生成纪要时，请求从 LinguaFlow 服务器发往你保存的模型地址；如果你选择平台模型，则发往平台配置的地址。',
      '你可以在账户里导出字幕和术语库，或注销账户。注销会删除字幕、录音和术语库。',
      '套餐通过激活码开通。这个应用不在页面里收款。'
    ]
  },
  terms: {
    title: '服务条款',
    paragraphs: [
      'LinguaFlow 提供会议、课堂和跨语言对话的实时双语字幕。一场会话的长度受剩余分钟和套餐单次上限限制。',
      '你需要为录下的对话和发出的分享链接负责。不要处理你无权使用的内容。',
      '额度用完、连接中断、单次时长到达，或管理员终止会话时，翻译会结束。断线后有一小段时间可以在原来的页面恢复。',
      '激活码可能设有兑换次数和有效期。用完或过期后不能再兑换。',
      '字幕和纪要可能出错。服务按当前可用的状态提供。'
    ]
  }
} as const;

function minutes(seconds: number | null) {
  if (seconds === null) return tr('无限');
  return `${Math.round(seconds / 60)} ${tr('分钟/月')}`;
}

export function MarketingPage() {
  useLang();
  return <main className="marketing-page">
    <nav className="marketing-nav">
      <div className="wordmark"><span className="brand-mark small">L</span><strong>LinguaFlow</strong></div>
      <div className="marketing-nav-actions">
        <a href="/privacy">{tr('隐私政策')}</a>
        <a href="/terms">{tr('服务条款')}</a>
        <LanguageToggle />
        <a className="primary-button marketing-nav-cta" href="/">{tr('打开工作区')}</a>
      </div>
    </nav>
    <section className="marketing-hero">
      <p className="eyebrow">{tr('实时双语翻译')}</p>
      <h1>{tr('让每一次对话，自然地抵达。')}</h1>
      <p>{tr('LinguaFlow 将语音实时转换为双语字幕，适用于会议、课堂和跨语言交流。')}</p>
      <a className="primary-button marketing-cta" href="/">{tr('打开工作区')} →</a>
      <small>{tr('录音默认只保存在你的账户里。分享链接由你创建，也可以随时撤销。')}</small>
    </section>
    <section className="marketing-section">
      <div className="scene-grid">
        {scenes.map(([title, body]) => <article key={title}><p className="eyebrow">{tr(title)}</p><h2>{tr(title)}</h2><p>{tr(body)}</p></article>)}
      </div>
    </section>
    <section className="marketing-section">
      <p className="eyebrow">{tr('示例')}</p>
      <div className="demo-card marketing-demo"><span>RU · 00:18</span><strong>{tr('我们把发布时间定在周五。')}</strong><small>We will ship this on Friday.</small></div>
    </section>
    <section className="marketing-section">
      <p className="eyebrow">{tr('了解套餐')}</p>
      <h2>{tr('功能相同，时长不同')}</h2>
      <p className="marketing-note">{tr('四个套餐都能使用实时字幕、术语库、录音、导出和纪要。差别是每月分钟和单次时长。')}</p>
      <p className="marketing-note">{tr('不能在应用内购买。拿到激活码后，在工作区里兑换。')}</p>
      <div className="plan-grid marketing-plans">
        {(Object.keys(PLANS) as Array<keyof typeof PLANS>).map((plan) => <article className="plan-card" key={plan}><p>{PLANS[plan].label}</p><strong>{minutes(PLANS[plan].monthlySeconds)}</strong><small>{tr('单次最多')} {Math.round(PLANS[plan].maxSessionSeconds / 60)} {tr('分钟')}</small><small>{tr(planFit[plan])}</small></article>)}
      </div>
    </section>
    <footer className="marketing-footer">
      <a href="/privacy">{tr('查看隐私政策')}</a>
      <a href="/terms">{tr('服务条款')}</a>
    </footer>
  </main>;
}

export function LegalPage({ kind }: { kind: 'privacy' | 'terms' }) {
  useLang();
  const page = legal[kind];
  return <main className="marketing-page legal-page">
    <nav className="marketing-nav">
      <a className="wordmark" href="/"><span className="brand-mark small">L</span><strong>LinguaFlow</strong></a>
      <div className="marketing-nav-actions">
        <LanguageToggle />
        <a href="/">{tr('打开工作区')}</a>
      </div>
    </nav>
    <article className="legal-card">
      <h1>{tr(page.title)}</h1>
      {page.paragraphs.map((paragraph) => <p key={paragraph}>{tr(paragraph)}</p>)}
    </article>
  </main>;
}
