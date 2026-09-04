import type { Metadata } from "next";
import { WecomBinding } from "@/components/WecomBinding";

export const metadata: Metadata = {
  title: "绑定企业微信 — BankPilot",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function WecomConnectPage() {
  return <WecomBinding />;
}
