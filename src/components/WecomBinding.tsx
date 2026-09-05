"use client";

import { ArrowRight, Check, Link2, LockKeyhole, RotateCw } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AuthScreen } from "./AuthScreen";
import type { ChannelSetup } from "@/lib/channel-onboarding";
import styles from "./WecomBinding.module.css";

type State = "LOADING" | "SIGNED_OUT" | "READY" | "BINDING" | "DONE" | "ERROR";
type Customer = { id: string; display_name: string; phone: string };

export function ChannelBinding({ channelType }: { channelType: "WECOM" | "QQ" }) {
  const isQq = channelType === "QQ";
  const channelName = isQq ? "QQ" : "企业微信";
  const channelPath = isQq ? "qq" : "wecom";
  const hash = useSyncExternalStore(
    (onChange) => { window.addEventListener("hashchange", onChange); return () => window.removeEventListener("hashchange", onChange); },
    () => window.location.hash,
    () => "__SERVER__",
  );
  const token = new URLSearchParams(hash.slice(1)).get("token") ?? "";
  const [actionState, setActionState] = useState<State | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [provider, setProvider] = useState<ChannelSetup | null>(null);
  const state: State = actionState ?? (hash === "__SERVER__" || token ? "LOADING" : "ERROR");

  const checkSession = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/bootstrap", { cache: "no-store", signal });
      if (signal?.aborted) return;
      if (response.status === 401) { setCustomer(null); setActionState("SIGNED_OUT"); return; }
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "无法读取当前银行账户");
      if (!signal?.aborted) { setCustomer(body.customer); setActionState("READY"); setActionMessage(""); }
    } catch (error) {
      if (!signal?.aborted) { setActionState("ERROR"); setActionMessage(error instanceof Error ? error.message : "无法读取当前账户，请重试"); }
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void checkSession(controller.signal), 0);
    fetch("/api/v1/channels/onboarding", { signal: controller.signal }).then((response) => response.json()).then((body) => {
      if (!controller.signal.aborted) setProvider(body.providers?.find((item: ChannelSetup) => item.channelType === channelType) ?? null);
    }).catch(() => undefined);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [token, channelType, checkSession]);

  const bind = async () => {
    if (!token || !customer || state !== "READY") return;
    setActionState("BINDING"); setActionMessage("");
    try {
      const response = await fetch(`/api/channels/${channelPath}/bind/complete`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, expectedCustomerId: customer.id }),
      });
      const result = await response.json();
      if (response.status === 401) { setActionState("SIGNED_OUT"); setCustomer(null); return; }
      if (!response.ok) throw new Error(result.message ?? "绑定失败，请重新获取链接");
      history.replaceState(null, "", `/connect/${channelPath}`);
      setActionState("DONE");
    } catch (error) { setActionState("ERROR"); setActionMessage(error instanceof Error ? error.message : "绑定没有完成，请重新获取链接。"); }
  };

  // Login stays in this tab; the token never enters a query string. Establishing
  // a session does not automatically authorize the channel binding.
  if (state === "SIGNED_OUT") return <AuthScreen heading={`登录以连接${channelName}`} description="登录后会回到确认页面，核对账户再完成绑定。" onAuthenticated={() => checkSession()} />;

  return <main className={styles.stage}><section className={styles.panel} aria-live="polite">
    <header className={styles.brand}><span>B</span> BankPilot</header>
    <div className={styles.identityBridge} aria-hidden="true">
      <div className={styles.identity}><span className={isQq ? styles.qqMark : undefined}><Image src={isQq ? "/brands/qq.svg" : "/brands/wecom.svg"} alt="" width={isQq ? 34 : 38} height={34} /></span><small>{channelName}</small></div>
      <div className={styles.bridge}><i /><Link2 size={17} /><i /></div>
      <div className={styles.identity}><span className={styles.bankMark}>B</span><small>银行账户</small></div>
    </div>
    <p className={styles.eyebrow}>安全连接</p>
    <h1>{state === "DONE" ? "已经连接" : state === "ERROR" ? "还未完成连接" : "确认你的账户"}</h1>
    <p className={styles.explanation}>{state === "LOADING" ? "正在读取当前银行账户…" : state === "BINDING" ? "正在连接，请稍候…" : state === "DONE" ? `回到${channelName}的机器人私聊，发送“查余额”即可开始使用。` : state === "ERROR" ? actionMessage || `请先在${channelName}机器人私聊中发送“绑定”，再打开它回复的链接。` : `将你当前的${channelName}身份连接到以下 BankPilot 账户。`}</p>
    {state === "READY" && customer && <div className={styles.account}><b>{customer.display_name}</b><span>{customer.phone.slice(0, 3)}****{customer.phone.slice(-4)}</span></div>}
    {state !== "DONE" && <div className={styles.securityLine}><LockKeyhole size={15} /><span>仅确认本人发起的绑定 · 链接 10 分钟有效</span></div>}
    {state === "READY" && <button className={styles.primary} onClick={bind}>确认连接 <ArrowRight size={16} /></button>}
    {(state === "LOADING" || state === "BINDING") && <button className={styles.primary} disabled><RotateCw className={styles.spin} size={16} />{state === "LOADING" ? "正在读取" : "正在连接"}</button>}
    {state === "DONE" && <><div className={styles.success}><Check size={18} />{channelName}已连接</div>{provider?.entryUrl && <a className={styles.primary} href={provider.entryUrl} target="_blank" rel="noopener noreferrer">打开{channelName}机器人 <ArrowRight size={16} /></a>}<Link className={styles.secondary} href="/channels">查看我的连接</Link></>}
    {state === "ERROR" && token && <button className={styles.secondary} onClick={() => checkSession()}>重新检查账户</button>}
    {state !== "DONE" && <Link className={styles.secondary} href={`/channels?channel=${channelType}`}>{state === "READY" ? "暂不连接" : "查看接入步骤"}</Link>}
    <footer>查询可直接回复；转账等操作仍需确认或强验证。</footer>
  </section></main>;
}

export function WecomBinding() { return <ChannelBinding channelType="WECOM" />; }
export function QqBinding() { return <ChannelBinding channelType="QQ" />; }
