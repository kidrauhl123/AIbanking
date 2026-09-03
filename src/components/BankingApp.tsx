"use client";

import {
  ArrowDownLeft, ArrowUpRight, Bell, ChartNoAxesColumnIncreasing, Check,
  ChevronRight, CircleCheck, CreditCard, Eye, House, LockKeyhole,
  RefreshCw, ScanFace, Send, ShieldCheck, Sparkles, X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ServiceWorkerRegister } from "./ServiceWorkerRegister";
import styles from "./BankingApp.module.css";

type Account = { id: string; name: string; masked_no: string; account_type: string; available_balance_minor: string; currency: string; status: string };
type Transaction = { id: string; merchant_name: string; category: string; amount_minor: string; occurred_at: string; is_anomaly: boolean };
type Card = { id: string; card_name: string; masked_no: string; card_type: string; status: string; daily_limit_minor: string };
type Subscription = { id: string; merchant_name: string; amount_minor: string; billing_cycle: string; next_charge_at: string; status: string };
type Bootstrap = { customer: { display_name: string }; totalMinor: number; accounts: Account[]; transactions: Transaction[]; cards: Card[]; subscriptions: Subscription[]; ai: { configured: boolean; model: string | null } };
type Operation = {
  type: "TRANSFER" | "CARD_LOCK" | "SUBSCRIPTION_CANCEL"; operationId: string; title: string;
  riskLevel: "GREEN" | "YELLOW" | "RED"; requiredAuth: "CONFIRM" | "MFA";
  details: Array<{ label: string; value: string }>; resourceId?: string; actionLabel: string;
};
type Reply = { taskId: string; intent: string; message: string; operation?: Operation; data?: Record<string, unknown>; suggestions?: string[]; ai?: { model: string; confidence: number } };
type ChatItem = { id: string; role: "user" | "agent"; text: string; reply?: Reply; state?: "idle" | "executing" | "done" | "failed"; receipt?: { operationId: string; status: string; receipt?: { reference?: string }; amountMinor?: number; beneficiary?: string; card?: string } };
type Tab = "home" | "agent" | "activity" | "cards";

const money = (minor: number | string) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(Number(minor) / 100);
const shortDate = (date: string) => new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(date));
const prompts = ["给张伟转 200 元", "分析本月账单", "查看订阅扣费", "锁定我的日常卡"];

export function BankingApp() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [balanceVisible, setBalanceVisible] = useState(true);
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [mfa, setMfa] = useState<{ itemId: string; operation: Operation; taskId: string } | null>(null);
  const [code, setCode] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/bootstrap", { cache: "no-store" });
      if (!response.ok) throw new Error("load");
      setData(await response.json()); setError("");
    } catch { setError("银行核心未连接，请先启动 PostgreSQL 数据库。"); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chats, sending, tab]);

  const send = async (text = input) => {
    const message = text.trim(); if (!message || sending) return;
    setTab("agent"); setInput(""); setSending(true);
    setChats((items) => [...items, { id: crypto.randomUUID(), role: "user", text: message }]);
    try {
      const history = chats.slice(-8).map((item) => ({ role: item.role === "agent" ? "assistant" : "user", content: item.text }));
      const response = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, history }) });
      const reply = await response.json(); if (!response.ok) throw new Error(reply.message);
      setChats((items) => [...items, { id: crypto.randomUUID(), role: "agent", text: reply.message, reply, state: "idle" }]);
    } catch (err) {
      setChats((items) => [...items, { id: crypto.randomUUID(), role: "agent", text: err instanceof Error ? err.message : "本次请求没有执行，请重试。", state: "failed" }]);
    } finally { setSending(false); }
  };

  const onSubmit = (event: FormEvent) => { event.preventDefault(); send(); };

  const commit = async (itemId: string, operation: Operation, taskId: string, mfaCode?: string) => {
    if (operation.requiredAuth === "MFA" && !mfaCode) { setMfa({ itemId, operation, taskId }); return; }
    setChats((items) => items.map((item) => item.id === itemId ? { ...item, state: "executing" } : item));
    try {
      const response = await fetch(`/api/operations/${operation.operationId}/commit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, code: mfaCode, taskId, resourceId: operation.resourceId, type: operation.type }),
      });
      const result = await response.json(); if (!response.ok) throw new Error(result.message);
      setChats((items) => items.map((item) => item.id === itemId ? { ...item, state: "done", receipt: result } : item));
      setMfa(null); setCode(""); await load();
    } catch (err) {
      setChats((items) => items.map((item) => item.id === itemId ? { ...item, state: "failed", text: `${item.text}\n\n${err instanceof Error ? err.message : "操作失败，资金未变动。"}` } : item));
      setMfa(null); setCode("");
    }
  };

  const totalOutgoing = useMemo(() => data?.transactions.filter((item) => Number(item.amount_minor) < 0).reduce((sum, item) => sum + Math.abs(Number(item.amount_minor)), 0) ?? 0, [data]);

  return <main className={styles.stage}>
    <ServiceWorkerRegister />
    <section className={styles.phone} aria-label="BankPilot 手机银行">
      <header className={styles.topbar}>
        <button className={styles.avatar} aria-label="个人中心">LM</button>
        <div className={styles.wordmark}><span>B</span> BankPilot</div>
        <button className={styles.iconButton} aria-label="通知"><Bell size={20} strokeWidth={1.8} /><i /></button>
      </header>
      {error && <div className={styles.connectionError}><span>{error}</span><button onClick={load}><RefreshCw size={15} />重试</button></div>}
      <div className={styles.viewport}>
        {tab === "home" && <HomeView data={data} loading={loading} visible={balanceVisible} toggleVisible={() => setBalanceVisible(!balanceVisible)} outgoing={totalOutgoing} onAgent={send} />}
        {tab === "agent" && <AgentView chats={chats} sending={sending} coreConnected={!error} aiStatus={data?.ai ?? { configured: false, model: null }} onPrompt={send} onCommit={commit} bottomRef={bottomRef} />}
        {tab === "activity" && <ActivityView data={data} />}
        {tab === "cards" && <CardsView data={data} onAgent={send} />}
      </div>
      {tab === "agent" && <form className={styles.composer} onSubmit={onSubmit}><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="说出你想办理的业务…" aria-label="向银行 Agent 发送消息" /><button type="submit" disabled={!input.trim() || sending} aria-label="发送"><Send size={18} /></button></form>}
      <nav className={styles.nav} aria-label="主导航">
        <NavButton active={tab === "home"} label="首页" icon={<House size={21} />} onClick={() => setTab("home")} />
        <NavButton active={tab === "agent"} label="AI 助手" icon={<Sparkles size={21} />} onClick={() => setTab("agent")} />
        <NavButton active={tab === "activity"} label="明细" icon={<ChartNoAxesColumnIncreasing size={21} />} onClick={() => setTab("activity")} />
        <NavButton active={tab === "cards"} label="卡片" icon={<CreditCard size={21} />} onClick={() => setTab("cards")} />
      </nav>
    </section>
    <a className={styles.auditLink} href="/audit" target="_blank"><ShieldCheck size={16} /> 打开安全审计台 <ChevronRight size={15} /></a>
    {mfa && <div className={styles.modalBackdrop} role="presentation"><section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="mfa-title">
      <button className={styles.modalClose} onClick={() => { setMfa(null); setCode(""); }} aria-label="关闭"><X size={20} /></button>
      <div className={styles.mfaIcon}><ScanFace size={28} /></div><p className={styles.eyebrow}>强验证 · RED</p><h2 id="mfa-title">确认是你本人</h2>
      <p>验证码已发送至 138****0001。演示环境请输入 <b>123456</b>。</p>
      <input className={styles.codeInput} inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="6 位验证码" autoFocus />
      <button className={styles.primaryButton} disabled={code.length !== 6} onClick={() => commit(mfa.itemId, mfa.operation, mfa.taskId, code)}><LockKeyhole size={17} />验证并执行</button>
      <small>验证码只授权当前金额、收款人和付款账户，10 分钟后失效。</small>
    </section></div>}
  </main>;
}

function NavButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick: () => void }) {
  return <button className={active ? styles.navActive : ""} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function HomeView({ data, loading, visible, toggleVisible, outgoing, onAgent }: { data: Bootstrap | null; loading: boolean; visible: boolean; toggleVisible: () => void; outgoing: number; onAgent: (text: string) => void }) {
  return <div className={styles.home}>
    <section className={styles.balanceBlock}><div className={styles.labelRow}><span>总资产</span><button onClick={toggleVisible} aria-label="隐藏或显示余额"><Eye size={16} /></button></div><div className={styles.balance}>{loading ? "—" : visible ? money(data?.totalMinor ?? 0) : "••••••"}</div><div className={styles.balanceMeta}><span>可用余额</span><span className={styles.positive}>本月 +1.8%</span></div></section>
    <div className={styles.quickActions}>
      <button onClick={() => onAgent("给张伟转 200 元")}><span><ArrowUpRight /></span>转账</button>
      <button onClick={() => onAgent("分析本月账单")}><span><ChartNoAxesColumnIncreasing /></span>分析</button>
      <button onClick={() => onAgent("查看订阅扣费")}><span><RefreshCw /></span>订阅</button>
      <button onClick={() => onAgent("锁定我的日常卡")}><span><LockKeyhole /></span>锁卡</button>
    </div>
    <button className={styles.agentCallout} onClick={() => onAgent("分析本月账单")}><span className={styles.agentMark}><Sparkles size={20} /></span><span><b>问 BankPilot</b><small>用一句话查账、转账或管理卡片</small></span><ChevronRight size={18} /></button>
    <section className={styles.section}><div className={styles.sectionHead}><div><p>本月概览</p><h2>{money(outgoing)}</h2></div><button onClick={() => onAgent("分析本月账单")}>查看分析</button></div><div className={styles.meter}><i style={{ width: `${Math.min(88, Math.max(18, outgoing / 6000))}%` }} /></div><div className={styles.meterLabels}><span>已支出</span><span>预算 ¥6,000</span></div></section>
    <section className={styles.section}><div className={styles.sectionTitle}><h2>最近交易</h2><span>全部</span></div><TransactionList items={data?.transactions.slice(0, 4) ?? []} /></section>
  </div>;
}

function TransactionList({ items }: { items: Transaction[] }) {
  return <div className={styles.transactionList}>{items.map((item) => <div className={styles.transaction} key={item.id}>
    <span className={Number(item.amount_minor) >= 0 ? styles.txIconIn : styles.txIcon}>{Number(item.amount_minor) >= 0 ? <ArrowDownLeft size={19} /> : item.merchant_name.slice(0, 1)}</span>
    <span className={styles.txCopy}><b>{item.merchant_name}</b><small>{item.category} · {shortDate(item.occurred_at)}{item.is_anomaly && <em>需核实</em>}</small></span>
    <strong className={Number(item.amount_minor) >= 0 ? styles.positive : ""}>{Number(item.amount_minor) >= 0 ? "+" : "−"}{money(Math.abs(Number(item.amount_minor)))}</strong>
  </div>)}</div>;
}

function AgentView({ chats, sending, coreConnected, aiStatus, onPrompt, onCommit, bottomRef }: { chats: ChatItem[]; sending: boolean; coreConnected: boolean; aiStatus: { configured: boolean; model: string | null }; onPrompt: (text: string) => void; onCommit: (itemId: string, operation: Operation, taskId: string) => void; bottomRef: React.RefObject<HTMLDivElement | null> }) {
  const ready = coreConnected && aiStatus.configured;
  const statusText = !coreConnected ? "银行核心未连接" : aiStatus.configured ? `${aiStatus.model} · 核心已连接` : "真实 AI 模型未配置";
  return <div className={styles.agentView}><div className={styles.agentHeading}><div className={styles.agentOrb}><Sparkles size={21} /></div><div><h1>BankPilot</h1><p><i data-offline={!ready || undefined} /> {statusText}</p></div></div>
    <div className={styles.promptRail}>{prompts.map((prompt) => <button key={prompt} onClick={() => onPrompt(prompt)}>{prompt}</button>)}</div>
    <div className={styles.messages}>{chats.map((item) => item.role === "user" ? <div className={styles.userMessage} key={item.id}>{item.text}</div> : <div className={styles.agentMessage} key={item.id}><div className={styles.miniOrb}><Sparkles size={13} /></div><div className={styles.messageContent}>{item.reply?.ai && <span className={styles.aiProof}>AI · {item.reply.ai.model} · {Math.round(item.reply.ai.confidence * 100)}%</span>}<p>{item.text}</p>{item.reply?.data && <ReplyData reply={item.reply} />}{item.reply?.operation && <OperationCard item={item} operation={item.reply.operation} onCommit={() => onCommit(item.id, item.reply!.operation!, item.reply!.taskId)} />}</div></div>)}
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

function OperationCard({ item, operation, onCommit }: { item: ChatItem; operation: Operation; onCommit: () => void }) {
  const done = item.state === "done";
  return <section className={`${styles.operationCard} ${done ? styles.operationDone : ""}`}>
    <div className={styles.operationHead}><span className={styles.riskDot} data-level={operation.riskLevel} /><div><small>可验证操作凭证</small><b>{done ? "执行成功" : operation.title}</b></div>{done ? <CircleCheck size={22} /> : <span className={styles.riskTag} data-level={operation.riskLevel}>{operation.riskLevel}</span>}</div>
    <div className={styles.operationAmount}>{operation.details[0]?.value}</div><dl>{operation.details.slice(1).map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}</dl>
    <div className={styles.operationId}><span>操作编号</span><code>{operation.operationId}</code></div>
    {done ? <div className={styles.successReceipt}><Check size={16} /><span><b>账本已入账</b><small>{item.receipt?.receipt?.reference ?? "状态已同步至银行核心"}</small></span></div> : <button className={styles.executeButton} disabled={item.state === "executing"} onClick={onCommit}>{item.state === "executing" ? <RefreshCw className={styles.spin} size={17} /> : operation.requiredAuth === "MFA" ? <LockKeyhole size={17} /> : <ShieldCheck size={17} />}{item.state === "executing" ? "银行核心处理中" : operation.actionLabel}</button>}
    {!done && <p className={styles.authorizationNote}>{operation.requiredAuth === "MFA" ? "需要短信验证码 · 授权仅绑定本次交易" : "点击即表示你确认以上信息"}</p>}
  </section>;
}

function ActivityView({ data }: { data: Bootstrap | null }) {
  return <div className={styles.listView}><div className={styles.viewHeading}><p>所有明细</p><h1>账户活动</h1></div><div className={styles.filterPills}><button className={styles.selected}>全部</button><button>支出</button><button>收入</button><button>异常</button></div><section className={styles.section}><TransactionList items={data?.transactions ?? []} /></section></div>;
}

function CardsView({ data, onAgent }: { data: Bootstrap | null; onAgent: (text: string) => void }) {
  return <div className={styles.listView}><div className={styles.viewHeading}><p>卡片与限额</p><h1>我的卡</h1></div>{data?.cards.map((card, index) => <section className={`${styles.bankCard} ${index === 1 ? styles.bankCardLight : ""}`} key={card.id}><div><span>B</span><small>{card.card_type === "VIRTUAL" ? "VIRTUAL" : "DEBIT"}</small></div><strong>{card.card_name}</strong><p>{card.masked_no}</p><footer><span>{card.status === "ACTIVE" ? "可用" : "已锁定"}</span><span>日限额 {money(card.daily_limit_minor)}</span></footer></section>)}<button className={styles.outlineAction} onClick={() => onAgent("锁定我的日常卡")}><LockKeyhole size={18} />通过 AI 管理卡片<ChevronRight size={17} /></button></div>;
}
