import type { Metadata } from "next";
import { QqBinding } from "@/components/WecomBinding";

export const metadata: Metadata = {
  title: "绑定 QQ — BankPilot",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function QqConnectPage() {
  return <QqBinding />;
}
