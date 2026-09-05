# QQ 官方机器人接入

## 形态

BankPilot 使用腾讯官方 `@tencent-connect/qqbot-nodejs` SDK 连接 QQ 开放平台 WebSocket Gateway。`workers/qq.mjs` 是无状态适配器：它只收发 QQ 消息并调用 BankPilot 内部 API，不连接数据库，也不能跳过 Bank Core。

```text
QQ 私聊用户 ⇄ QQ Open Platform ⇄ qq worker ⇄ internal channel API ⇄ LangGraph / Bank Core
```

官方资料：[QQ Bot Node.js SDK](https://github.com/tencent-connect/qqbot-nodejs) · [SDK 使用指南](https://github.com/tencent-connect/qqbot-nodejs/blob/main/USAGE.md)

## 开放平台配置

1. 在 QQ 开放平台注册机器人，先使用平台沙箱测试，取得 AppID 与 AppSecret。
2. 按控制台要求配置消息事件权限；Worker 通过 Gateway 接收 C2C、群消息和按钮交互事件。
3. 若控制台要求 IP 白名单，填入部署机固定出口 IP。
4. 生成独立内部适配令牌：`openssl rand -hex 32`。

将凭据只写入部署机的 `deploy/.env.production`，不要发到聊天、前端或 GitHub：

```env
BANKPILOT_PUBLIC_URL=https://bank.example.com
QQ_ADAPTER_TOKEN=独立随机值
QQBOT_APP_ID=QQ开放平台AppID
QQBOT_APP_SECRET=QQ开放平台AppSecret
```

`QQ_ADAPTER_TOKEN` 同时提供给 `app` 和 `qq` 容器；AppSecret 只提供给 `qq` Worker。

## 启动

```bash
docker compose --env-file deploy/.env.production \
  -f deploy/compose.production.yml --profile qq up -d --build qq
```

未取得 AppID/AppSecret 前不要启用 `qq` profile。PWA、内置 Agent、数据库与 MCP 不受影响。

## 用户流程与安全边界

1. 群消息不进入 Agent，不查询账户，只提示用户私聊机器人。
2. QQ 私聊首次消息生成 10 分钟一次性绑定链接；secret 位于 URL fragment，不进入服务器访问日志。
3. 用户打开链接并登录 BankPilot，亲自确认绑定 QQ openid。
4. 绿色查询直接回复；黄色操作显示 QQ 原生确认/取消按钮。
5. 红色操作始终回 BankPilot 完成 TOTP，QQ 端不能代验。
6. 按钮点击者的 openid、task ID、operation ID 与原绑定身份必须全部匹配。
7. 结果通过按渠道隔离的 outbox 投递，重启 Worker 后仍可补发。

Worker 使用每用户限流和按用户串行队列。同一消息 ID 或交互 ID 重放时，银行侧只处理一次。

## 内部 API

以下端点只接受 `Authorization: Bearer <QQ_ADAPTER_TOKEN>`，并通过 Compose 内网访问：

- `POST /api/channels/qq/message`
- `POST /api/channels/qq/action`
- `POST /api/channels/qq/outbox/claim`
- `POST /api/channels/qq/outbox/ack`

## 联调验收

- 群聊发“查余额”只收到私聊提示，审计台不产生 Agent 任务。
- 未绑定 openid 只能收到一次性绑定链接。
- 已绑定用户查余额，回复来自当前客户的 Bank Core 事实。
- 黄色按钮取消不改变业务；重复点击不重复执行。
- 另一个 openid 点击同一按钮必须被拒绝。
- 红色转账只返回 APP 强验证链接；TOTP 成功后 QQ 收到最终结果。
- 停止 Worker 后完成操作，再启动时 outbox 补发且只由 QQ Worker 领取。
