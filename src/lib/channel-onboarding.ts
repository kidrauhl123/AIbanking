export type ChannelSetup = {
  channelType: "QQ" | "WECOM";
  name: string;
  botName: string;
  entryUrl: string | null;
  canStart: boolean;
  unavailableReason: string | null;
  qrDataUrl?: string;
};

export function trustedBotEntry(value: string | undefined) {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    if (url.hostname !== "qq.com" && !url.hostname.endsWith(".qq.com")) return null;
    return url.href;
  } catch { return null; }
}

export function channelSetups(env: Record<string, string | undefined> = process.env): ChannelSetup[] {
  let hasPublicUrl = false;
  try { hasPublicUrl = new URL(env.BANKPILOT_PUBLIC_URL ?? "").protocol === "https:"; } catch { /* Not configured. */ }
  return (["QQ", "WECOM"] as const).map((channelType) => {
    const entryUrl = trustedBotEntry(env[`${channelType}_BOT_ENTRY_URL`]);
    const configured = !!env[`${channelType}_ADAPTER_TOKEN`]?.trim() && hasPublicUrl;
    return {
      channelType,
      name: channelType === "QQ" ? "QQ" : "企业微信",
      botName: env[`${channelType}_BOT_NAME`]?.trim().slice(0, 60) || "BankPilot",
      entryUrl: configured ? entryUrl : null,
      canStart: configured && !!entryUrl,
      unavailableReason: !configured ? "机器人服务尚未开通，请等待管理员开放。" : !entryUrl ? "管理员尚未提供机器人添加入口，暂时不能开始绑定。" : null,
    };
  });
}
