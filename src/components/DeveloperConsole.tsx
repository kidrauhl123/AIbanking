"use client";

import { ArrowLeft, Check, Clipboard, ExternalLink, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import styles from "./DeveloperConsole.module.css";

const availableScopes = [
  ["accounts:read", "账户与余额"], ["transactions:read", "交易流水"], ["beneficiaries:read", "收款人"],
  ["transfers:prepare", "创建转账草稿"], ["operations:read", "操作状态"], ["cards:read", "卡片"],
  ["subscriptions:read", "订阅代扣"], ["products:read", "已核验理财产品"],
] as const;

type TokenRow = { id: string; name: string; client_id: string; token_prefix: string; scopes: string[]; created_at: string; expires_at: string; last_used_at: string | null; revoked_at: string | null };

export function DeveloperConsole() {
  const router = useRouter();
  const [tokens, setTokens] = useState<TokenRow[]>([]); const [rawToken, setRawToken] = useState("");
  const [endpoint, setEndpoint] = useState("/api/mcp"); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const load = async () => { const response = await fetch("/api/v1/developer/tokens", { cache: "no-store" }); if (response.status === 401) { router.push("/"); return; } if (response.ok) { setTokens((await response.json()).tokens); setEndpoint(`${location.origin}/api/mcp`); } };
  useEffect(() => {
    fetch("/api/v1/developer/tokens", { cache: "no-store" }).then(async (response) => {
      if (response.status === 401) { router.push("/"); return; }
      if (response.ok) { setTokens((await response.json()).tokens); setEndpoint(`${location.origin}/api/mcp`); }
    });
  }, [router]);
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget);
    const scopes = availableScopes.map(([scope]) => scope).filter((scope) => form.get(scope) === "on");
    try { const response = await fetch("/api/v1/developer/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.get("name"), password: form.get("password"), scopes }) }); const result = await response.json(); if (!response.ok) throw new Error(result.message); setRawToken(result.token); event.currentTarget.reset(); await load(); } catch (err) { setError(err instanceof Error ? err.message : "创建失败"); } finally { setBusy(false); }
  };
  const revoke = async (id: string) => { if (!confirm("立即撤销这个令牌？已连接的 Agent 将失去访问权限。")) return; await fetch(`/api/v1/developer/tokens/${id}`, { method: "DELETE" }); await load(); };
  const copy = (value: string) => navigator.clipboard.writeText(value);

  return <main className={styles.page}><header><Link href="/"><ArrowLeft size={17} />返回银行</Link><div><span>B</span><b>Agent 接入中心</b></div><a href="/api/openapi" target="_blank">OpenAPI <ExternalLink size={13} /></a></header>
    <section className={styles.hero}><p>CONTROLLED ACCESS</p><h1>你的 Agent，<br />只拿到必要权限。</h1><span>每个令牌绑定当前银行用户、明确权限和 30 天有效期。MCP 可以查询和创建转账草稿，但不能执行扣款。</span></section>
    <div className={styles.grid}><section className={styles.panel}><div className={styles.panelHead}><KeyRound size={18} /><div><b>创建个人访问令牌</b><span>密码复核后仅展示一次</span></div></div><form onSubmit={create}>
      <label>Agent 名称<input name="name" required minLength={2} maxLength={60} placeholder="例如：我的 Claude Desktop" /></label>
      <fieldset><legend>授权范围</legend>{availableScopes.map(([scope, label]) => <label className={styles.scope} key={scope}><input type="checkbox" name={scope} defaultChecked={scope.endsWith(":read")} /><span><b>{label}</b><code>{scope}</code></span></label>)}</fieldset>
      <label>当前登录密码<input name="password" type="password" autoComplete="current-password" required /></label>{error && <p className={styles.error}>{error}</p>}<button disabled={busy}>{busy ? "正在签发…" : "签发 30 天令牌"}</button>
    </form></section>
    <section className={styles.panel}><div className={styles.panelHead}><ShieldCheck size={18} /><div><b>MCP 连接信息</b><span>Streamable HTTP · Bearer Token</span></div></div><div className={styles.endpoint}><span>Endpoint</span><code>{endpoint}</code><button onClick={() => copy(endpoint)} aria-label="复制 MCP 地址"><Clipboard size={15} /></button></div>
      {rawToken && <div className={styles.secret}><div><Check size={17} /><b>令牌已签发，请立即保存</b></div><code>{rawToken}</code><button onClick={() => copy(rawToken)}><Clipboard size={14} />复制令牌</button><small>页面关闭后无法再次查看原文；服务端仅保存 SHA-256 摘要。</small></div>}
      <div className={styles.rules}><b>安全边界</b><ul><li>Bearer 令牌只可访问所属用户数据</li><li>工具按 scope 动态注册，未授权工具不可见</li><li>转账工具只生成草稿，最终授权必须回银行 APP</li><li>每次工具调用写入 MCP 审计记录</li></ul></div>
    </section></div>
    <section className={styles.tokens}><h2>已签发令牌</h2>{!tokens.length && <p>还没有外部 Agent 令牌。</p>}{tokens.map((token) => <article key={token.id} data-revoked={Boolean(token.revoked_at) || undefined}><div><b>{token.name}</b><code>{token.token_prefix}… · {token.client_id}</code></div><span>{token.revoked_at ? "已撤销" : new Date(token.expires_at) < new Date() ? "已过期" : `有效至 ${new Date(token.expires_at).toLocaleDateString("zh-CN")}`}</span>{!token.revoked_at && <button onClick={() => revoke(token.id)} aria-label="撤销令牌"><Trash2 size={15} /></button>}</article>)}</section>
  </main>;
}
