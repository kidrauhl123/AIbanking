# 系统架构

## 设计原则

BankPilot 将“会聊天的模型”和“能改变资金状态的银行核心”严格分开。LLM 只能提出结构化意图与计划；确定性的策略引擎决定风险；只有银行核心能在数据库事务中执行操作。

```text
PWA / 第三方 Agent
        │
        ├── APP Session ── Embedded Agent Orchestrator ─┐
        │                                               │
        └── Scoped Bearer ── MCP / REST Adapter ────────┤
                                                        ▼
                    Policy + Authorization Gateway
                         │               │
                    TOTP / Confirm       │ Audit events
                         ▼               ▼
                  Bank Core Service ─ PostgreSQL
                         │          accounts / cards / operations
                         └────────── double-entry ledger
```

## 关键组件

### PWA

Next.js App Router + React。支持注册、登录、账户、流水、入金、转账、卡片、安全中心、开发者中心和 Agent 对话。所有写请求使用 HttpOnly SameSite Cookie，并校验 Origin。

### Embedded Agent Orchestrator

采用两次受约束的模型调用：第一次输出通过 Zod 校验的意图、实体和步骤；银行工具返回事实后，第二次只能根据 `BANK_FACTS` 生成说明。模型不能生成 SQL、调用任意 URL 或直接提交账本。

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
- 外部接入：`api_clients`、`api_tokens`、`mcp_invocations`
- 审计：`audit_events`

## 数据真实性边界

这里的“真实”指系统不种入虚构业务记录：客户由本人注册，余额由本人声明入金或系统内转账产生，卡片由本人申请。它仍是比赛沙箱，不连接央行清算、银联或真实商业银行核心，因此不能承载真实货币。

理财产品没有可靠来源就保持空表。未来可增加经过许可的数据采集任务，并强制保存 `source_url`、发布时间、核验时间和原始事实。
