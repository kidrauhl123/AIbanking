"use client";

import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { currentBankMonth, validBankMonth, type BankStatement, type BankSubscription } from "@/lib/banking-report";
import styles from "./BankingViews.module.css";

const money = (minor: number | string) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(Number(minor) / 100);
const date = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).format(new Date(value));

function Back({ onBack }: { onBack: () => void }) {
  return <button className={styles.back} onClick={onBack}><ArrowLeft size={20} />返回首页</button>;
}

export function StatementView({ initial, onBack }: { initial?: BankStatement; onBack: () => void }) {
  const [month, setMonth] = useState(initial?.month ?? currentBankMonth());
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ month: string; report?: BankStatement; error?: string }>({ month, report: initial });
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1/statements?month=${encodeURIComponent(month)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.message ?? "账单暂时无法加载");
        if (!controller.signal.aborted) setResult({ month, report: body });
      }).catch((error) => {
        if (!controller.signal.aborted) setResult({ month, error: error instanceof Error ? error.message : "账单暂时无法加载" });
      });
    return () => controller.abort();
  }, [month, revision]);
  const report = result.month === month ? result.report : undefined;
  const error = result.month === month ? result.error : undefined;
  const changeMonth = (step: number) => {
    const next = new Date(`${month}-01T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + step);
    setMonth(next.toISOString().slice(0, 7));
  };
  return <div className={styles.page}>
    <Back onBack={onBack} /><h1>账单分析</h1>
    <div className={styles.monthPicker}>
      <button aria-label="上个月" disabled={month <= "2000-01"} onClick={() => changeMonth(-1)}><ChevronLeft size={20} /></button>
      <input aria-label="账单月份" type="month" value={month} min="2000-01" max={currentBankMonth()} onChange={(event) => { if (validBankMonth(event.target.value) && event.target.value <= currentBankMonth()) setMonth(event.target.value); }} />
      <button aria-label="下个月" disabled={month >= currentBankMonth()} onClick={() => changeMonth(1)}><ChevronRight size={20} /></button>
    </div>
    {error ? <div className={styles.notice} role="alert"><p>{error}</p><button onClick={() => { setResult({ month }); setRevision((value) => value + 1); }}><RefreshCw size={16} />重新加载</button></div> : !report ? <p className={styles.empty} role="status">正在读取账单…</p> : <>
      <section className={styles.summary} aria-label="月度收支">
        <p>支出与转出</p><strong>{money(report.expenseMinor)}</strong>
        <div><span>收入与转入</span><b>{money(report.incomeMinor)}</b></div>
        <div><span>净流入</span><b>{money(report.incomeMinor - report.expenseMinor)}</b></div>
        <small>{report.transactionCount} 笔交易 · 按北京时间统计</small>
      </section>
      <section className={styles.section}><h2>支出去向</h2>
        {!report.categories.length ? <p className={styles.empty}>这个月还没有支出。</p> : report.categories.map((item) => <div className={styles.category} key={item.category}>
          <div><b>{item.category}</b><strong>{money(item.totalMinor)}</strong></div>
          <div><span>{item.count} 笔</span><span>{(item.totalMinor / report.expenseMinor * 100).toFixed(1)}%</span></div>
          <meter min={0} max={report.expenseMinor} value={item.totalMinor} aria-label={`${item.category}支出占比`} />
        </div>)}
      </section>
      <section className={styles.section}><h2>待核实交易 <span>{report.anomalyCount}</span></h2>
        {!report.anomalyCount ? <p className={styles.empty}>这个月没有被标记的异常交易。</p> : <>
          <p className={styles.caption}>以下交易已有异常标记，请核对是否为本人操作。</p>
          {report.anomalies.map((item) => <div className={styles.row} key={item.id}><div><b>{item.merchantName}</b><span>{date(item.occurredAt)}</span></div><strong>{money(item.amountMinor)}</strong></div>)}
          {report.anomalyCount > report.anomalies.length && <p className={styles.caption}>显示最近 {report.anomalies.length} 笔</p>}
        </>}
      </section>
    </>}
  </div>;
}

const subscriptionStatus: Record<string, string> = { ACTIVE: "代扣中", BLOCKED: "已停止代扣", CANCELLED: "已取消", CANCEL_PENDING: "取消处理中" };

export function SubscriptionsView({ items, available, onBack, onChanged }: { items: BankSubscription[]; available: boolean; onBack: () => void; onChanged: () => Promise<void> }) {
  const [selected, setSelected] = useState<BankSubscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  const subscriptions = items.map((item) => blockedIds.includes(item.id) ? { ...item, status: "BLOCKED" } : item);
  const active = subscriptions.filter((item) => item.status === "ACTIVE");
  const knownCycles = active.every((item) => ["MONTHLY", "YEARLY"].includes(item.billing_cycle));
  const monthly = active.reduce((sum, item) => sum + Number(item.amount_minor) / (item.billing_cycle === "YEARLY" ? 12 : 1), 0);
  const block = async () => {
    if (!selected || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/v1/subscriptions/${selected.id}/block`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "未能停止代扣，请重试");
      setBlockedIds((ids) => [...ids, selected.id]);
      setNotice(`已停止 ${selected.merchant_name} 的本行代扣。`); setSelected(null);
      await onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "操作失败，请重试"); }
    finally { setBusy(false); }
  };
  return <div className={styles.page}>
    <Back onBack={onBack} /><h1>订阅管理</h1>
    {!available ? <p className={styles.notice} role="alert">订阅暂时无法读取，请稍后重试。</p> : <>
      <section className={styles.summary}><p>每月预计代扣</p><strong>{knownCycles ? money(Math.round(monthly)) : "—"}</strong><small>{active.length} 项代扣中{knownCycles ? " · 年付按 12 个月折算" : " · 含非月付或年付项目"}</small></section>
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {!subscriptions.length ? <p className={styles.empty}>还没有订阅代扣记录。</p> : <section className={styles.section} aria-label="订阅列表">{subscriptions.map((item) => <article className={styles.subscription} key={item.id}>
        <div className={styles.row}><div><b>{item.merchant_name}</b><span>{subscriptionStatus[item.status] ?? item.status}{item.status === "ACTIVE" ? ` · 下次 ${date(item.next_charge_at)}` : ""}</span></div><strong>{money(item.amount_minor)}<small>/{item.billing_cycle === "YEARLY" ? "年" : item.billing_cycle === "MONTHLY" ? "月" : "次"}</small></strong></div>
        {item.status === "ACTIVE" && <button className={styles.stop} onClick={() => { setSelected(item); setError(""); }}>停止代扣</button>}
      </article>)}</section>}
      <p className={styles.caption}>停止本行代扣后，商户订阅仍需到商户处取消。</p>
    </>}
    {selected && <div className={styles.backdrop}><section className={styles.dialog} role="dialog" aria-modal="true" aria-label="确认停止代扣">
      <h2>停止这项代扣？</h2><p>{selected.merchant_name}</p><strong>{money(selected.amount_minor)}/{selected.billing_cycle === "YEARLY" ? "年" : selected.billing_cycle === "MONTHLY" ? "月" : "次"}</strong>
      <p>确认后将停止通过本行卡片的后续代扣，商户订阅不会自动取消。</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <button className={styles.confirm} disabled={busy} onClick={block}>{busy ? "正在处理…" : "确认停止代扣"}</button><button className={styles.keep} disabled={busy} onClick={() => setSelected(null)}>保留代扣</button>
    </section></div>}
  </div>;
}
