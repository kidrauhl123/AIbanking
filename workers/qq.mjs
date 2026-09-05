import {
  QQBot,
  concurrencyGuard,
  rateLimiter,
} from "@tencent-connect/qqbot-nodejs";

const required = ["QQBOT_APP_ID", "QQBOT_APP_SECRET", "QQ_ADAPTER_TOKEN", "BANKPILOT_INTERNAL_URL"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name}_REQUIRED`);
}

const appId = process.env.QQBOT_APP_ID;
const internalUrl = process.env.BANKPILOT_INTERNAL_URL.replace(/\/$/, "");
const adapterToken = process.env.QQ_ADAPTER_TOKEN;
const bot = new QQBot({
  appId,
  appSecret: process.env.QQBOT_APP_SECRET,
  markdownSupport: false,
  logger: {
    debug() {},
    info(message) { console.info(`[qq] ${message}`); },
    warn(message) { console.warn(`[qq] ${message}`); },
    error(message) { console.error(`[qq] ${message}`); },
  },
});

bot.use(rateLimiter({
  perSender: { max: 12, windowMs: 60_000 },
  global: { max: 180, windowMs: 60_000 },
  onLimit: async (ctx) => {
    await ctx.bot.sendText(ctx.replyTarget, "请求有点频繁，请稍后再试。未执行任何新操作。");
  },
}));
bot.use(concurrencyGuard({ strategy: "queue", maxQueue: 3, maxProcessingMs: 55_000 }));

async function bankApi(path, body) {
  const response = await fetch(`${internalUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adapterToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "BANK_API_FAILED");
  return result;
}

function actionData(approved, reply) {
  return `${approved ? "A" : "R"}|${reply.taskId}|${reply.operation.operationId}`;
}

function authorizationKeyboard(reply) {
  return {
    content: {
      rows: [{
        buttons: [
          {
            id: "bankpilot_approve",
            render_data: { label: "确认", visited_label: "已确认", style: 1 },
            action: { type: 2, permission: { type: 2 }, data: actionData(true, reply), click_limit: 1 },
          },
          {
            id: "bankpilot_reject",
            render_data: { label: "取消", visited_label: "已取消", style: 2 },
            action: { type: 2, permission: { type: 2 }, data: actionData(false, reply), click_limit: 1 },
          },
        ],
      }],
    },
  };
}

function renderReply(result) {
  if (result.status === "BINDING_REQUIRED") return `${result.message}\n\n安全绑定：${result.bindUrl}`;
  if (result.status === "DUPLICATE") return "这条消息已经处理过了。";
  if (result.status === "AUTHORIZATION_REQUIRED" && result.authorizeUrl) {
    return `${result.reply.message}\n\n回到 BankPilot 完成强验证：${result.authorizeUrl}`;
  }
  return result.reply?.message ?? "请求没有完成，请稍后重试。";
}

bot.on("message", async (_ctx, message) => {
  if (message.kind !== "c2c") {
    await bot.sendText(message.replyTarget, "为保护账户和交易隐私，银行业务仅支持与 BankPilot QQ 机器人私聊办理。");
    return;
  }
  try {
    await bot.sendTyping(message.replyTarget, 30).catch(() => undefined);
    const result = await bankApi("/api/channels/qq/message", {
      tenantExternalId: appId,
      subjectExternalId: message.senderId,
      conversationExternalId: message.senderId,
      eventId: message.messageId,
      message: message.content,
    });
    if (result.status === "AUTHORIZATION_REQUIRED" && !result.authorizeUrl) {
      await bot.sendTextWithKeyboard(message.replyTarget, result.reply.message, authorizationKeyboard(result.reply));
    } else {
      await bot.sendText(message.replyTarget, renderReply(result));
    }
  } catch (error) {
    console.error("[qq] message processing failed", error instanceof Error ? error.message : "UNKNOWN");
    await bot.sendText(message.replyTarget, "银行服务暂时没有完成这次请求，未执行任何新操作。");
  }
});

bot.on("interaction", async (_ctx, event) => {
  const raw = event.data.resolved.button_data ?? "";
  const [decision, taskId, operationId] = raw.split("|");
  const subjectExternalId = event.user_openid;
  if (!["A", "R"].includes(decision) || !taskId || !operationId || !subjectExternalId || event.group_openid) {
    await bot.acknowledgeInteraction(event.id, 4);
    return;
  }

  await bot.acknowledgeInteraction(event.id, 0);
  try {
    const result = await bankApi("/api/channels/qq/action", {
      tenantExternalId: appId,
      subjectExternalId,
      eventId: event.id,
      taskId,
      operationId,
      approved: decision === "A",
    });
    if (result.status === "MFA_REQUIRED") {
      await bot.sendText(
        { scope: "c2c", targetId: subjectExternalId },
        `${result.message}\n\n打开 BankPilot 强验证：${result.authorizeUrl}`,
      );
    }
  } catch (error) {
    console.error("[qq] action processing failed", error instanceof Error ? error.message : "UNKNOWN");
    await bot.sendText(
      { scope: "c2c", targetId: subjectExternalId },
      "操作没有完成。请回到 BankPilot 核对状态后重试。",
    );
  }
});

let polling = false;
async function pollOutbox() {
  if (polling) return;
  polling = true;
  try {
    const { items } = await bankApi("/api/channels/qq/outbox/claim", { limit: 10 });
    for (const item of items) {
      try {
        await bot.sendText({ scope: "c2c", targetId: item.subjectExternalId }, item.payload.message);
        await bankApi("/api/channels/qq/outbox/ack", { id: item.id, delivered: true });
      } catch (error) {
        await bankApi("/api/channels/qq/outbox/ack", {
          id: item.id,
          delivered: false,
          error: error instanceof Error ? error.message : "DELIVERY_FAILED",
        }).catch(() => undefined);
      }
    }
  } catch (error) {
    console.error("[qq] outbox poll failed", error instanceof Error ? error.message : "UNKNOWN");
  } finally {
    polling = false;
  }
}

bot.on("ready", () => console.info("[qq] gateway ready"));
bot.on("resumed", () => console.info("[qq] gateway resumed"));
bot.on("error", (error) => console.error("[qq] connection error", error.message));

await bot.start();
const pollTimer = setInterval(() => void pollOutbox(), 3_000);

async function shutdown() {
  clearInterval(pollTimer);
  await bot.stop();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
