# 外部 Agent 与 MCP 接入

## 1. 创建令牌

登录 BankPilot，打开“个人中心 → 连接外部 Agent”。填写 Agent 名称、勾选最小权限并用当前登录密码复核。原始令牌只展示一次，服务端只保存 SHA-256 摘要。

令牌格式为 `bpt_...`，有效期 30 天，可随时撤销。当前比赛版本采用用户签发的 personal access token；正式多租户开放平台应升级为 OAuth 2.1 + PKCE、动态客户端注册与 consent 页面。

## 2. MCP 连接

- Transport：Streamable HTTP
- Endpoint：`https://<bank-domain>/api/mcp`
- Header：`Authorization: Bearer <token>`
- Protocol SDK：`@modelcontextprotocol/sdk` 1.30

通用配置示例（不同 Agent 客户端字段名可能不同）：

```json
{
  "mcpServers": {
    "aibanking": {
      "type": "streamable-http",
      "url": "https://<bank-domain>/api/mcp",
      "headers": {
        "Authorization": "Bearer bpt_REPLACE_ME"
      }
    }
  }
}
```

浏览器来源默认只允许银行自身域名。需要网页 Agent 跨域访问时，在服务器 `MCP_ALLOWED_ORIGINS` 中配置精确来源；不使用通配符。

## 3. 工具与权限

| 工具 | Scope | 行为 |
|---|---|---|
| `banking.accounts.list` | `accounts:read` | 查询账户与可用余额 |
| `banking.transactions.list` | `transactions:read` | 查询真实流水 |
| `banking.beneficiaries.list` | `beneficiaries:read` | 查询已核验收款人 |
| `banking.cards.list` | `cards:read` | 查询卡片与开关 |
| `banking.subscriptions.list` | `subscriptions:read` | 查询已有订阅代扣 |
| `banking.investments.products.list` | `products:read` | 只返回带来源且已核验产品；否则空数组 |
| `banking.transfers.prepare` | `transfers:prepare` | 创建待授权草稿，不扣款 |
| `banking.operations.get` | `operations:read` | 查询操作状态 |

没有开放入金、转账执行、MFA、令牌管理、密码修改等 MCP 工具。即使外部 Agent 遭 Prompt Injection，也没有直接完成资金操作的能力。

## 4. 推荐 Agent 流程

1. 用 `accounts.list` 获取账户 ID，不猜测。
2. 收集完整收款人和金额，复述给用户。
3. 调用 `transfers.prepare`；获得 `AWAITING_AUTH` 和 `authorizationUrl`。
4. 明确告诉用户资金尚未转出，并引导打开授权链接。
5. 用户在银行 APP 完成确认/TOTP。
6. 用 `operations.get` 检查 `SUCCEEDED`，只在银行核心返回成功后宣告成功。

OpenAPI 描述可从 `/api/openapi` 获取。

## 5. Nanobot 可运行示例

[Nanobot 集成目录](../integrations/nanobot/README.md)包含固定版本依赖、原生配置示例、
银行 Skill、仅暴露银行工具的启动器和真实模型评测脚本。没有修改 Nanobot 源码，
也没有将银行授权交给 Skill。[评测报告](NANOBOT_EVALUATION.md)区分已跑通能力、
缺少的银行接口和未验证的多租户/IM 边界。
