# LinguaFlow

LinguaFlow 是一个 SecTrans 风格的实时双语语音翻译工作区：React/Vite 前端负责音频采集和字幕展示，Fastify 后端负责认证、额度、字幕、术语库和 Soniox WebSocket 代理。

## 本地开发

```bash
cp .env.example .env
pnpm install
pnpm --filter @linguaflow/api db:generate
pnpm --filter @linguaflow/api db:migrate
pnpm dev
```

开发环境没有 SMTP 配置时，验证码会输出到 API 日志。生产栈必须把 `NODE_ENV` 设为 `production`（`docker-compose.prod.yml` 会设置），并且配置 SMTP 和 `SONIOX_API_KEY`。SMTP、`JWT_SECRET` 或 `ADMIN_EMAIL` 缺失时，API 会拒绝启动，不会使用开发用的固定密钥，也不会把验证码打进日志。

会话录音写到 `RECORDINGS_DIR`（默认 `data/recordings`）。装有 ffmpeg 时会转成 64 kbps MP3，否则保留 WAV。PDF 导出需要中文字体，用 `PDF_FONT_PATH` 指向一个 TTF/OTF；Docker 镜像会自带 Noto Sans SC。总结模型在字幕库里按用户保存，请求由 API 服务器发出，所以地址必须是服务器能访问的公网 `https`，或本机开发时的 `http://127.0.0.1`。

默认地址：

- Web：http://localhost:5173
- API：http://localhost:3000
- 健康检查：http://localhost:3000/health

## Docker

本机安装 Docker 后执行：

```bash
cp .env.example .env
docker compose up --build
```

前端通过 Nginx 代理 `/v1/*` 和 `/v1/realtime/ws` 到 API；API 会按会话创建时锁定的套餐单次上限主动关闭 WebSocket。

## 当前实现

- 邮箱密码注册和登录、邮箱验证码登录
- JWT Bearer 认证
- Free / Plus / Pro / Ultra 套餐额度
- 套餐优先、加时包后备的服务端计量
- 麦克风 PCM16 16kHz AudioWorklet
- one-way 课堂模式和 two-way 对话模式
- Soniox WebSocket 代理和 keepalive/stop 控制帧
- 自动保存字幕、会议记录（Markdown / PDF / TXT / SRT / VTT）和会话录音
- 用户自备 OpenAI 兼容模型，生成会议纪要或课堂笔记
- 自定义术语库和 Soniox translation terms 注入
- 激活码兑换与管理员批量生成
- SecTrans 风格响应式界面、移动端控制坞和 reduced-motion 降级

## 开发约定

- 本目录与旧的 `live` 项目完全隔离。
- Soniox API key、数据库密码和生产密钥只通过环境变量提供，不提交到 Git。
- `apps/api/drizzle` 保存数据库迁移。快照基线是最新一条迁移。修改 schema 后重新运行 `pnpm --filter @linguaflow/api db:generate`，并确认新 SQL 只包含这次的差异。
- `0012_product_completeness_round.sql` 增加检查点、课程、笔记版本、回收站、反馈和产品事件。它只加列和表。实时恢复按实例心跳判断，当前部署是单进程；心跳仍新鲜的会话不会被另一个进程关掉。
