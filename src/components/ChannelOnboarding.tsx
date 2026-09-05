"use client";

import { ArrowLeft, ArrowUpRight, Check, Copy, RefreshCw } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import type { ChannelSetup } from "@/lib/channel-onboarding";
import styles from "./ChannelSettings.module.css";

export function ChannelOnboarding({ provider, bound, onRefresh, onClose }: { provider: ChannelSetup; bound: boolean; onRefresh: () => Promise<void>; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  const [checking, setChecking] = useState(false);
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setCopyStatus("已复制"); }
    catch { setCopyStatus("未能复制，请长按文字手动复制。"); }
  };
  const refresh = async () => { setChecking(true); try { await onRefresh(); } finally { setChecking(false); } };
  return <section className={styles.guide} aria-label={`${provider.name}接入引导`}>
    <button className={styles.backButton} onClick={onClose}><ArrowLeft size={18} />选择其他渠道</button>
    <div className={styles.guideTitle}><Image src={provider.channelType === "QQ" ? "/brands/qq.svg" : "/brands/wecom.svg"} alt="" width={36} height={36} /><h2>{bound ? "已经连接" : `连接${provider.name}`}</h2></div>
    {bound ? <>
      <div className={styles.done} role="status"><Check size={20} /><span>{provider.name}已绑定到当前银行账户。</span></div>
      <p className={styles.guideCopy}>回到 {provider.botName} 的私聊，发送“查余额”即可开始使用。</p>
      {provider.entryUrl && <a className={styles.primary} href={provider.entryUrl} target="_blank" rel="noopener noreferrer">打开{provider.name}机器人 <ArrowUpRight size={17} /></a>}
      <button className={styles.secondary} onClick={() => copy("查余额")}>复制“查余额” <Copy size={16} /></button>
    </> : <>
      <ol className={styles.steps} aria-label="接入步骤">{["添加机器人", "发送绑定", "确认账户"].map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
      {!provider.canStart && <div className={styles.unavailable} role="status"><b>暂未开放接入</b><p>{provider.unavailableReason}</p><small>无需你申请机器人或填写 API Key。开通后可在这里直接添加。</small><button className={styles.secondary} onClick={refresh} disabled={checking}>{checking ? "检查中…" : "检查是否已开通"}</button></div>}
      {step === 0 && <>
        <h3>先添加 {provider.botName}</h3>
        <p className={styles.guideCopy}>{provider.channelType === "QQ" ? "打开机器人资料页，添加后点“发消息”，进入私聊。" : "使用企业微信打开机器人入口，按页面提示添加并进入私聊。请使用已获访问权限的企业账号。"}</p>
        {provider.entryUrl && <a className={styles.primary} href={provider.entryUrl} target="_blank" rel="noopener noreferrer" onClick={() => setStep(1)}>打开{provider.name}，添加机器人 <ArrowUpRight size={17} /></a>}
        {provider.qrDataUrl && <details className={styles.qr}><summary>在电脑上？用{provider.name}扫码添加</summary><Image src={provider.qrDataUrl} alt={`${provider.name}机器人添加二维码`} width={232} height={232} unoptimized /><p>用{provider.name}扫一扫上方二维码</p></details>}
        {provider.entryUrl && <button className={styles.secondary} onClick={() => copy(provider.entryUrl!)}>复制添加链接 <Copy size={16} /></button>}
        <button className={styles.textButton} onClick={() => setStep(1)}>已添加机器人，下一步</button>
      </>}
      {step === 1 && <>
        <h3>在机器人私聊里发送</h3>
        <div className={styles.command}><code>绑定</code><button onClick={() => copy("绑定")} aria-label="复制绑定消息"><Copy size={18} />复制</button></div>
        <p className={styles.guideCopy}>机器人会回复一条 BankPilot 绑定链接。打开它，登录并确认你的银行账户。链接 10 分钟内有效。</p>
        {provider.entryUrl && <a className={styles.secondary} href={provider.entryUrl} target="_blank" rel="noopener noreferrer">打开机器人私聊 <ArrowUpRight size={16} /></a>}
        <button className={styles.primary} onClick={() => { setStep(2); void refresh(); }}>我已发送，继续</button>
        <button className={styles.textButton} onClick={() => setStep(0)}>返回添加步骤</button>
      </>}
      {step === 2 && <>
        <h3>打开机器人发来的绑定链接</h3>
        <p className={styles.guideCopy}>在打开的 BankPilot 页面核对账户，再点“确认连接”。完成后，这里会自动更新。</p>
        <p className={styles.waiting} role="status">尚未检测到绑定完成</p>
        <button className={styles.primary} disabled={checking} onClick={refresh}><RefreshCw size={17} className={checking ? styles.spin : undefined} />{checking ? "正在检查…" : "我已确认，检查连接"}</button>
        <button className={styles.textButton} onClick={() => setStep(1)}>没收到链接？回到上一步</button>
      </>}
    </>}
    {copyStatus && <p className={styles.copyStatus} role="status">{copyStatus}</p>}
    <details className={styles.help}><summary>遇到问题？</summary>
      <h4>找不到机器人，或没有回复</h4><p>{provider.channelType === "QQ" ? "QQ 沙箱阶段仅测试成员可用，请让管理员将你的 QQ 加入测试名单；已发布的机器人按平台可见范围添加。" : "请确认加入了正确的企业，并且机器人对你可见；看不到入口时，请让企业管理员开放使用范围。"}还需确认机器人服务已启动。</p>
      <h4>链接打不开或已过期</h4><p>回到机器人私聊重新发送“绑定”，使用最新链接。只打开来自你本人私聊的链接。</p>
      <h4>添加成功，但这里还显示未绑定</h4><p>添加机器人不等于授权银行账户。还需要打开它回复的链接并点“确认连接”。</p>
    </details>
  </section>;
}
