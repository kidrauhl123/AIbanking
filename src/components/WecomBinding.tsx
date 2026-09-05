"use client";

import { ArrowRight, Check, Link2, LockKeyhole, RotateCw } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import styles from "./WecomBinding.module.css";

type State = "LOADING" | "SIGNED_OUT" | "READY" | "BINDING" | "DONE" | "ERROR";

type ChannelBindingProps = { channelType: "WECOM" | "QQ" };

export function ChannelBinding({ channelType }: ChannelBindingProps) {
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
  const state: State = actionState ?? (hash === "__SERVER__" ? "LOADING" : token ? "READY" : "ERROR");
  const message = actionMessage || (state === "LOADING"
    ? "正在检查安全绑定…"
    : state === "READY"
      ? `确认后，${channelName}中的你将与当前 BankPilot 账户关联。`
      : `绑定链接不完整，请回到${channelName}重新获取。`);

  const bind = useCallback(async () => {
    if (!token) return;
    setActionState("BINDING");
    setActionMessage("正在建立加密身份映射…");
    try {
      const response = await fetch(`/api/channels/${channelPath}/bind/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const result = await response.json();
      if (response.status === 401 || response.status === 403) {
        setActionState("SIGNED_OUT");
        setActionMessage("请先登录 BankPilot，再返回此页面完成绑定。");
        return;
      }
      if (!response.ok) throw new Error(result.message ?? "绑定失败");
      history.replaceState(null, "", `/connect/${channelPath}`);
      setActionState("DONE");
      setActionMessage(`身份绑定完成。现在可以回${channelName}继续刚才的银行请求。`);
    } catch (error) {
      setActionState("ERROR");
      setActionMessage(error instanceof Error ? error.message : "绑定没有完成，请重新获取链接。");
    }
  }, [channelName, channelPath, token]);

  useEffect(() => {
    const retry = () => {
      if (state === "SIGNED_OUT") void bind();
    };
    window.addEventListener("focus", retry);
    return () => window.removeEventListener("focus", retry);
  }, [bind, state]);

  return (
    <main className={styles.stage}>
      <section className={styles.panel} aria-live="polite">
        <header className={styles.brand}><span>B</span> BankPilot</header>

        <div className={styles.identityBridge} aria-hidden="true">
          <div className={styles.identity}><span className={isQq ? styles.qqMark : undefined}><Image src={isQq ? "/brands/qq.svg" : "/brands/wecom.svg"} alt="" width={isQq ? 34 : 38} height={34} /></span><small>{channelName}</small></div>
          <div className={styles.bridge}><i /><Link2 size={17} /><i /></div>
          <div className={styles.identity}><span className={styles.bankMark}>B</span><small>银行账户</small></div>
        </div>

        <p className={styles.eyebrow}>安全连接</p>
        <h1>{state === "DONE" ? "已经连接" : "连接你的银行身份"}</h1>
        <p className={styles.explanation}>{message}</p>

        <div className={styles.securityLine}>
          <LockKeyhole size={15} />
          <span>一次性链接 · 10 分钟有效 · 可随时解绑</span>
        </div>

        {state === "READY" && (
          <button className={styles.primary} onClick={bind}>确认连接 <ArrowRight size={16} /></button>
        )}
        {state === "BINDING" && (
          <button className={styles.primary} disabled><RotateCw className={styles.spin} size={16} /> 正在连接</button>
        )}
        {state === "SIGNED_OUT" && (
          <Link className={styles.primary} href="/" target="_blank" rel="noopener">新窗口登录 BankPilot <ArrowRight size={16} /></Link>
        )}
        {state === "DONE" && (
          <div className={styles.success}><Check size={18} /> {channelName}已获得受控入口</div>
        )}
        {state === "ERROR" && (
          <Link className={styles.secondary} href="/">返回 BankPilot</Link>
        )}

        <footer>{channelName}不能绕过 BankPilot 的确认与强验证规则。</footer>
      </section>
    </main>
  );
}

export function WecomBinding() {
  return <ChannelBinding channelType="WECOM" />;
}

export function QqBinding() {
  return <ChannelBinding channelType="QQ" />;
}
