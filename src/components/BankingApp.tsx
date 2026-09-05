"use client";

import {
  ArrowDownLeft, ArrowUpRight, Bell, ChartNoAxesColumnIncreasing, Check,
  ChevronRight, CircleCheck, CreditCard, Eye, House, Link2, LockKeyhole,
  LogOut, Plus, RefreshCw, Send, ShieldCheck, Sparkles, X,
} from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { ServiceWorkerRegister } from "./ServiceWorkerRegister";
import { StatementView, SubscriptionsView } from "./BankingViews";
import type { BankStatement } from "@/lib/banking-report";
import styles from "./BankingApp.module.css";

type Account = { id: string; name: string; account_no: string; masked_no: string; account_type: string; available_balance_minor: string; currency: string; status: string };
type Transaction = { id: string; merchant_name: string; category: string; amount_minor: string; occurred_at: string; is_anomaly: boolean };
type Card = { id: string; card_name: string; masked_no: string; card_type: string; status: string; daily_limit_minor: string };
type Subscription = { id: string; merchant_name: string; amount_minor: string; billing_cycle: string; next_charge_at: string; status: string };
type Bootstrap = { customer: { display_name: string; phone: string; mfa_configured: boolean }; totalMinor: number; accounts: Account[]; transactions: Transaction[]; cards: Card[]; subscriptions: Subscription[]; statement: BankStatement; ai: { configured: boolean; model: string | null } };
type Operation = {
  type: "TRANSFER" | "CARD_LOCK" | "SUBSCRIPTION_CANCEL"; operationId: string; title: string;
  riskLevel: "GREEN" | "YELLOW" | "RED"; requiredAuth: "CONFIRM" | "MFA";
  details: Array<{ label: string; value: string }>; resourceId?: string; actionLabel: string;
};
type Reply = { taskId: string; intent: string; message: string; operation?: Operation; data?: Record<string, unknown>; suggestions?: string[]; ai?: { model: string; confidence: number } };
type ChatItem = { id: string; role: "user" | "agent"; text: string; reply?: Reply; state?: "idle" | "executing" | "done" | "failed"; receipt?: { operationId: string; status: string; receipt?: { reference?: string }; amountMinor?: number; beneficiary?: string; card?: string } };
type Tab = "home" | "agent" | "activity" | "cards" | "analysis" | "subscriptions";

const money = (minor: number | string) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(Number(minor) / 100);
const shortDate = (date: string) => new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(date));
const prompts = ["查一下我的余额", "分析本月账单", "查看订阅扣费", "锁定我的卡片"];

type PreparedTransfer = {
  operationId: string; riskLevel: "YELLOW" | "RED"; requiredAuth: "CONFIRM" | "MFA";
  taskId?: string;
  details: { amountMinor: number; sourceAccount: { name: string; maskedNo: string }; recipient: { name: string; phoneMasked: string; maskedAccount: string }; note?: string | null };
};

export function BankingApp() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [balanceVisible, setBalanceVisible] = useState(true);
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [mfa, setMfa] = useState<{ itemId: string; operation: Operation; taskId: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [dialog, setDialog] = useState<"deposit" | "transfer" | "card" | "profile" | null>(null);
  const [prepared, setPrepared] = useState<PreparedTransfer | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const authorizationLoaded = useRef(false);
  const conversationId = useRef("");

  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/bootstrap", { cache: "no-store" });
      if (response.status === 401) { setAuthRequired(true); setData(null); setError(""); return; }
      if (!response.ok) throw new Error("load");
      setData(await response.json()); setAuthRequired(false); setError("");
    } catch { setError("银行核心暂时不可用，请稍后重试。"); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { if (tab !== "agent") viewportRef.current?.scrollTo({ top: 0 }); }, [tab]);
  useEffect(() => {
    if (tab !== "agent") return;
    const viewport = viewportRef.current;
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [chats, sending, tab]);
  useEffect(() => {
    if (!data || authorizationLoaded.current) return;
    const params = new URLSearchParams(location.search);
    const operationId = params.get("authorize");
    const taskId = params.get("task");
    if (!operationId) return;
    authorizationLoaded.current = true;
    fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`).then(async (response) => {
      const result = await response.json(); if (!response.ok) throw new Error(result.message);
      if (result.status === "AWAITING_AUTH") { setPrepared({ ...result, taskId: taskId ?? undefined }); setDialog("transfer"); }
    }).catch((err) => setError(err instanceof Error ? err.message : "无法读取待授权操作"));
  }, [data]);

  const send = async (text = input) => {
    const message = text.trim(); if (!message || sending) return;
    setTab("agent"); setInput(""); setSending(true);
    setChats((items) => [...items, { id: crypto.randomUUID(), role: "user", text: message }]);
    try {
      const history = chats.slice(-8).map((item) => ({ role: item.role === "agent" ? "assistant" : "user", content: item.text }));
      if (!conversationId.current) conversationId.current = crypto.randomUUID();
      const response = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, history, conversationId: conversationId.current }) });
      const reply = await response.json(); if (!response.ok) throw new Error(reply.message);
      setChats((items) => [...items, { id: crypto.randomUUID(), role: "agent", text: reply.message, reply, state: "idle" }]);
    } catch (err) {
      setChats((items) => [...items, { id: crypto.randomUUID(), role: "agent", text: err instanceof Error ? err.message : "本次请求没有执行，请重试。", state: "failed" }]);
    } finally { setSending(false); }
  };

  const onSubmit = (event: FormEvent) => { event.preventDefault(); send(); };

  const commit = async (itemId: string, operation: Operation, taskId: string, verificationCode?: string) => {
    if (operation.requiredAuth === "MFA" && !verificationCode) { setMfa({ itemId, operation, taskId }); return; }
    setChats((items) => items.map((item) => item.id === itemId ? { ...item, state: "executing" } : item));
    try {
      const response = await fetch(`/api/operations/${operation.operationId}/commit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, totpCode: verificationCode, taskId, resourceId: operation.resourceId, type: operation.type }),
      });
      const result = await response.json(); if (!response.ok) throw new Error(result.message);
      setChats((items) => items.map((item) => item.id === itemId ? { ...item, state: "done", text: result.agent?.message ?? item.text, receipt: result } : item));
      setMfa(null); setMfaCode(""); await load();
    } catch (err) {
      setChats((items) => items.map((item) => item.id === itemId ? { ...item, state: "failed", text: `${item.text}\n\n${err instanceof Error ? err.message : "操作失败，资金未变动。"}` } : item));
      setMfa(null); setMfaCode("");
    }
  };

  const cancelAgentOperation = async (itemId: string, taskId: string) => {
    setChats((items) => items.map((item) => item.id === itemId ? { ...item, state: "executing" } : item));
    try {
      const response = await fetch(`/api/agent/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
      const result = await response.json(); if (!response.ok) throw new Error(result.message);
      setChats((items) => items.map((item) => item.id === itemId ? { ...item, state: "done", text: result.agent.message, reply: { ...item.reply!, operation: undefined } } : item));
    } catch (err) {
      setChats((items) => items.map((item) => item.id === itemId ? { ...item, state: "failed", text: `${item.text}\n\n${err instanceof Error ? err.message : "取消失败，请重试。"}` } : item));
    }
  };

  if (loading && !data && !authRequired) return <main className={styles.stage}><div className={styles.splash}><span>B</span><p>正在连接银行核心</p></div></main>;
  if (authRequired) return <AuthScreen onAuthenticated={load} />;

  const logout = async () => { await fetch("/api/auth/logout", { method: "POST" }); setData(null); setAuthRequired(true); };
  const closeTransfer = () => { setDialog(null); setPrepared(null); setMfaCode(""); if (location.search) history.replaceState(null, "", location.pathname); };

  return <main className={styles.stage}>
    <ServiceWorkerRegister />
    <section className={styles.phone} aria-label="BankPilot 手机银行">
      <header className={styles.topbar}>
        <button className={styles.avatar} aria-label="个人中心" onClick={() => setDialog("profile")}>{data?.customer.display_name.slice(0, 2).toUpperCase()}</button>
        <div className={styles.wordmark}><span>B</span> BankPilot</div>
        <button className={styles.iconButton} aria-label="通知"><Bell size={20} strokeWidth={1.8} /><i /></button>
      </header>
      {error && <div className={styles.connectionError}><span>{error}</span><button onClick={load}><RefreshCw size={15} />重试</button></div>}
      <div className={styles.viewport} ref={viewportRef}>
        {tab === "home" && <HomeView data={data} loading={loading} visible={balanceVisible} toggleVisible={() => setBalanceVisible(!balanceVisible)} onAnalysis={() => setTab("analysis")} onSubscriptions={() => setTab("subscriptions")} onDeposit={() => setDialog("deposit")} onTransfer={() => setDialog("transfer")} />}
        {tab === "agent" && <AgentView chats={chats} sending={sending} coreConnected={!error} aiStatus={data?.ai ?? { configured: false, model: null }} onPrompt={send} onCommit={commit} onCancel={cancelAgentOperation} bottomRef={bottomRef} />}
        {tab === "activity" && <ActivityView data={data} />}
        {tab === "cards" && <CardsView data={data} onCreate={() => setDialog("card")} onLocked={load} />}
        {tab === "analysis" && <StatementView initial={data?.statement} onBack={() => setTab("home")} />}
        {tab === "subscriptions" && <SubscriptionsView items={data?.subscriptions ?? []} available={!!data} onBack={() => setTab("home")} onChanged={load} />}
      </div>
      {tab === "agent" && <form className={styles.composer} onSubmit={onSubmit}><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="说出你想办理的业务…" aria-label="向银行 Agent 发送消息" /><button type="submit" disabled={!input.trim() || sending} aria-label="发送"><Send size={18} /></button></form>}
      <nav className={styles.nav} aria-label="主导航">
        <NavButton active={["home", "analysis", "subscriptions"].includes(tab)} label="首页" icon={<House size={21} />} onClick={() => setTab("home")} />
        <NavButton active={tab === "agent"} label="AI 助手" icon={<Sparkles size={21} />} onClick={() => setTab("agent")} />
        <NavButton active={tab === "activity"} label="明细" icon={<ChartNoAxesColumnIncreasing size={21} />} onClick={() => setTab("activity")} />
        <NavButton active={tab === "cards"} label="卡片" icon={<CreditCard size={21} />} onClick={() => setTab("cards")} />
      </nav>
    </section>
    <a className={styles.auditLink} href="/audit" target="_blank"><ShieldCheck size={16} /> 打开安全审计台 <ChevronRight size={15} /></a>
    {mfa && <ReauthModal code={mfaCode} setCode={setMfaCode} close={() => { setMfa(null); setMfaCode(""); }} submit={() => commit(mfa.itemId, mfa.operation, mfa.taskId, mfaCode)} />}
    {dialog === "deposit" && data && <DepositModal account={data.accounts[0]} busy={actionBusy} close={() => setDialog(null)} done={async () => { setDialog(null); await load(); }} setBusy={setActionBusy} />}
    {dialog === "transfer" && data && <TransferModal account={data.accounts[0]} mfaConfigured={data.customer.mfa_configured} prepared={prepared} setPrepared={setPrepared} busy={actionBusy} setBusy={setActionBusy} close={closeTransfer} code={mfaCode} setCode={setMfaCode} done={async () => { closeTransfer(); await load(); }} />}
    {dialog === "card" && data && <CardModal account={data.accounts[0]} busy={actionBusy} setBusy={setActionBusy} close={() => setDialog(null)} done={async () => { setDialog(null); await load(); setTab("cards"); }} />}
    {dialog === "profile" && data && <ProfileModal data={data} close={() => setDialog(null)} logout={logout} />}
  </main>;
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: () => Promise<void> }) {
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
    <div className={styles.authCopy}><p>账户与日常收支</p><h1>{mode === "login" ? "欢迎回来" : "开立你的账户"}</h1><span>{mode === "login" ? "登录后管理账户、转账和账单。" : "从零开始，所有数据都由你亲自创建。"}</span></div>
    <form onSubmit={submit} className={styles.authForm}>
      {mode === "register" && <label>姓名<input name="displayName" autoComplete="name" minLength={2} required placeholder="你的真实姓名或测试代号" /></label>}
      <label>手机号<input name="phone" autoComplete="tel" inputMode="tel" required placeholder="用于登录和收款人识别" /></label>
      <label>密码<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "register" ? 10 : 1} required placeholder={mode === "register" ? "至少 10 位，包含字母和数字" : "输入密码"} /></label>
      {error && <div className={styles.formError}>{error}</div>}
      <button className={styles.authSubmit} disabled={busy}>{busy ? "正在验证…" : mode === "login" ? "安全登录" : "注册并开户"}</button>
    </form>
    <button className={styles.modeSwitch} onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "还没有账户？立即注册" : "已有账户？返回登录"}</button>
    <small className={styles.authLegal}>比赛沙箱，不连接真实银行与清算网络。</small>
  </section></main>;
}

function NavButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick: () => void }) {
  return <button className={active ? styles.navActive : ""} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function HomeView({ data, loading, visible, toggleVisible, onAnalysis, onSubscriptions, onDeposit, onTransfer }: { data: Bootstrap | null; loading: boolean; visible: boolean; toggleVisible: () => void; onAnalysis: () => void; onSubscriptions: () => void; onDeposit: () => void; onTransfer: () => void }) {
  return <div className={styles.home}>
    <section className={styles.balanceBlock}><div className={styles.labelRow}><span>总资产</span><button onClick={toggleVisible} aria-label="隐藏或显示余额"><Eye size={16} /></button></div><div className={styles.balance}>{loading ? "—" : visible ? money(data?.totalMinor ?? 0) : "••••••"}</div><div className={styles.balanceMeta}><span>可用余额</span><span>{data?.accounts[0]?.masked_no ?? "账户未就绪"}</span></div></section>
    <div className={styles.quickActions}>
      <button onClick={onTransfer}><span><ArrowUpRight /></span>转账</button>
      <button onClick={onDeposit}><span><Plus /></span>入金</button>
      <button onClick={onAnalysis}><span><ChartNoAxesColumnIncreasing /></span>分析</button>
      <button onClick={onSubscriptions}><span><RefreshCw /></span>订阅</button>
    </div>
    <section className={styles.section}><div className={styles.sectionHead}><div><p>本月支出与转出</p><h2>{data ? money(data.statement.expenseMinor) : "—"}</h2></div><button onClick={onAnalysis}>分析</button></div>{data?.statement.expenseMinor === 0 && <p className={styles.emptyCopy}>本月还没有支出记录。</p>}</section>
    <section className={styles.section}><div className={styles.sectionTitle}><h2>最近交易</h2><span>{data?.transactions.length ?? 0} 笔</span></div><TransactionList items={data?.transactions.slice(0, 4) ?? []} /></section>
  </div>;
}

function TransactionList({ items }: { items: Transaction[] }) {
  if (!items.length) return <div className={styles.emptyState}><span>还没有交易</span><small>入金或转账后会显示在这里。</small></div>;
  return <div className={styles.transactionList}>{items.map((item) => <div className={styles.transaction} key={item.id}>
    <span className={Number(item.amount_minor) >= 0 ? styles.txIconIn : styles.txIcon}>{Number(item.amount_minor) >= 0 ? <ArrowDownLeft size={19} /> : item.merchant_name.slice(0, 1)}</span>
    <span className={styles.txCopy}><b>{item.merchant_name}</b><small>{item.category} · {shortDate(item.occurred_at)}{item.is_anomaly && <em>需核实</em>}</small></span>
    <strong className={Number(item.amount_minor) >= 0 ? styles.positive : ""}>{Number(item.amount_minor) >= 0 ? "+" : "−"}{money(Math.abs(Number(item.amount_minor)))}</strong>
  </div>)}</div>;
}

function AgentView({ chats, sending, coreConnected, aiStatus, onPrompt, onCommit, onCancel, bottomRef }: { chats: ChatItem[]; sending: boolean; coreConnected: boolean; aiStatus: { configured: boolean; model: string | null }; onPrompt: (text: string) => void; onCommit: (itemId: string, operation: Operation, taskId: string) => void; onCancel: (itemId: string, taskId: string) => void; bottomRef: React.RefObject<HTMLDivElement | null> }) {
  const ready = coreConnected && aiStatus.configured;
  const statusText = !coreConnected ? "银行核心未连接" : aiStatus.configured ? `${aiStatus.model} · 核心已连接` : "真实 AI 模型未配置";
  return <div className={styles.agentView}><div className={styles.agentHeading}><div className={styles.agentOrb}><Sparkles size={21} /></div><div><h1>BankPilot</h1><p><i data-offline={!ready || undefined} /> {statusText}</p></div></div>
    <div className={styles.promptRail}>{prompts.map((prompt) => <button key={prompt} onClick={() => onPrompt(prompt)}>{prompt}</button>)}</div>
    <div className={styles.messages}>{chats.map((item) => item.role === "user" ? <div className={styles.userMessage} key={item.id}>{item.text}</div> : <div className={styles.agentMessage} key={item.id}><div className={styles.miniOrb}><Sparkles size={13} /></div><div className={styles.messageContent}>{item.reply?.ai && <span className={styles.aiProof}>AI · {item.reply.ai.model} · {Math.round(item.reply.ai.confidence * 100)}%</span>}<p>{item.text}</p>{item.reply?.data && <ReplyData reply={item.reply} />}{item.reply?.operation && <OperationCard item={item} operation={item.reply.operation} onCommit={() => onCommit(item.id, item.reply!.operation!, item.reply!.taskId)} onCancel={() => onCancel(item.id, item.reply!.taskId)} />}</div></div>)}
      {sending && <div className={styles.agentMessage}><div className={styles.miniOrb}><Sparkles size={13} /></div><div className={styles.typing}><i /><i /><i /></div></div>}<div ref={bottomRef} />
    </div></div>;
}

function ReplyData({ reply }: { reply: Reply }) {
  if (reply.intent === "BILL_ANALYSIS") {
    const categories = (reply.data?.categories ?? []) as Array<{ category: string; total_minor: string }>;
    const anomalies = (reply.data?.anomalies ?? []) as Array<{ merchant_name: string; amount_minor: string }>;
    const max = Math.max(...categories.map((item) => Number(item.total_minor)), 1);
    return <div className={styles.analysisCard}><div className={styles.cardEyebrow}>消费结构</div>{categories.slice(0, 4).map((item) => <div className={styles.barRow} key={item.category}><div><span>{item.category}</span><b>{money(item.total_minor)}</b></div><i><span style={{ width: `${Math.max(4, Number(item.total_minor) / max * 100)}%` }} /></i></div>)}{anomalies.length > 0 && <div className={styles.anomaly}><ShieldCheck size={17} /><span><b>{anomalies[0].merchant_name}</b><small>{money(Math.abs(Number(anomalies[0].amount_minor)))} · 异常地点与金额</small></span></div>}</div>;
  }
  if (reply.intent === "SUBSCRIPTIONS") {
    const subscriptions = (reply.data?.subscriptions ?? []) as Array<{ id: string; merchant_name: string; amount_minor: string; billing_cycle: string; next_charge_at: string }>;
    return <div className={styles.subscriptionCard}>{subscriptions.map((item) => <div key={item.id}><span className={styles.merchantGlyph}>{item.merchant_name.slice(0, 1)}</span><span><b>{item.merchant_name}</b><small>{shortDate(item.next_charge_at)} 续费</small></span><strong>{money(item.amount_minor)}<small>/{item.billing_cycle === "YEARLY" ? "年" : "月"}</small></strong></div>)}</div>;
  }
  return null;
}

function OperationCard({ item, operation, onCommit, onCancel }: { item: ChatItem; operation: Operation; onCommit: () => void; onCancel: () => void }) {
  const done = item.state === "done";
  return <section className={`${styles.operationCard} ${done ? styles.operationDone : ""}`}>
    <div className={styles.operationHead}><span className={styles.riskDot} data-level={operation.riskLevel} /><div><small>银行操作单</small><b>{done ? "执行成功" : operation.title}</b></div>{done ? <CircleCheck size={22} /> : <span className={styles.riskTag} data-level={operation.riskLevel}>{operation.riskLevel === "RED" ? "红色" : operation.riskLevel === "YELLOW" ? "黄色" : "绿色"}</span>}</div>
    <div className={styles.operationAmount}>{operation.details[0]?.value}</div><dl>{operation.details.slice(1).map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}</dl>
    <div className={styles.operationId}><span>操作编号</span><code>{operation.operationId}</code></div>
    {done ? <div className={styles.successReceipt}><Check size={16} /><span><b>{item.receipt ? "账本已入账" : "操作已取消"}</b><small>{item.receipt?.receipt?.reference ?? "银行核心未执行这项操作"}</small></span></div> : <div className={styles.operationActions}><button className={styles.cancelOperation} disabled={item.state === "executing"} onClick={onCancel}>取消</button><button className={styles.executeButton} disabled={item.state === "executing"} onClick={onCommit}>{item.state === "executing" ? <RefreshCw className={styles.spin} size={17} /> : operation.requiredAuth === "MFA" ? <LockKeyhole size={17} /> : <ShieldCheck size={17} />}{item.state === "executing" ? "处理中" : operation.actionLabel}</button></div>}
    {!done && <p className={styles.authorizationNote}>{operation.requiredAuth === "MFA" ? "动态码仅授权本次操作" : "请确认以上信息"}</p>}
  </section>;
}

function ActivityView({ data }: { data: Bootstrap | null }) {
  const [filter, setFilter] = useState("全部");
  const items = (data?.transactions ?? []).filter((item) => filter === "全部" || (filter === "支出" && Number(item.amount_minor) < 0) || (filter === "收入" && Number(item.amount_minor) > 0) || (filter === "异常" && item.is_anomaly));
  return <div className={styles.listView}><div className={styles.viewHeading}><p>最近 50 笔交易</p><h1>账户活动</h1></div><div className={styles.filterPills}>{["全部", "支出", "收入", "异常"].map((label) => <button key={label} aria-pressed={filter === label} className={filter === label ? styles.selected : undefined} onClick={() => setFilter(label)}>{label}</button>)}</div><section className={styles.section}>{items.length ? <TransactionList items={items} /> : <p className={styles.emptyCopy}>没有符合条件的交易。</p>}</section></div>;
}

function ModalShell({ title, eyebrow, close, children }: { title: string; eyebrow: string; close: () => void; children: React.ReactNode }) {
  return <div className={styles.modalBackdrop} role="presentation"><section className={styles.modal} role="dialog" aria-modal="true" aria-label={title}>
    <button className={styles.modalClose} onClick={close} aria-label="关闭"><X size={20} /></button>
    <p className={styles.eyebrow}>{eyebrow}</p><h2>{title}</h2>{children}
  </section></div>;
}

function DepositModal({ account, busy, setBusy, close, done }: { account: Account; busy: boolean; setBusy: (value: boolean) => void; close: () => void; done: () => Promise<void> }) {
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(""); const values = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/v1/deposits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: account.id, amountMinor: Math.round(Number(values.get("amount")) * 100), source: values.get("source"), reference: values.get("reference") }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message); await done();
    } catch (err) { setError(err instanceof Error ? err.message : "入金未完成"); } finally { setBusy(false); }
  };
  return <ModalShell eyebrow="银行核心 · 实时记账" title="向账户入金" close={close}><p>金额将写入双分录账本。</p><form className={styles.actionForm} onSubmit={submit}>
    <label>金额（元）<input name="amount" type="number" inputMode="decimal" min="0.01" max="1000000" step="0.01" required autoFocus /></label>
    <label>资金来源<select name="source"><option value="EXTERNAL_TRANSFER">外部账户转入</option><option value="CASH">现金存入</option></select></label>
    <label>外部参考号（选填）<input name="reference" maxLength={80} /></label>{error && <div className={styles.formError}>{error}</div>}
    <button className={styles.primaryButton} disabled={busy}>{busy ? "正在记账…" : "确认入金"}</button>
  </form><small>沙箱入金，不进入真实清算网络。</small></ModalShell>;
}

function TransferModal({ account, mfaConfigured, prepared, setPrepared, busy, setBusy, close, code, setCode, done }: { account: Account; mfaConfigured: boolean; prepared: PreparedTransfer | null; setPrepared: (value: PreparedTransfer | null) => void; busy: boolean; setBusy: (value: boolean) => void; close: () => void; code: string; setCode: (value: string) => void; done: () => Promise<void> }) {
  const [error, setError] = useState("");
  const prepare = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(""); const values = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/v1/transfers/prepare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fromAccountId: account.id, recipient: values.get("recipient"), amountMinor: Math.round(Number(values.get("amount")) * 100), note: values.get("note") }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message); setPrepared(result);
    } catch (err) { setError(err instanceof Error ? err.message : "转账草稿创建失败"); } finally { setBusy(false); }
  };
  const authorize = async () => {
    if (!prepared) return; setBusy(true); setError("");
    try {
      const response = await fetch(
        prepared.taskId ? `/api/operations/${prepared.operationId}/commit` : `/api/v1/operations/${prepared.operationId}/authorize`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(prepared.taskId
            ? { confirmed: true, totpCode: prepared.requiredAuth === "MFA" ? code : undefined, taskId: prepared.taskId, type: "TRANSFER" }
            : { totpCode: prepared.requiredAuth === "MFA" ? code : undefined }),
        },
      );
      const result = await response.json(); if (!response.ok) throw new Error(result.message ?? (result.error === "AUTH_INVALID" ? "动态验证码验证失败" : "执行失败")); await done();
    } catch (err) { setError(err instanceof Error ? err.message : "资金未转出"); } finally { setBusy(false); }
  };
  return <ModalShell eyebrow={prepared ? `${prepared.riskLevel === "RED" ? "红色风险" : "黄色风险"} · ${prepared.requiredAuth === "MFA" ? "强验证" : "用户确认"}` : "先核对，再执行"} title={prepared ? "核对转账" : "发起转账"} close={close}>{!prepared ? <><p>输入已注册用户的姓名或完整手机号。</p><form className={styles.actionForm} onSubmit={prepare}>
    <label>收款人<input name="recipient" required minLength={2} placeholder="姓名或完整手机号" autoFocus /></label><label>金额（元）<input name="amount" type="number" inputMode="decimal" min="0.01" max="1000000" step="0.01" required /></label><label>备注（选填）<input name="note" maxLength={80} /></label>{error && <div className={styles.formError}>{error}</div>}<button className={styles.primaryButton} disabled={busy}>{busy ? "正在核验…" : "继续核对"}</button>
  </form></> : <><div className={styles.transferReceipt}><strong>{money(prepared.details.amountMinor)}</strong><dl><div><dt>收款人</dt><dd>{prepared.details.recipient.name}</dd></div><div><dt>手机号</dt><dd>{prepared.details.recipient.phoneMasked}</dd></div><div><dt>付款账户</dt><dd>{prepared.details.sourceAccount.maskedNo}</dd></div><div><dt>操作编号</dt><dd>{prepared.operationId}</dd></div></dl></div>{prepared.requiredAuth === "MFA" && (mfaConfigured ? <label className={styles.reauthField}>验证器动态码<input inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="6 位动态验证码" autoComplete="one-time-code" autoFocus /></label> : <div className={styles.mfaRequired}><b>需要先启用多因素认证</b><span>此操作为红色风险，必须使用真实 TOTP 动态码。</span><a href="/security">前往安全中心设置</a></div>)}{error && <div className={styles.formError}>{error}</div>}<button className={styles.primaryButton} disabled={busy || (prepared.requiredAuth === "MFA" && (!mfaConfigured || code.length !== 6))} onClick={authorize}>{busy ? "账本处理中…" : "授权并执行"}</button><small>外部 Agent 无权点击此按钮；授权仅绑定当前操作编号。</small></>}</ModalShell>;
}

function CardModal({ account, busy, setBusy, close, done }: { account: Account; busy: boolean; setBusy: (value: boolean) => void; close: () => void; done: () => Promise<void> }) {
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setBusy(true); const values = new FormData(event.currentTarget); try { const response = await fetch("/api/v1/cards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: account.id, cardName: values.get("cardName") }) }); const result = await response.json(); if (!response.ok) throw new Error(result.message); await done(); } catch (err) { setError(err instanceof Error ? err.message : "开卡失败"); } finally { setBusy(false); } };
  return <ModalShell eyebrow="黄色风险 · 用户确认" title="申请虚拟卡" close={close}><p>虚拟卡绑定你的活期账户，默认日限额为 ¥1,000。系统只保存脱敏卡号。</p><form className={styles.actionForm} onSubmit={submit}><label>卡片名称<input name="cardName" defaultValue="日常虚拟卡" required minLength={2} maxLength={30} autoFocus /></label>{error && <div className={styles.formError}>{error}</div>}<button className={styles.primaryButton} disabled={busy}>{busy ? "正在开卡…" : "确认申请"}</button></form></ModalShell>;
}

function ProfileModal({ data, close, logout }: { data: Bootstrap; close: () => void; logout: () => Promise<void> }) {
  return <ModalShell eyebrow="当前账户" title={data.customer.display_name} close={close}><div className={styles.profileRows}><div><span>手机号</span><b>{data.customer.phone}</b></div><div><span>收款方式</span><b>姓名或手机号</b></div><div><span>账户号</span><b>{data.accounts[0]?.account_no ?? "—"}</b></div></div><a className={styles.developerLink} href="/security"><ShieldCheck size={17} /><span><b>安全中心</b><small>{data.customer.mfa_configured ? "强验证已开启" : "设置高风险操作验证"}</small></span><ChevronRight size={17} /></a><a className={styles.developerLink} href="/channels"><Link2 size={17} /><span><b>消息渠道</b><small>QQ 与企业微信</small></span><ChevronRight size={17} /></a><a className={styles.developerLink} href="/developers"><Sparkles size={17} /><span><b>外部 Agent</b><small>令牌与 MCP 接入</small></span><ChevronRight size={17} /></a><button className={styles.logoutButton} onClick={logout}><LogOut size={17} />退出登录</button></ModalShell>;
}

function ReauthModal({ code, setCode, close, submit }: { code: string; setCode: (value: string) => void; close: () => void; submit: () => void }) {
  return <ModalShell eyebrow="红色风险 · 强验证" title="确认是你本人" close={close}><p>输入身份验证器生成的 6 位动态码。连续失败 3 次后，此操作将安全熔断。</p><input className={styles.codeInput} inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="6 位动态验证码" autoComplete="one-time-code" autoFocus /><button className={styles.primaryButton} disabled={code.length !== 6} onClick={submit}><LockKeyhole size={17} />验证并执行</button><small>动态码只用于本次操作验证，不会写入 Agent 上下文或审计明文。</small></ModalShell>;
}

function CardsView({ data, onCreate, onLocked }: { data: Bootstrap | null; onCreate: () => void; onLocked: () => Promise<void> }) {
  const lock = async (card: Card) => {
    if (!window.confirm(`确认锁定 ${card.card_name} ${card.masked_no}？锁定后将暂停交易。`)) return;
    const response = await fetch(`/api/v1/cards/${card.id}/lock`, { method: "POST" });
    if (!response.ok) alert((await response.json()).message ?? "操作失败"); else await onLocked();
  };
  return <div className={styles.listView}><div className={styles.viewHeading}><p>卡片与限额</p><h1>我的卡</h1></div>{!data?.cards.length && <div className={styles.largeEmpty}><CreditCard size={28} /><b>还没有卡片</b><span>确认申请后，银行核心将实时签发一张虚拟卡。</span></div>}{data?.cards.map((card, index) => <section className={`${styles.bankCard} ${index === 1 ? styles.bankCardLight : ""}`} key={card.id}><div><span>B</span><small>{card.card_type === "VIRTUAL" ? "VIRTUAL" : "DEBIT"}</small></div><strong>{card.card_name}</strong><p>{card.masked_no}</p><footer><span>{card.status === "ACTIVE" ? "可用" : "已锁定"}</span><span>日限额 {money(card.daily_limit_minor)}</span></footer>{card.status === "ACTIVE" && <button className={styles.cardLock} onClick={() => lock(card)}>锁定</button>}</section>)}<button className={styles.outlineAction} onClick={onCreate}><Plus size={18} />申请虚拟卡<ChevronRight size={17} /></button></div>;
}
