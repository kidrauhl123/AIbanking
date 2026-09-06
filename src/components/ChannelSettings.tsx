"use client";

import { ArrowLeft, Check, ChevronRight, Copy, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import QRCode from "qrcode";
import { FormEvent, useCallback, useEffect, useState } from "react";
import styles from "./ChannelSettings.module.css";

type Kind = "weixin" | "qq" | "wecom";
type Connection = { id: string; channel_type: Kind; enabled: boolean; bound: boolean; runtime: string; last_seen_at: string | null };
type Qr = { session_id: string; status: string; qr_url?: string; expires_at_ms?: number };
const providers: { kind: Kind; name: string; icon: string; detail: string; url: string }[] = [
  { kind: "weixin", name: "微信", icon: "wechat", detail: "用自己的微信扫码连接", url: "https://github.com/HKUDS/nanobot/blob/main/docs/guides/wechat-ai-agent.md" },
  { kind: "qq", name: "QQ", icon: "qq", detail: "连接你创建的 QQ 机器人", url: "https://q.qq.com/" },
  { kind: "wecom", name: "企业微信", icon: "wecom", detail: "连接你的企业微信智能机器人", url: "https://work.weixin.qq.com/" },
];
const states: Record<string, string> = { configured: "配置已保存", starting: "后台正在启动", running: "后台运行中", reconnecting: "正在连接，请检查凭据", reauth_required: "微信登录已过期，请更换账号重新扫码", stopped: "后台未运行", failed: "后台连接异常", unavailable: "暂时无法读取状态" };

async function action(input: Record<string, unknown>) {
  const response = await fetch("/api/nanobot/channels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? "连接未完成，请重试。");
  return result;
}

export function ChannelSettings() {
  const [channels, setChannels] = useState<Connection[]>([]);
  const [selected, setSelected] = useState<Kind | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [botId, setBotId] = useState("");
  const [secret, setSecret] = useState("");
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pairing, setPairing] = useState("");
  const [qr, setQr] = useState<Qr | null>(null);
  const [qrImage, setQrImage] = useState("");
  const provider = providers.find(item => item.kind === selected);
  const connection = channels.find(item => item.channel_type === selected && item.enabled);
  const connectionId = connection?.id;
  const qrSession = qr?.session_id;
  const qrStatus = qr?.status;

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/nanobot/channels", { cache: "no-store" });
      if (response.status === 401) { setSignedOut(true); return; }
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "暂时无法读取连接。");
      setChannels(result.channels); setConsent(result.consent); setSignedOut(false);
    } catch (error) { setError(error instanceof Error ? error.message : "暂时无法读取连接。"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const requested = new URLSearchParams(location.search).get("channel")?.toLowerCase();
      if (providers.some(p => p.kind === requested)) setSelected(requested as Kind);
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 6000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);

  useEffect(() => {
    let live = true;
    if (qr?.qr_url) void QRCode.toDataURL(qr.qr_url, { width: 280, margin: 2, errorCorrectionLevel: "M" }).then(url => { if (live) setQrImage(url); }).catch(() => { if (live) setError("二维码生成失败，请重试。"); });
    return () => { live = false; };
  }, [qr?.qr_url]);

  useEffect(() => {
    if (!connectionId || qrStatus !== "pending") return;
    let disposed = false;
    let timer: number;
    const poll = async () => {
      if (document.visibilityState !== "visible") { timer = window.setTimeout(poll, 5000); return; }
      try {
        const result = await action({ action: "poll", connectionId, sessionId: qrSession });
        if (disposed) return;
        setQr(result);
        if (result.status === "pending") timer = window.setTimeout(poll, 5000);
        else await load();
      } catch (error) {
        if (!disposed) { setError(error instanceof Error ? error.message : "扫码状态读取失败。"); timer = window.setTimeout(poll, 8000); }
      }
    };
    timer = window.setTimeout(poll, 1200);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [connectionId, qrSession, qrStatus, load]);

  const perform = async (job: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await job(); }
    catch (error) { setError(error instanceof Error ? error.message : "操作未完成，请重试。"); }
    finally { setBusy(false); await load(); }
  };
  const startQr = async (id: string) => {
    setQrImage("");
    const result = await action({ action: "start", connectionId: id });
    setQr(result); if (result.pairingCode) setPairing(result.pairingCode);
  };
  const configure = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      const credentials = selected === "weixin" ? {} : selected === "qq" ? { appId: botId, secret } : { botId, secret };
      const result = await action({ action: "configure", config: { channelType: selected, credentials }, password, confirmed });
      setSecret(""); setPassword(""); setConfirmed(false); setEditing(false); setPairing(result.pairingCode);
      await load();
      if (selected === "weixin") await startQr(result.id);
    });
  };
  const choose = (kind: Kind | null) => {
    if (qr?.status === "pending" && connection) void action({ action: "cancel", connectionId: connection.id, sessionId: qr.session_id }).catch(() => {});
    setSelected(kind); setEditing(false); setQr(null); setQrImage(""); setPairing(""); setBotId(""); setSecret(""); setPassword(""); setConfirmed(false); setError(""); setNotice("");
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(pairing); setNotice("配对码已复制，到机器人私聊中粘贴发送。"); }
    catch { setNotice("请长按配对码复制。"); }
  };

  return <main className={styles.stage}><section className={styles.panel}>
    <header><Link href="/"><ArrowLeft size={18} /> 返回</Link><div><span>B</span><b>BankPilot</b></div></header>
    <div className={styles.heading}><h1>在聊天里办银行的事。</h1><span>连接自己的微信或机器人，由 Nanobot 持续接收消息。</span></div>
    {error && <div className={styles.error} role="alert">{error}<button onClick={() => { setError(""); void load(); }} aria-label="刷新连接状态"><RefreshCw size={18} /></button></div>}
    {notice && <p className={styles.waiting} role="status">{notice}</p>}
    {loading ? <p className={styles.empty}>正在读取连接…</p> : signedOut ? <div className={styles.guide}><h2>先登录你的银行账户</h2><p className={styles.guideCopy}>每个账户管理自己的机器人和聊天身份。</p><Link href="/" className={styles.primary}>去登录</Link></div> : !provider ? <div className={styles.providers}>{providers.map(p => {
      const current = channels.find(c => c.channel_type === p.kind && c.enabled);
      return <button key={p.kind} onClick={() => choose(p.kind)}><Image src={`/brands/${p.icon}.svg`} alt="" width={34} height={34} /><span><b>{p.name}</b><small>{current ? `${current.bound ? "已绑定" : "待配对"} · ${states[current.runtime] ?? "检查中"}` : p.detail}</small></span><ChevronRight size={20} /></button>;
    })}</div> : <div className={styles.guide}>
      <button className={styles.backButton} disabled={busy} onClick={() => choose(null)}><ArrowLeft size={17} /> 所有聊天软件</button>
      <div className={styles.guideTitle}><Image src={`/brands/${provider.icon}.svg`} alt="" width={36} height={36} /><h2>{provider.name}</h2></div>
      {(!connection || editing) ? <>
        {selected === "weixin" ? <p className={styles.guideCopy}>生成二维码，用自己的微信扫码并确认。连接成功后，在微信中的机器人会话发送配对码。</p> : <div className={styles.setupHelp}>
          <h3>先准备你自己的机器人</h3>
          <ol>{selected === "qq" ? <><li>打开 QQ 开放平台，创建机器人应用。</li><li>在开发设置中复制 AppID 和 AppSecret。</li><li>测试阶段，把自己的 QQ 加入沙箱成员，再添加机器人好友。</li></> : <><li>进入企业微信管理端，创建智能机器人。</li><li>选择 API 模式，再选择「长连接」。</li><li>复制 Bot ID 和 Secret，确保自己在机器人的可见范围内。</li></>}</ol>
          <a href={provider.url} target="_blank" rel="noopener noreferrer">打开{selected === "qq" ? "QQ 开放平台" : "企业微信管理端"}<ExternalLink size={15} /></a>
        </div>}
        <form className={styles.configForm} onSubmit={configure}>
          {selected !== "weixin" && <><label>{selected === "qq" ? "AppID" : "Bot ID"}<input value={botId} onChange={e => setBotId(e.target.value)} required maxLength={200} autoCapitalize="none" spellCheck={false} placeholder={selected === "qq" ? "填写机器人 AppID" : "填写机器人 Bot ID"} /></label><label>{selected === "qq" ? "AppSecret" : "Secret"}<input type="password" value={secret} onChange={e => setSecret(e.target.value)} required minLength={8} maxLength={512} autoComplete="off" placeholder="只用于连接你的机器人" /></label></>}
          <label>银行登录密码<input type="password" value={password} onChange={e => setPassword(e.target.value)} required maxLength={128} autoComplete="current-password" placeholder="验证是你本人在连接" /></label>
          <label className={styles.consent}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} required /><span>允许 Nanobot 查询我的银行数据、创建待确认转账。不授权自动付款。</span></label>
          <button className={styles.primary} disabled={busy || !confirmed} type="submit">{busy ? "正在连接…" : selected === "weixin" ? "生成微信二维码" : "保存并启动连接"}</button>
        </form>
      </> : <>
        <div className={connection.bound ? styles.done : styles.runtime} role="status">{connection.bound && <Check size={20} />}<span><b>{connection.bound ? "聊天身份已绑定" : "等待你的私聊配对"}</b><small>{states[connection.runtime] ?? "检查中"}{connection.last_seen_at ? ` · 最近收到消息 ${new Date(connection.last_seen_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : " · 尚未收到你的消息"}</small></span></div>
        {!consent && <p className={styles.guideCopy}>银行访问授权已到期或撤销。请到 <Link href="/">银行 AI 页面</Link>重新授权。</p>}
        {selected === "weixin" && !connection.bound && <div className={styles.qrFlow}>
          {qr?.status === "pending" ? <><h3>用微信扫一扫</h3>{qrImage ? <Image src={qrImage} alt="微信登录二维码" width={280} height={280} unoptimized /> : <p>正在生成二维码…</p>}<p>手机上可保存二维码，再用微信扫一扫识别。仅在微信内确认登录，不要把二维码发给别人。</p><button className={styles.textButton} disabled={busy} onClick={() => void perform(async () => { const sessionId = qr.session_id; setQr(null); await action({ action: "cancel", connectionId: connection.id, sessionId }); })}>取消扫码</button></> : qr?.status === "succeeded" ? <p className={styles.guideCopy}>微信登录成功。下一步：给机器人发送下方配对码。</p> : <><p className={styles.guideCopy}>{qr?.status === "expired" || qr?.status === "failed" ? "二维码已失效或登录未完成，请重新扫码。" : "点击生成二维码，在微信内确认登录。"}</p><button className={styles.primary} disabled={busy} onClick={() => void perform(() => startQr(connection.id))}>生成微信二维码</button></>}
        </div>}
        {!connection.bound ? <div className={styles.pairing}>
          <h3>发一条消息，确认是你</h3><p className={styles.guideCopy}>在{provider.name}里打开这个机器人的私聊，把配对码完整发送过去。有效期 10 分钟。</p>
          {pairing ? <div className={styles.command}><code>{pairing}</code><button onClick={copy} aria-label="复制配对码"><Copy size={18} /></button></div> : <button className={styles.secondary} disabled={busy} onClick={() => void perform(async () => { const result = await action({ action: "pair", connectionId: connection.id }); setPairing(result.pairingCode); })}>生成配对码</button>}
          {pairing && <button className={styles.textButton} disabled={busy} onClick={() => void perform(async () => { setPairing((await action({ action: "pair", connectionId: connection.id })).pairingCode); })}>配对码过期？重新生成</button>}
          <p className={styles.waiting}>收到配对码后，这里会自动更新。未配对的身份不能查看你的银行数据。</p>
        </div> : <div className={styles.tryMessage}><h3>现在可以直接聊了</h3><p>在{provider.name}里发「查一下余额」。关闭银行 APP 后，也能继续对话。</p><small>文字私聊可用；暂不处理群聊和附件。</small></div>}
        <div className={styles.manage}><button className={styles.secondary} disabled={busy} onClick={() => void perform(async () => { await action({ action: "restart", connectionId: connection.id }); setNotice("已请求重连，请查看后台状态并发送私聊消息验证。"); })}>重新连接</button><button className={styles.textButton} disabled={busy} onClick={() => { if (window.confirm("更换配置后需要重新配对聊天身份，继续？")) { setEditing(true); setQr(null); setPairing(""); } }}>更换账号或机器人</button><button className={styles.disconnect} disabled={busy} onClick={() => { if (window.confirm("解除连接并删除保存的机器人凭据？")) void perform(async () => { const result = await action({ action: "delete", connectionId: connection.id }); setQr(null); setPairing(""); setNotice(result.stopped ? "连接已解除，保存的渠道凭据已删除。" : "银行访问已撤销。后台将在恢复通信后停止连接并清理凭据。"); }); }}>解除连接</button></div>
      </>}
      <details className={styles.help}><summary>连不上？检查这几项</summary><p>{selected === "qq" ? "确认 AppID 和 AppSecret 来自同一个应用，你的 QQ 已加入沙箱成员，且正在机器人私聊中发送消息。机器人正式发布前可能有平台审核和测试范围限制。" : selected === "wecom" ? "需要支持 API 长连接模式的智能机器人，不是群机器人 Webhook。确认 Bot ID、Secret 和可见范围；如果收不到消息，重新检查管理端权限。" : "二维码来自 Nanobot 使用的微信 iLink 服务。能否登录取决于微信侧账号资格和服务可用性；扫码失败可重试，不代表已经连接。"}</p><p>后台运行不等于已验证收发。发送配对码后仍无回复，请检查配置，再点「重新连接」。不要把同一个机器人同时交给多个服务运行。</p><a href={selected === "qq" ? "https://github.com/HKUDS/nanobot/blob/main/docs/guides/qq-ai-agent.md" : "https://github.com/HKUDS/nanobot/blob/main/docs/chat-apps.md"} target="_blank" rel="noopener noreferrer">查看 Nanobot 渠道说明 <ExternalLink size={14} /></a></details>
    </div>}
    <div className={styles.rule}><ShieldCheck size={20} /><span><b>聊天归你，付款由你确认</b><small>连接凭据加密保存。转账确认和强验证仍在银行 APP 完成。</small></span></div>
  </section></main>;
}
