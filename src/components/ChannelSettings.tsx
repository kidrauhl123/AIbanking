"use client";

import { ArrowLeft, Check, ChevronRight, RefreshCw, ShieldCheck, Unlink } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import styles from "./ChannelSettings.module.css";
import type { ChannelSetup } from "@/lib/channel-onboarding";
import { ChannelOnboarding } from "./ChannelOnboarding";

type Channel = {
  id: string;
  channelType: "WECOM" | "QQ";
  status: "ACTIVE" | "REVOKED";
  boundAt: string;
  lastSeenAt: string;
};

export function ChannelSettings() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [providers, setProviders] = useState<ChannelSetup[]>([]);
  const [selected, setSelected] = useState<"QQ" | "WECOM" | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  const load = useCallback(async () => {
    try {
      const [response, setupResponse] = await Promise.all([
        fetch("/api/v1/channels", { cache: "no-store" }),
        fetch("/api/v1/channels/onboarding", { cache: "no-store" }),
      ]);
      if (!setupResponse.ok) throw new Error("接入说明暂时无法加载，请重试");
      setProviders((await setupResponse.json()).providers);
      if (response.status === 401) { setSignedOut(true); setChannels([]); setError(""); return; }
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "无法读取消息渠道");
      setChannels(result.channels);
      setSignedOut(false);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取消息渠道");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const requested = new URLSearchParams(location.search).get("channel");
      if (requested === "QQ" || requested === "WECOM") setSelected(requested);
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 8000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load, selected]);

  const revoke = async (channel: Channel) => {
    const channelName = channel.channelType === "QQ" ? "QQ" : "企业微信";
    if (!window.confirm(`确认解除这个${channelName}身份？解除后该渠道不能再访问银行账户。`)) return;
    setBusy(channel.id);
    try {
      const response = await fetch("/api/v1/channels", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityId: channel.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "解绑失败");
      await load();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "解绑失败");
    } finally {
      setBusy(null);
    }
  };

  return <main className={styles.stage}><section className={styles.panel}>
    <header><Link href="/"><ArrowLeft size={17} /> 返回</Link><div><span>B</span><b>BankPilot</b></div></header>
    <div className={styles.heading}><h1>连接聊天软件</h1><span>选一个常用的软件，跟着提示连接 BankPilot。</span></div>
    {error && <div className={styles.error}>{error}<button onClick={load}><RefreshCw size={14} />重试</button></div>}
    {loading && <p className={styles.empty}>正在读取接入方式…</p>}
    {selected && providers.find((provider) => provider.channelType === selected) ? <ChannelOnboarding key={selected} provider={providers.find((provider) => provider.channelType === selected)!} bound={channels.some((channel) => channel.channelType === selected && channel.status === "ACTIVE")} onRefresh={load} onClose={() => setSelected(null)} /> : <div className={styles.providers}>{providers.map((provider) => {
      const bound = channels.some((channel) => channel.channelType === provider.channelType && channel.status === "ACTIVE");
      return <button key={provider.channelType} onClick={() => setSelected(provider.channelType)} aria-label={`${provider.name}接入引导`}><Image src={provider.channelType === "QQ" ? "/brands/qq.svg" : "/brands/wecom.svg"} alt="" width={34} height={34} /><span><b>{provider.name}</b><small>{bound ? "已连接 · 查看使用方式" : provider.canStart ? "添加机器人，连接银行账户" : "待开通 · 查看接入步骤"}</small></span><ChevronRight size={20} /></button>;
    })}</div>}
    {signedOut && <p className={styles.signIn}>可先查看引导，在机器人发来的链接中登录并确认绑定。</p>}
    <div className={styles.rule}><ShieldCheck size={17} /><span><b>由你确认，再关联账户</b><small>高风险操作仍需回到 App 验证，连接后可随时解绑。</small></span></div>
    <div className={styles.list}>
      {channels.length > 0 && <h2 className={styles.listTitle}>我的连接</h2>}
      {channels.map((channel) => <article key={channel.id}>
        <div className={`${styles.channelMark} ${channel.channelType === "QQ" ? styles.qqMark : ""}`}><Image src={channel.channelType === "QQ" ? "/brands/qq.svg" : "/brands/wecom.svg"} alt="" width={22} height={22} /></div>
        <div><b>{channel.channelType === "QQ" ? "QQ" : "企业微信"}</b><small>{channel.status === "ACTIVE" ? "已连接" : "已解绑"} · {new Date(channel.lastSeenAt).toLocaleDateString("zh-CN")}</small></div>
        {channel.status === "ACTIVE" ? <button disabled={busy === channel.id} onClick={() => revoke(channel)}>{busy === channel.id ? <RefreshCw className={styles.spin} size={15} /> : <Unlink size={15} />}解绑</button> : <span className={styles.revoked}>已解绑</span>}
      </article>)}
    </div>
    <footer><Check size={14} /> 身份标识加密保存，操作记录可在审计台查看。</footer>
  </section></main>;
}
