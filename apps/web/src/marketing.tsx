import { PLANS } from '@linguaflow/shared';
import { tr, useLang } from './lib/i18n';
import { LanguageToggle } from './language-toggle';
import { ThemeToggle } from './theme-toggle';

const scenes = [
  ['会议', '把会议上的话实时变成双语字幕，结束后可以导出字幕。纪要需要平台模型或自备密钥。'],
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
      '实时音频会送到 Soniox 做识别和翻译。笔记会按你的选择送到平台模型或你保存的模型地址。这里不承诺供应商的保留期限、数据区域或零留存。',
      '账户里会保存字幕、术语、课程设置和你打开录音后的音频。设备标识和 IP 用于限速和免费额度风控；同一个注册 IP 不会单独判定两个不同设备是同一个人。',
      '听众链接和课后分享只在你主动打开时创建。课后记录和录音默认关闭。撤销、到期、删除进回收站或注销账户后，链接不能再访问。',
      '普通删除会进入 7 天回收站，分享立即失效。你也可以立刻彻底删除。注销账户会永久删除内容，不会延长保留。',
      '套餐通过激活码开通。这个应用不在页面里收款，也没有配置销售联系方式时不会显示假的付款渠道。'
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
        <ThemeToggle />
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
        {scenes.map(([title, body]) => <article key={title}><h2>{tr(title)}</h2><p>{tr(body)}</p></article>)}
      </div>
    </section>
    <section className="marketing-section">
      <p className="eyebrow">{tr('示例')}</p>
      <div className="demo-card marketing-demo"><span>RU · 00:18</span><strong>{tr('我们把发布时间定在周五。')}</strong><small>We will ship this on Friday.</small></div>
    </section>
    <section className="marketing-section">
      <p className="eyebrow">{tr('了解套餐')}</p>
      <h2>{tr('实时字幕相同，时长不同')}</h2>
      <p className="marketing-note">{tr('四个套餐都能使用实时字幕、术语库、录音和导出。差别是每月分钟和单次时长。纪要需要平台模型，或在账户里保存自己的密钥。')}</p>
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
        <ThemeToggle />
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
