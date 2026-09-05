"use client";

import { ArrowLeft, Check, ChevronRight, CircleAlert, GitBranch, RefreshCw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import styles from "./AuditConsole.module.css";

type Node = { key: string; tool: string; status: string; dependencies: string[]; output: Record<string, unknown> };
type Task = { id: string; user_utterance: string; intent: string; status: string; risk_level: "GREEN" | "YELLOW" | "RED"; plan: unknown[]; created_at: string; nodes: Node[]; runtime_status?: string; channel_type?: string; interrupt_kind?: string | null; graph_thread_id?: string };
type Event = { id: string; task_id?: string; operation_id?: string; event_type: string; actor_type: string; event_summary: string; evidence: Record<string, unknown>; created_at: string };
type Policy = { id: string; task_id: string; operation_id: string; base_level: string; final_level: string; matched_rules: string[]; evidence: Record<string, unknown>; created_at: string };
type McpInvocation = { id: string; tool_name: string; outcome: string; operation_id?: string; input_summary: Record<string, unknown>; created_at: string };
type ChannelEvent = { id: string; task_id?: string; channel_type: string; direction: string; event_type: string; outcome: string; created_at: string };
type ChannelIdentity = { id: string; channel_type: string; status: string; bound_at: string; last_seen_at: string };

export function AuditConsole() {
  const [data, setData] = useState<{ tasks: Task[]; events: Event[]; policies: Policy[]; mcpInvocations: McpInvocation[]; channelEvents: ChannelEvent[]; channels: ChannelIdentity[]; outbox: Array<{ status: string; count: number }> } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = () => fetch("/api/audit", { cache: "no-store" }).then((response) => { if (!response.ok) throw new Error(); return response.json(); }).then((value) => { setData(value); setSelected((current) => current ?? value.tasks[0]?.id ?? null); setError(""); }).catch(() => setError("无法读取审计数据库"));
  useEffect(() => { load(); }, []);
  const task = data?.tasks.find((item) => item.id === selected);
  const events = data?.events.filter((item) => !selected || item.task_id === selected || !item.task_id) ?? [];
  const policy = data?.policies.find((item) => item.task_id === selected);
  const channelEvents = data?.channelEvents.filter((item) => item.task_id === selected) ?? [];

  return <main className={styles.page}>
    <header className={styles.header}><Link href="/"><ArrowLeft size={18} />返回 BankPilot</Link><div><span>B</span><b>安全审计台</b></div><button onClick={load}><RefreshCw size={16} />刷新</button></header>
    <section className={styles.hero}><div><p>CONTROL PLANE / READ ONLY</p><h1>每一步，均可解释。</h1><span>Agent 计划、权限裁决、工具调用与核心账本结果统一留痕。</span></div><div className={styles.health}><i /><span><b>所有系统正常</b><small>PostgreSQL · Policy Engine · Ledger</small></span></div></section>
    {error && <div className={styles.error}>{error}</div>}
    <div className={styles.grid}>
      <aside className={styles.tasks}><div className={styles.panelTitle}><span>最近 Agent 任务</span><small>{data?.tasks.length ?? 0} TASKS</small></div>{data?.tasks.map((item) => <button className={selected === item.id ? styles.selected : ""} key={item.id} onClick={() => setSelected(item.id)}><span className={styles.level} data-level={item.risk_level} /><span><b>{item.user_utterance}</b><small>{item.intent} · {new Date(item.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small></span><ChevronRight size={15} /></button>)}</aside>
      <section className={styles.detail}>
        {task ? <>
          <div className={styles.detailHead}><div><span className={styles.badge} data-level={task.risk_level}>{task.risk_level}</span><h2>{task.user_utterance}</h2><p>Task ID · {task.id}{task.channel_type ? ` · ${task.channel_type}` : ""}{task.interrupt_kind ? ` · 等待 ${task.interrupt_kind}` : ""}</p></div><strong data-status={task.runtime_status ?? task.status}>{task.runtime_status ?? task.status}</strong></div>
          <div className={styles.subhead}><GitBranch size={17} /><b>执行计划 DAG</b><span>{task.nodes.length} 个已运行节点</span></div>
          <div className={styles.dag}>{task.nodes.length ? task.nodes.map((node, index) => <div className={styles.node} key={node.key}><div className={styles.nodeIndex}>{index + 1}</div><div><b>{node.key}</b><code>{node.tool}</code></div><span>{node.dependencies.length ? `依赖 ${node.dependencies.join(", ")}` : "入口节点"}</span><Check size={16} /></div>) : <p className={styles.empty}>任务尚未执行工具节点</p>}</div>
          {policy && <section className={styles.policy}><div className={styles.subhead}><ShieldCheck size={17} /><b>权限策略裁决</b></div><div className={styles.policyRoute}><span data-level={policy.base_level}>{policy.base_level}</span><i /><span data-level={policy.final_level}>{policy.final_level}</span><strong>{policy.final_level === "RED" ? "MFA 强验证" : "用户明确确认"}</strong></div><ul>{policy.matched_rules.map((rule) => <li key={rule}><Check size={13} />{rule}</li>)}</ul></section>}
          {channelEvents.length > 0 && <><div className={styles.subhead}><GitBranch size={17} /><b>渠道事件</b><span>{channelEvents.length} 条</span></div><div className={styles.dag}>{channelEvents.map((event) => <div className={styles.node} key={event.id}><div className={styles.nodeIndex}><Image src={event.channel_type === "QQ" ? "/brands/qq.svg" : "/brands/wecom.svg"} alt="" width={18} height={18} /></div><div><b>{event.event_type}</b><code>{event.direction} · {event.outcome}</code></div><span>{new Date(event.created_at).toLocaleTimeString("zh-CN")}</span><Check size={16} /></div>)}</div></>}
          <div className={styles.subhead}><CircleAlert size={17} /><b>不可变事件流</b><span>{events.length} 条</span></div>
          <div className={styles.timeline}>{events.map((event) => <article key={event.id}><time>{new Date(event.created_at).toLocaleTimeString("zh-CN")}</time><i /><div><b>{event.event_summary}</b><span>{event.actor_type} · {event.event_type}</span>{event.operation_id && <code>{event.operation_id}</code>}</div></article>)}</div>
        </> : <><div className={styles.detailHead}><div><span className={styles.badge} data-level="GREEN">CORE</span><h2>账户安全事件</h2><p>没有 Agent 任务时，仍展示银行核心与身份事件。</p></div></div><div className={styles.subhead}><CircleAlert size={17} /><b>事件流</b><span>{data?.events.length ?? 0} 条</span></div><div className={styles.timeline}>{data?.events.map((event) => <article key={event.id}><time>{new Date(event.created_at).toLocaleTimeString("zh-CN")}</time><i /><div><b>{event.event_summary}</b><span>{event.actor_type} · {event.event_type}</span>{event.operation_id && <code>{event.operation_id}</code>}</div></article>)}</div>{Boolean(data?.mcpInvocations.length) && <><div className={styles.subhead}><GitBranch size={17} /><b>MCP 调用</b><span>{data?.mcpInvocations.length} 条</span></div><div className={styles.dag}>{data?.mcpInvocations.map((call) => <div className={styles.node} key={call.id}><div className={styles.nodeIndex}>M</div><div><b>{call.tool_name}</b><code>{call.operation_id ?? call.outcome}</code></div><span>{new Date(call.created_at).toLocaleTimeString("zh-CN")}</span><Check size={16} /></div>)}</div></>}</>}
      </section>
    </div>
  </main>;
}
