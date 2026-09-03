import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BankPilot — AI Banking Agent",
  description: "能理解、会规划、受约束的银行 AI 智能体演示系统",
  applicationName: "BankPilot",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "BankPilot" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, viewportFit: "cover", themeColor: "#ffffff" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
