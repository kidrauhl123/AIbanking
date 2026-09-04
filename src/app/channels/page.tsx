import type { Metadata } from "next";
import { ChannelSettings } from "@/components/ChannelSettings";

export const metadata: Metadata = { title: "消息渠道 — BankPilot", robots: { index: false, follow: false } };

export default function ChannelsPage() {
  return <ChannelSettings />;
}
