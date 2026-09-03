# CONTABO-jp 生产部署

## 当前环境

- 公网入口：通过部署环境中的正式域名访问（源站地址不写入公开仓库）
- 服务器目录：`/opt/bankpilot`
- Compose：`deploy/compose.production.yml`
- 应用容器：`bankpilot-app`
- 数据库容器：`bankpilot-postgres`
- 数据卷：`bankpilot_postgres`
- 入口代理：现有 `premsir-chat-caddy-1`
- 资源上限：应用 512MB / 1 CPU；数据库 512MB / 0.75 CPU

数据库没有发布主机端口，应用也没有直接暴露端口。Caddy 与应用通过外部 Docker 网络 `premsir-chat_backend` 通信，应用与数据库通过独立内部网络 `bankpilot_internal` 通信。

## 更新发布

从本机项目目录执行：

```bash
rsync -az \
  --exclude node_modules \
  --exclude .next \
  --exclude .env.local \
  --exclude .playwright-cli \
  --exclude output \
  ./ CONTABO-jp:/opt/bankpilot/

ssh CONTABO-jp \
  'cd /opt/bankpilot && docker compose --env-file deploy/.env.production -f deploy/compose.production.yml up -d --build --wait'
```

## 查看状态

```bash
ssh CONTABO-jp \
  'cd /opt/bankpilot && docker compose --env-file deploy/.env.production -f deploy/compose.production.yml ps'
```

```bash
ssh CONTABO-jp \
  'docker stats --no-stream bankpilot-app bankpilot-postgres'
```

## 恢复演示数据

此操作会清空 BankPilot 的演示操作、审计记录和余额变化，不影响服务器上的其他数据库：

```bash
ssh CONTABO-jp \
  'docker exec bankpilot-postgres sh -lc '\''psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/20-seed.sql'\'''
```

## 正式域名

生产环境应使用正式域名，并通过 Cloudflare Tunnel 或受代理保护的 DNS 记录连接源站，避免将服务器公网 IP 写入代码仓库。Caddy 站点地址由 `BANKPILOT_DOMAIN` 环境变量提供，并自动申请相应证书。
