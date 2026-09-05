# 企业微信智能机器人接入

## 形态

BankPilot 使用企业微信智能机器人 WebSocket 长连接。`workers/wecom.mjs` 是无状态渠道适配器：接收消息、调用 BankPilot 内部 API、渲染流式回复或模板卡片。它不持有数据库连接，也不能绕过 Bank Core。

```text
企业微信用户 ⇄ 官方 WebSocket ⇄ wecom worker ⇄ internal channel API ⇄ LangGraph / Bank Core
```

## 前置配置

在企业微信管理后台创建智能机器人，取得 Bot ID 和 Bot Secret。生成与其他密钥完全独立的适配令牌：

```bash
openssl rand -hex 32
```

将值分别写入部署机的 `deploy/.env.production`，不要写入仓库：

```env
BANKPILOT_PUBLIC_URL=https://bank.example.com
WECOM_ADAPTER_TOKEN=独立随机值
WECOM_BOT_ID=企业微信机器人ID
WECOM_BOT_SECRET=企业微信机器人Secret
```

`WECOM_ADAPTER_TOKEN` 同时提供给 `app` 和 `wecom` 容器；Bot ID/Secret 只提供给 `wecom`。

## 启动

```bash
docker compose --env-file deploy/.env.production \
  -f deploy/compose.production.yml --profile wecom up -d --build
```

未取得 Bot 凭据前不要启用 `wecom` profile。银行 PWA、内置 Agent 和 MCP 可独立运行。

## 用户流程

PWA 提供选择渠道、添加机器人、发送绑定、核对账户的引导。
管理员需配置真实机器人添加链接 `WECOM_BOT_ENTRY_URL`；详见 [接入引导](CHANNEL_ONBOARDING.md)。

1. 用户首次给机器人发消息，服务端生成一次性绑定 secret。
2. 用户打开链接并登录 BankPilot，确认将当前企业微信身份关联到账户。
3. 绿色查询直接回复。
4. 黄色操作先展示模板卡片，用户点击确认后 Bank Core 执行，LangGraph 恢复并通过 outbox 推送核验结果。
5. 红色操作仅提供 BankPilot 深链。用户必须回 APP 输入 TOTP，企业微信不能代验。
6. 用户可通过 `GET/DELETE /api/v1/channels` 查看或撤销绑定。

## 内部 API

以下端点只接受 `Authorization: Bearer <WECOM_ADAPTER_TOKEN>`，不应暴露给普通客户端使用：

- `POST /api/channels/wecom/message`
- `POST /api/channels/wecom/action`
- `POST /api/channels/wecom/outbox/claim`
- `POST /api/channels/wecom/outbox/ack`

反向代理可以进一步限制这些路径只允许容器内网访问。当前 Worker 使用 Compose 的 `bankpilot_internal` 内部网络访问 `http://app:3000`。

## 联调验收

- 同一个 `msgid` 重放两次，第二次返回 `DUPLICATE`，模型只调用一次。
- 未绑定用户只能收到 fragment 形式的 10 分钟绑定链接。
- 已绑定用户查余额，回复只能来自当前账户事实。
- 黄色操作点击取消，业务状态不改变且 run 进入 `CANCELLED`。
- 黄色操作重复点击确认，核心只执行一次。
- 红色操作点击确认，只收到 APP 强验证链接，渠道端不执行。
- 用另一个已绑定 userid 伪造同一 task/operation，必须返回拒绝。
- 临时停止 Worker 后完成操作，再启动 Worker，outbox 应补发最终结果。
