"use client";

import { ArrowLeft, Check, Clipboard, KeyRound, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import styles from "./SecurityCenter.module.css";

type Setup = { secret: string; uri: string };

export function SecurityCenter() {
  const router = useRouter();
  const [configured, setConfigured] = useState<boolean | null>(null); const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  useEffect(() => { fetch("/api/bootstrap", { cache: "no-store" }).then(async (response) => { if (response.status === 401) { router.push("/"); return; } if (response.ok) setConfigured((await response.json()).customer.mfa_configured); }); }, [router]);
  const begin = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget); try { const response = await fetch("/api/v1/security/totp/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: form.get("password") }) }); const result = await response.json(); if (!response.ok) throw new Error(result.message); setSetup(result); } catch (err) { setError(err instanceof Error ? err.message : "设置失败"); } finally { setBusy(false); } };
  const confirm = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget); try { const response = await fetch("/api/v1/security/totp/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: form.get("code") }) }); const result = await response.json(); if (!response.ok) throw new Error(result.message); setDone(true); setConfigured(true); setSetup(null); } catch (err) { setError(err instanceof Error ? err.message : "验证码错误"); } finally { setBusy(false); } };
  return <main className={styles.page}><header><Link href="/"><ArrowLeft size={17} />返回银行</Link><div><span>B</span><b>安全中心</b></div></header><section className={styles.card}>
    <div className={styles.icon}><ShieldCheck size={25} /></div><p>高风险操作保护</p><h1>动态验证器</h1><span>红色操作需输入 TOTP 动态码。密钥加密保存，不会进入 AI 上下文。</span>
    {configured && !setup ? <div className={styles.enabled}><Check size={19} /><div><b>{done ? "多因素认证启用成功" : "多因素认证已启用"}</b><span>高风险转账现在需要验证器动态码。</span></div></div> : !setup ? <form onSubmit={begin}><label>先用登录密码确认身份<input name="password" type="password" autoComplete="current-password" required /></label>{error && <em>{error}</em>}<button disabled={busy}><KeyRound size={16} />{busy ? "正在验证…" : "开始设置"}</button></form> : <div className={styles.setup}><h2>添加到身份验证器</h2><ol><li>打开任意支持 TOTP 的身份验证器。</li><li>选择“手动输入密钥”，账户名填写 BankPilot。</li><li>输入下方密钥，再用新生成的 6 位码确认。</li></ol><div className={styles.secret}><code>{setup.secret}</code><button onClick={() => navigator.clipboard.writeText(setup.secret)}><Clipboard size={15} /></button></div><details><summary>高级：复制 otpauth URI</summary><code>{setup.uri}</code></details><form onSubmit={confirm}><label>6 位动态码<input name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required autoFocus /></label>{error && <em>{error}</em>}<button disabled={busy}>{busy ? "正在确认…" : "确认并启用"}</button></form></div>}
  </section></main>;
}
