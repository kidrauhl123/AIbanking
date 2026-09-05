# CONTABO-jp 部署

## 拓扑

- 代码目录：`/opt/bankpilot`
- Compose：`deploy/compose.production.yml`
- 应用容器：`bankpilot-app`，512 MB / 1 CPU
- PostgreSQL：`bankpilot-postgres`，512 MB / 0.75 CPU
- 企业微信适配器：可选 profile，`bankpilot-wecom`，256 MB / 0.5 CPU
- QQ 适配器：可选 profile，`bankpilot-qq`，256 MB / 0.5 CPU
- 数据卷：`bankpilot_postgres`
- 边缘代理：现有 Caddy，经 `premsir-chat_backend` 网络访问应用
- 数据库：只在 `bankpilot_internal` 内部网络可达，不发布主机端口

该资源配额适合 4–5 人的比赛测试。生产域名应放在 Cloudflare 代理或 Tunnel 后，公开仓库不记录源站 IP。

## 首次配置

```bash
cp deploy/.env.production.example deploy/.env.production
openssl rand -hex 32   # 写入 POSTGRES_PASSWORD
openssl rand -hex 32   # 写入 PASSWORD_PEPPER；部署后不得随意更换
```

AI 变量为空时，银行基础功能正常工作，内置助手明确显示未配置且不会输出替代回复。

必须设置 `BANKPILOT_PUBLIC_URL` 为用户实际访问的 HTTPS 域名。机器人变量在取得平台凭据前可留空，此时不要启用对应 profile。

## 发布

本机同步代码：

```bash
rsync -az \
  --exclude node_modules \
  --exclude .next \
  --exclude .env.local \
  --exclude deploy/.env.production \
  --exclude .playwright-cli \
  ./ CONTABO-jp:/opt/bankpilot/
```

服务器先启动数据库、执行尚未应用的迁移，再构建应用：

```bash
ssh CONTABO-jp 'cd /opt/bankpilot && \
  docker compose --env-file deploy/.env.production -f deploy/compose.production.yml up -d postgres --wait && \
  bash scripts/migrate.sh --env-file deploy/.env.production -f deploy/compose.production.yml && \
  docker compose --env-file deploy/.env.production -f deploy/compose.production.yml up -d --build app --wait'
```

取得企业微信机器人凭据后单独启用渠道 Worker：

```bash
ssh CONTABO-jp 'cd /opt/bankpilot && \
  docker compose --env-file deploy/.env.production -f deploy/compose.production.yml \
  --profile wecom up -d --build wecom'
```

取得 QQ 机器人 AppID 与 AppSecret 后启用 QQ Worker：

```bash
ssh CONTABO-jp 'cd /opt/bankpilot && \
  docker compose --env-file deploy/.env.production -f deploy/compose.production.yml \
  --profile qq up -d --build qq'
```

迁移表 `schema_migrations` 保证 SQL 每版只执行一次。旧原型第一次应用 `002_identity_and_platform.sql` 时会删除旧版预置业务数据；之后绝不会因再次部署而重跑。

## 检查

```bash
ssh CONTABO-jp 'cd /opt/bankpilot && \
  docker compose --env-file deploy/.env.production -f deploy/compose.production.yml ps && \
  docker stats --no-stream bankpilot-app bankpilot-postgres'
```

```bash
ssh CONTABO-jp 'cd /opt/bankpilot && \
  docker compose --env-file deploy/.env.production -f deploy/compose.production.yml exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U bankpilot -d bankpilot < db/invariants.sql'
```

## 备份与恢复

上线多人测试前备份：

```bash
ssh CONTABO-jp 'docker exec bankpilot-postgres pg_dump -U bankpilot -d bankpilot -Fc' > bankpilot.dump
```

没有“恢复演示数据”命令，因为项目不再维护任何预置业务数据。需要清理测试数据时应先备份并单独走受控运维流程。

## 域名

`deploy/Caddyfile.bankpilot` 从 `BANKPILOT_DOMAIN` 读取站点域名。更换正式域名时只更新服务器环境和 DNS/Cloudflare 配置，不把公网 IP 写入仓库。MCP 客户端使用同一 HTTPS 域名下的 `/api/mcp`。
