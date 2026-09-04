"use client";

import { ArrowLeft, Building2, Check, Link2, RefreshCw, ShieldCheck, Unlink } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import styles from "./ChannelSettings.module.css";

type Channel = {
  id: string;
  channelType: "WECOM";
  status: "ACTIVE" | "REVOKED";
  boundAt: string;
  lastSeenAt: string;
};

export function ChannelSettings() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/channels", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "无法读取消息渠道");
      setChannels(result.channels);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取消息渠道");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const revoke = async (channel: Channel) => {
    if (!window.confirm("确认解除这个企业微信身份？解除后该渠道不能再访问银行账户。")) return;
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
    <div className={styles.heading}><p>CONNECTED CHANNELS</p><h1>消息渠道</h1><span>每个外部身份都必须由你亲自在银行会话中绑定。</span></div>
    <div className={styles.rule}><ShieldCheck size={17} /><span><b>银行权限始终优先</b><small>解绑立即生效；红色操作仍须回 BankPilot 强验证。</small></span></div>
    {error && <div className={styles.error}>{error}<button onClick={load}><RefreshCw size={14} />重试</button></div>}
    <div className={styles.list}>
      {loading && <p className={styles.empty}>正在读取加密身份映射…</p>}
      {!loading && channels.length === 0 && <div className={styles.emptyState}><Link2 size={24} /><b>还没有连接渠道</b><span>在企业微信中与 BankPilot 机器人对话，即可发起安全绑定。</span></div>}
      {channels.map((channel) => <article key={channel.id}>
        <div className={styles.channelMark}><Building2 size={19} /></div>
        <div><b>企业微信</b><small>最近活动 {new Date(channel.lastSeenAt).toLocaleString("zh-CN")}</small><code>{channel.id.slice(0, 8)} · {channel.status}</code></div>
        {channel.status === "ACTIVE" ? <button disabled={busy === channel.id} onClick={() => revoke(channel)}>{busy === channel.id ? <RefreshCw className={styles.spin} size={15} /> : <Unlink size={15} />}解绑</button> : <span className={styles.revoked}>已解绑</span>}
      </article>)}
    </div>
    <footer><Check size={14} /> 渠道只保存加密标识，不保存企业微信聊天内容。</footer>
  </section></main>;
}
