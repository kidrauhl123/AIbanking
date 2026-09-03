import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BankPilot AI Banking Agent",
    short_name: "BankPilot",
    description: "能理解、会规划、受约束的银行 AI 智能体",
    start_url: "/",
    display: "standalone",
    background_color: "#f2f2ef",
    theme_color: "#ffffff",
    orientation: "portrait",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
