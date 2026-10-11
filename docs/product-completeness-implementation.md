# 产品完整度实现记录

审查基线：`5fae1c1102514b8c4eca9d302d740e991ef5c4d8`。实现以当前分支为准，没有回退到该提交。

本轮是单进程实时服务。恢复只处理心跳已过期、且本进程没有活房间的会话，避免把另一台仍在心跳的实例关掉。部署如果扩成多进程，必须继续使用 `owner_instance_id` 和 `owner_heartbeat_at`，不能按“只要未结束就全部结算”。

| 编号 | 现状（基线） | 实现 | 验证 | 状态 |
| --- | --- | --- | --- | --- |
| PM-01 | final token 只在内存，结束时才入库 | 约 4 秒检查点写入 `session_token_chunks` 和草稿记录；启动时按过期心跳恢复；WAV 按实际 PCM 修复；结算用 `active_until`，不用清理时刻 | `product-rules.test.ts` 计费、恢复判断、段落 ID、SIGKILL 后的 WAV | 已实现 |
| PM-02 | `userStop` 丢弃尾部事件，并固定等满 8 秒 | 结束阶段仍接收 transcript/finished/error/save_status；完成后查询会话；失败不报成功 | `acceptLiveEvent` 与前端 `finishStop` | 已实现 |
| PM-03 | classroom 以外的模板被改成 meeting | `summarize` 保留四个模板，分段和合并都带各自结构 | `meeting.test.ts` 断言四套系统提示 | 已实现 |
| PM-04 | 保存字幕会隐式刷新模型 | 只标记 stale；报价后带幂等键才生成；失败释放预占；人工版本用 `note_epoch` 挡住迟到结果 | `summaryRefreshAction`、`quoteMatches` | 已实现 |
| PM-05 | 同一注册 IP 可单独拒绝免费账户 | IP claim 仍写入，但不再单独拦截；设备和受限域名仍拦截 | `device.test.ts` | 已实现 |
| PM-06 | 导出用 `createdAt` 当开始时间 | 使用会话开始/结束；未知就写未知；时区只接受合法 IANA，否则标 UTC；one_way 用箭头，two_way 用双向 | `buildMeetingMarkdown` | 已实现 |
| PM-07 | 丢音频和暂停没有区分 | 暂停、系统挂起、队列溢出写入 gap；短重放不造缺口；安静或延迟本身不算丢失 | `shouldRecordReconnectGap`、`captureLossFromSignals` | 已实现 |
| PM-08 | 引导没有收音测试 | 可跳过的本地音量测试，不创建 Soniox 会话 | 引导组件 | 已实现。未在真机验证锁屏 |
| PM-09 | 总结输入偏向译文，引用不可校验 | 输入含原文、译文和 segment id；未知引用和危险链接被去掉；公式失败保留原文 | `sanitizeModelMarkdown`、`renderMathPlain` | 已实现。未用真实模型测质量 |
| PM-10 | 课堂模式自动创建听众链接 | 默认个人使用；课后记录和录音默认关；关面板不撤销 | 会话创建 `shareIntent=personal`，分享接口 `keepAfter` | 已实现 |
| PM-11 | 没有课程和课堂标记 | 课程预设进入创建请求；重点/没听懂/作业立即落库；搜索走服务端 | 课程与标记接口 | 已实现 |
| PM-12 | 删除是硬删除，笔记没有版本 | 7 天回收站，可立即彻底删除；恢复不恢复分享；笔记版本可恢复且不扣量 | `purgeDue`、`sharesRevivedOnRestore` | 已实现 |
| PM-13 | 没有应用内反馈 | `/help` 与 `/v1/support`；诊断默认不上传；管理员可改状态 | 支持接口限速与归属校验 | 已实现 |
| PM-14 | 激活码仍在，没有申请入口 | 申请只落库，不自动发码，不编造联系方式；90 分钟示例来自现有 `PLANS` | `classCoverage` | 已实现 |
| PM-15 | 没有产品事件 | `product_events` 去重；管理员指标空数据为「暂无数据」；事件失败不影响主流程 | `summarizeProductMetrics`、`sanitizeEventProps` | 已实现 |

## 迁移

`apps/api/drizzle/0012_product_completeness_round.sql` 只加表和可空/有默认值的列。旧字幕仍可阅读。已经开着且未撤销的听众链接会把 `audience_keep_after` 设为 true，避免升级后静默收掉课后访问。新会话默认关闭。

降级：先停写新功能，再删新表。降级前应导出 `note_versions`、`support_requests` 和未过期回收站，否则这些新数据会留在不再被旧代码读取的表里。不要在生产库上手动清数据。

## 未在本环境执行

- 没有连接生产库，也没有对生产数据做迁移。本机 5432 在接受连接，但没有 `linguaflow` 角色，也没有项目 `.env`，所以空库升级没有实际执行。
- 没有真实 Soniox 或真实总结模型。模板测试使用假的模型响应。
- 没有 iPhone 真机。锁屏、来电打断不能靠桌面浏览器下结论。
- 浏览器打开了帮助页、隐私页和登录页，并在 390×844 看过登录页。没有可用账户，所以没有走完开课、结束、分享、版本和回收站。
