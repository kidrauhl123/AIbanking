# AIbanking / BankPilot

BankPilot 是为“银行 AI 智能体”赛题构建的可运行 PWA 沙箱银行。它采用“双入口、单内核”架构：银行 APP 内置官方 AI 助手；外部 Agent 可通过受控 MCP 或 REST API 接入。两类 Agent 都不能绕过身份、策略、授权和账本层。

项目不预置客户、余额、卡片、交易、订阅或理财产品。每位测试者自行注册，账户从 `¥0.00` 开始；数据只由入金、转账、开卡等已认证操作产生。

## 已实现能力

- 多用户注册、登录、数据库会话、登录失败锁定和严格数据隔离
- 用户主动入金、注册用户间转账、原子双分录账本和幂等操作编号
- 绿色查询、黄色明确确认、红色 TOTP 多因素认证和三次失败熔断
- 虚拟卡申请、卡片锁定、真实流水与基于已有流水的账单分析
- 官方内置 Agent：LangGraph 持久化状态机、大模型结构化意图、可中断 DAG、事实落地回复
- 腾讯渠道：QQ 官方机器人与企业微信长连接、一次性账户绑定、黄色按钮确认、红色回 APP 强验证
- 外部 Agent：Streamable HTTP MCP、逐令牌 scope、30 天有效期、撤销和调用审计
- 开发者接入中心、安全中心、用户审计台和 PWA 安装能力
- 理财产品表只接受带原始来源和核验时间的记录；无可靠数据时返回空数组

## 为什么保留两种 Agent 形态

内置 Agent 是比赛的主体验，团队控制模型提示、对话状态、任务规划和授权交互。QQ 与企业微信复用同一 Agent Runtime，外部 Agent 接口则用于证明银行能力可被 Claude、ChatGPT、自研 Agent 等安全复用。所有入口共用 `Bank Core`，不存在多套余额或多套风控逻辑。

外部 Agent 的安全边界：

1. 用户登录银行 APP，在“个人中心 → 连接外部 Agent”中创建最小权限令牌。
2. Agent 连接 `https://<你的域名>/api/mcp`，使用 `Authorization: Bearer bpt_...`。
3. MCP 服务器只注册令牌 scope 允许的工具。
4. `banking.transfers.prepare` 只创建草稿并返回 `authorizationUrl`，不会扣款。
5. 用户回到银行 APP 完成黄色确认或红色 TOTP；账本成功后 Agent 再查询状态。

更完整的工具、客户端配置和威胁边界见 [MCP 接入文档](docs/MCP.md)。

下一阶段正在验证“原版 Nanobot + 银行 MCP + Skill”，优先复用现成 Agent，
业务权限仍由银行内核执行。已有[可运行集成与评测脚本](integrations/nanobot/README.md)，
能力与缺口见 [Nanobot 评测报告](docs/NANOBOT_EVALUATION.md)。这是独立验证，
APP 现已提供独立的 Nanobot 体验入口，部署与边界见 [Nanobot 托管说明](docs/NANOBOT_HOSTING.md)。
原版助手仍用 LangGraph；多用户 IM 托管尚未完成。

## 本地运行

要求 Node.js 22、PostgreSQL 17 和 `docker-compose`。

```bash
cp .env.example .env.local
# 为 PASSWORD_PEPPER 生成独立随机值，例如：openssl rand -hex 32
npm install
npm run db:setup
npm run dev
```

打开 `http://localhost:3000`。首次运行没有任何业务数据，请注册两个不同用户，用其中一个入金，再通过姓名或手机号向另一个用户转账。

数据库迁移由 `schema_migrations` 记录，每个文件只执行一次。`002_identity_and_platform.sql` 会在旧原型首次升级时清除旧版预置数据；已升级环境不会再次执行。

QQ 与企业微信机器人均为可选独立进程。接入方式见 [QQ 接入文档](docs/QQ.md)和[企业微信接入文档](docs/WECOM.md)。

## AI 配置

内置 Agent 只在以下变量全部存在时启用：

```env
AI_BASE_URL=https://your-openai-compatible-provider.example/v1
AI_API_KEY=...
AI_MODEL=...
AI_TIMEOUT_MS=30000
```

未配置模型时，界面明确显示“真实 AI 模型未配置”，服务端返回错误；不会用关键词匹配或写死回复伪装 AI。

## 验证

```bash
npm run build
npm test
npm run lint
npm run db:verify
```

`db:verify` 检查账本平衡、客户余额非负、操作编号唯一、客户凭据完整和系统账户归属。

## 文档

- [系统架构](docs/ARCHITECTURE.md)
- [MCP 与外部 Agent 接入](docs/MCP.md)
- [Nanobot 接入与运行](integrations/nanobot/README.md)
- [Nanobot 六类场景评测与缺口](docs/NANOBOT_EVALUATION.md)
- [企业微信智能机器人接入](docs/WECOM.md)
- [QQ 官方机器人接入](docs/QQ.md)
- [安全设计与已知风险](docs/SECURITY.md)
- [部署说明](docs/DEPLOYMENT.md)
- [验收脚本](docs/DEMO_SCRIPT.md)

公开仓库：[kidrauhl123/AIbanking](https://github.com/kidrauhl123/AIbanking)
