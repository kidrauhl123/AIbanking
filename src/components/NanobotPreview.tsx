"use client";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, RefreshCw, ShieldCheck } from "lucide-react";
import styles from "./NanobotPreview.module.css";

type Event = { tool_name: string; outcome: string; operation_id: string | null };
type Run = { id: string; conversation_id: string; message: string; reply: string | null; status: string; events: Event[] };
type State = { allowed: boolean; connected: boolean; runs: Run[] };
const labels: Record<string, string> = { "banking.accounts.list": "查询账户", "banking.transactions.list": "查询流水", "banking.beneficiaries.list": "查询收款人", "banking.cards.list": "查询卡片", "banking.subscriptions.list": "查询订阅", "banking.investments.products.list": "查询理财", "banking.transfers.prepare": "准备转账", "banking.operations.get": "查询操作结果" };

export function NanobotPreview({ onAuthorize }: { onAuthorize: (id: string) => Promise<void> }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [password, setPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conversation, setConversation] = useState("");
  const [pending, setPending] = useState<{ message: string; requestId: string; conversationId: string } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    const response = await fetch("/api/nanobot", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message);
    setState(data);
    setConversation(current => current || data.runs.at(-1)?.conversation_id || crypto.randomUUID());
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); } catch (err) { if (!stopped) setError(err instanceof Error ? err.message : "无法读取对话，请重试。"); }
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh]);
  const runs = state?.runs.filter(run => run.conversation_id === conversation) ?? [];
  const running = state?.runs.some(run => run.status === "RUNNING") ?? false;
  const progress = runs.map(run => `${run.id}:${run.status}:${run.events.length}`).join(",");
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "instant" }); }, [progress, pending]);
  const request = async (method: string, body?: unknown) => {
    const response = await fetch("/api/nanobot", { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message);
    return data;
  };
  const connect = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await request("POST", { action: "connect", password, confirmed: consent }); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "连接失败，请重试。"); }
    finally { setPassword(""); setBusy(false); }
  };
  const disconnect = async () => {
    if (!window.confirm("撤销 Nanobot 的银行访问权限？历史对话保留供审计，已有转账草稿不会自动付款。")) return;
    setBusy(true); setError("");
    try { await request("DELETE"); setPending(null); setConversation(crypto.randomUUID()); await refresh(); }
    catch { setError("撤销未完成，请重试。"); }
    finally { setBusy(false); }
  };
  const send = async (message = pending?.message ?? input) => {
    if (!message.trim() || busy || running || !state?.connected) return;
    const job = pending ?? { message: message.trim(), requestId: crypto.randomUUID(), conversationId: conversation };
    setPending(job); setBusy(true); setInput(""); setError("");
    try { await request("POST", { action: "send", ...job }); setPending(null); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "发送状态未知，请重试同一请求。"); }
    finally { setBusy(false); }
  };
  return <section className={styles.preview} aria-label="Nanobot">
    <header className={styles.heading}><div><h1>Nanobot</h1><p>{state?.connected ? "你的账户，你的独立对话" : "让 Agent 帮你办银行业务"}</p></div>{state?.connected && <button disabled={busy} onClick={disconnect}>断开连接</button>}</header>
    {error && <div className={styles.error} role="alert">{error}<button onClick={() => pending ? void send(pending.message) : void refresh().then(() => setError("")).catch(() => setError("连接仍不可用，请稍后重试。"))} disabled={busy}><RefreshCw size={14} />重试</button></div>}
    <div className={styles.scroll} ref={scroll}>
      {state?.allowed && <a className={styles.channelLink} href="/channels">连接微信、QQ 或企业微信<span>管理我的聊天连接</span></a>}
      {!state && <p className={styles.note}>正在读取连接状态…</p>}
      {state && !state.allowed && <div className={styles.intro}><ShieldCheck size={30} /><h2>暂时无法连接</h2><p>Nanobot 服务尚未就绪，请稍后重试。原来的银行助手仍可使用。</p></div>}
      {state?.allowed && !state.connected && <form className={styles.intro} onSubmit={connect}><ShieldCheck size={30} /><h2>连接你的银行</h2><p>Nanobot 可查询账户、流水、卡片和订阅，也可以准备转账。付款仍需你在银行页面确认。</p><p>相关对话与查询结果会交给平台配置的 AI 模型处理，并保存对话和操作审计。可随时断开，授权最长 30 天。</p><label className={styles.consent}><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />同意以上数据使用及银行访问权限</label><label className={styles.password}>银行登录密码<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="仅用于银行端验证，不发送给 AI" required /></label><button className={styles.primary} disabled={!consent || !password || busy}>{busy ? "正在连接…" : "确认连接"}</button></form>}
      {state?.allowed && state.connected && <>
        {!runs.length && <div className={styles.intro}><h2>想先办点什么？</h2><p>查账、准备转账，或接着追问。工具不支持的事，暂时不能代办。</p><div className={styles.prompts}>{["查一下我的余额", "分析最近的收支", "查看我的卡片"].map(text => <button key={text} onClick={() => send(text)} disabled={busy || running}>{text}</button>)}</div></div>}
        <div className={styles.messages}>{runs.map(run => <article key={run.id}><p className={styles.user}>{run.message}</p><div className={styles.answer}>
          {!!run.events.length && <details className={styles.events} open={run.status === "RUNNING"}><summary>银行工具记录 · {run.events.length} 次调用</summary>{run.events.map((event, index) => <div key={index}>{labels[event.tool_name] ?? event.tool_name} · {event.outcome === "FAILED" ? "未完成" : event.outcome === "AWAITING_USER_AUTHORIZATION" ? "待你授权" : "已返回"}</div>)}</details>}
          {run.reply && <p>{run.reply.split(/(\*\*[^*\n]+\*\*)/g).map((part, index) => part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part)}</p>}
          {run.status === "RUNNING" && <p className={styles.note} role="status">Nanobot 正在处理…可以离开此页，稍后回来查看。</p>}
          {Array.from(new Set(run.events.filter(e => e.operation_id && e.outcome !== "FAILED").map(e => e.operation_id!))).map(id => <BankResult key={id} id={id} onAuthorize={onAuthorize} />)}
        </div></article>)}</div>
        {pending && !runs.some(run => run.id === pending.requestId) && <p className={styles.user}>{pending.message}</p>}
      </>}
    </div>
    {state?.allowed && state.connected && <form className={styles.composer} onSubmit={event => { event.preventDefault(); void send(); }}><input value={input} maxLength={2000} onChange={e => setInput(e.target.value)} placeholder="问问 Nanobot…" aria-label="向 Nanobot 发送消息" disabled={Boolean(pending)} /><button aria-label="发送给 Nanobot" disabled={busy || running || (!input.trim() && !pending)}><ArrowUp size={20} /></button></form>}
  </section>;
}

function BankResult({ id, onAuthorize }: { id: string; onAuthorize: (id: string) => Promise<void> }) {
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const read = useCallback(async () => {
    const response = await fetch(`/api/v1/operations/${encodeURIComponent(id)}`, { cache: "no-store" });
    const value = await response.json();
    if (!response.ok) throw new Error("无法读取银行状态");
    setStatus(value.status); setError("");
  }, [id]);
  useEffect(() => {
    if (["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"].includes(status)) return;
    const timer = setInterval(() => { void read().catch(() => setError("暂时无法读取状态")); }, 3000);
    return () => clearInterval(timer);
  }, [read, status]);
  return <div className={styles.bankResult}><ShieldCheck size={18} /><div><b>银行单据</b><small>{id}</small><span>{status === "AWAITING_AUTH" ? "待授权 · 资金尚未转出" : status === "SUCCEEDED" ? "银行已确认执行成功" : status ? `银行状态：${status}` : "正在查询银行状态"}</span>{error && <span role="alert">{error}</span>}</div><button onClick={() => status === "AWAITING_AUTH" ? void onAuthorize(id).then(read).catch(() => setError("请核对当前银行状态")) : void read().catch(() => setError("状态查询失败"))}>{status === "AWAITING_AUTH" ? "核对并授权" : "刷新状态"}</button></div>;
}
