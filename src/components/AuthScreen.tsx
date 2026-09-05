"use client";

import { type FormEvent, useState } from "react";
import styles from "./BankingApp.module.css";

export function AuthScreen({ onAuthenticated, heading, description }: { onAuthenticated: () => Promise<void>; heading?: string; description?: string }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message);
      await onAuthenticated();
    } catch (err) { setError(err instanceof Error ? err.message : "请求未完成"); } finally { setBusy(false); }
  };
  return <main className={styles.authStage}><section className={styles.authPanel}>
    <div className={styles.authBrand}><span>B</span><b>BankPilot</b></div>
    <div className={styles.authCopy}><p>账户与日常收支</p><h1>{mode === "login" ? heading ?? "欢迎回来" : "开立你的账户"}</h1><span>{description ?? (mode === "login" ? "登录后管理账户、转账和账单。" : "从零开始，所有数据都由你亲自创建。")}</span></div>
    <form onSubmit={submit} className={styles.authForm}>
      {mode === "register" && <label>姓名<input name="displayName" autoComplete="name" minLength={2} required placeholder="你的真实姓名或测试代号" /></label>}
      <label>手机号<input name="phone" autoComplete="tel" inputMode="tel" required placeholder="用于登录和收款人识别" /></label>
      <label>密码<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "register" ? 10 : 1} required placeholder={mode === "register" ? "至少 10 位，包含字母和数字" : "输入密码"} /></label>
      {error && <div className={styles.formError} role="alert">{error}</div>}
      <button className={styles.authSubmit} disabled={busy}>{busy ? "正在验证…" : mode === "login" ? "安全登录" : "注册并开户"}</button>
    </form>
    <button className={styles.modeSwitch} onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "还没有账户？立即注册" : "已有账户？返回登录"}</button>
    <small className={styles.authLegal}>比赛沙箱，不连接真实银行与清算网络。</small>
  </section></main>;
}
