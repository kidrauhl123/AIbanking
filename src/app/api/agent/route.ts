import { NextResponse } from "next/server";
import { z } from "zod";
import { runAgent } from "@/lib/agent";
import { AIConfigurationError, AIUpstreamError } from "@/lib/ai";

const schema = z.object({
  message: z.string().trim().min(1).max(500),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(500),
  })).max(8).default([]),
});

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    return NextResponse.json(await runAgent(input.message, input.history));
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    if (error instanceof AIConfigurationError) {
      return NextResponse.json({ error: "AI_NOT_CONFIGURED", message: "真实 AI 模型尚未配置，本次没有执行任何银行操作。" }, { status: 503 });
    }
    if (error instanceof AIUpstreamError) {
      return NextResponse.json({ error: error.message, message: "真实 AI 模型调用失败，本次没有执行任何银行操作。" }, { status: 502 });
    }
    console.error(error);
    return NextResponse.json({ error: "AGENT_FAILED", message: "Agent 未执行任何银行操作，请稍后重试" }, { status: 500 });
  }
}
