# 系统架构

## 设计原则

BankPilot 将“会聊天的模型”和“能改变资金状态的银行核心”严格分开。LLM 只能提出结构化意图与计划；确定性的策略引擎决定风险；只有银行核心能在数据库事务中执行操作。

```text
PWA ─ Session ─────────┐
QQ / 企业微信 ─ Worker ├─ LangGraph Runtime ── intent nodes ── interrupt()
                       │         │                         │
外部 Agent ─ MCP ──────┘         │ checkpoints             │ resume
                               ▼                         ▼
                         PostgreSQL ◀──── Policy + Authorization Gateway
                               ▲                  │ confirm / TOTP
                               │                  ▼
                               └──────────── Bank Core ─ double-entry ledger
```

## 关键组件

### PWA

Next.js App Router + React。支持注册、登录、账户、流水、入金、转账、卡片、安全中心、开发者中心和 Agent 对话。所有写请求使用 HttpOnly SameSite Cookie，并校验 Origin。

### LangGraph Agent Runtime

每个请求创建独立的 LangGraph run，并把 checkpoint 写入 PostgreSQL 的 `langgraph` schema；checkpoint 表由版本化迁移预先创建，不在客户请求中动态执行 DDL。规划节点调用真实模型，随后路由到余额、账单、订阅、转账或卡片节点。只读任务直接结束；写任务在 `authorization_gate` 调用 `interrupt()`，持久化后等待用户确认。授权完成后用同一 `graph_thread_id` 恢复，并从 Bank Core 重读最终状态，再生成回复。

模型采用两次受约束调用：第一次输出通过 Zod 校验的意图、实体和步骤；银行工具返回事实后，第二次只能根据 `BANK_FACTS` 生成说明。模型不能生成 SQL、调用任意 URL 或直接提交账本。重复授权由 runtime 原子抢占，只有一个请求能从 `INTERRUPTED` 进入 `RUNNING`。

### Nanobot APP 体验入口

PWA 另提供独立 Nanobot 模式，通过私有 Python supervisor 启动原版 Nanobot 子进程，
不经过 LangGraph 意图路由。`nanobot_consents` 保存用户授权，`nanobot_runs` 保存幂等
运行与公开对话；每次运行签发短时 MCP 令牌并关联银行工具审计。授权执行仍回银行 APP。
此模式是定向体验，不代表已有生产级每租户容器或 IM 托管，详见 [托管边界](NANOBOT_HOSTING.md)。

### 腾讯消息 Channel Adapters（原版助手）

两个独立 Node.js Worker 分别使用 QQ 和企业微信官方 SDK 建立 WebSocket 长连接。Worker 不接触数据库，只使用各自的内部适配令牌调用渠道 API；Bot Secret 不会进入 Next.js 或浏览器。首次会话发放 10 分钟一次性绑定链接，渠道 openid/userid 加密保存并以 HMAC 摘要索引。

绿色任务直接回复；黄色任务使用原生按钮确认；红色任务只发送银行 APP 深链，由银行会话和 TOTP 完成。消息按平台事件 ID 去重，异步结果经按渠道隔离的事务 outbox 重试投递。QQ 群聊不进入银行 Agent，只引导用户转到 C2C 私聊，避免账户信息在群内暴露。

### MCP / REST Adapter

MCP 使用官方 TypeScript SDK 的 Streamable HTTP transport。每次请求按令牌 scope 动态注册工具。REST 与 MCP 都调用同一个 `bank-core.ts`，不复制业务规则。

### Policy + Authorization

- GREEN：余额、流水、账单分析、卡片/订阅/理财查询，可自动执行。
- YELLOW：小额转账、虚拟卡申请、锁卡，先展示完整单据并获得明确确认。
- RED：日累计转账超过 ¥1,000 或设备/行为风险规则升级，要求 TOTP 动态码。

模型提供的风险等级不被信任。策略裁决写入 `policy_decisions`，授权凭证绑定操作编号且 10 分钟过期。

### Bank Core 与 PostgreSQL

金额统一使用人民币分的整数。转账在单一数据库事务中锁定付款与收款账户，检查余额，写入一条账本交易和金额和为零的借贷分录，再同步账户快照和用户流水。失败则整体回滚。

关键数据域：

- 身份：`customers`、`auth_credentials`、`user_sessions`、`mfa_totp`
- 银行业务：`accounts`、`beneficiaries`、`transfers`、`cards`、`subscriptions`
- 账本：`ledger_transactions`、`ledger_entries`、`bank_transactions`
- Agent：`agent_tasks`、`task_nodes`、`policy_decisions`
- Agent Runtime：`agent_threads`、`agent_runtime_runs`、`langgraph.*`
- 渠道：`channel_identities`、`channel_binding_tokens`、`channel_events`、`channel_outbox`
- 外部接入：`api_clients`、`api_tokens`、`mcp_invocations`
- 审计：`audit_events`

## 数据真实性边界

这里的“真实”指系统不种入虚构业务记录：客户由本人注册，余额由本人声明入金或系统内转账产生，卡片由本人申请。它仍是比赛沙箱，不连接央行清算、银联或真实商业银行核心，因此不能承载真实货币。

理财产品没有可靠来源就保持空表。未来可增加经过许可的数据采集任务，并强制保存 `source_url`、发布时间、核验时间和原始事实。
