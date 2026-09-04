import AiBot, { generateReqId } from "@wecom/aibot-node-sdk";

const required = ["WECOM_BOT_ID", "WECOM_BOT_SECRET", "WECOM_ADAPTER_TOKEN", "BANKPILOT_INTERNAL_URL"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name}_REQUIRED`);
}

const internalUrl = process.env.BANKPILOT_INTERNAL_URL.replace(/\/$/, "");
const adapterToken = process.env.WECOM_ADAPTER_TOKEN;
const client = new AiBot.WSClient({
  botId: process.env.WECOM_BOT_ID,
  secret: process.env.WECOM_BOT_SECRET,
  maxReconnectAttempts: -1,
  logger: {
    debug() {},
    info(message) { console.info(`[wecom] ${message}`); },
    warn(message) { console.warn(`[wecom] ${message}`); },
    error(message) { console.error(`[wecom] ${message}`); },
  },
});

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

function authorizationCard(reply) {
  const operation = reply.operation;
  return {
    card_type: "button_interaction",
    main_title: { title: operation.title, desc: `${operation.riskLevel} · ${operation.requiredAuth === "MFA" ? "强验证" : "明确确认"}` },
    button_list: [
      { text: "确认", key: "bankpilot_approve", style: 1 },
      { text: "取消", key: "bankpilot_reject", style: 2 },
    ],
    task_id: `${reply.taskId}~${operation.operationId}`,
  };
}

function renderReply(result) {
  if (result.status === "BINDING_REQUIRED") {
    return `${result.message}\n\n[打开 BankPilot 安全绑定](${result.bindUrl})`;
  }
  if (result.status === "DUPLICATE") return "这条消息已经处理过了。";
  if (result.status === "AUTHORIZATION_REQUIRED" && result.authorizeUrl) {
    return `${result.reply.message}\n\n[回到 BankPilot 完成强验证](${result.authorizeUrl})`;
  }
  return result.reply?.message ?? "请求没有完成，请稍后重试。";
}

async function handleMessage(frame, message) {
  const streamId = generateReqId("bankpilot");
  await client.replyStream(frame, streamId, "正在由 BankPilot 安全处理…", false);
  try {
    const body = frame.body;
    const result = await bankApi("/api/channels/wecom/message", {
      tenantExternalId: body.aibotid,
      subjectExternalId: body.from.userid,
      conversationExternalId: body.chatid ?? body.from.userid,
      eventId: body.msgid,
      message,
    });
    const templateCard = result.status === "AUTHORIZATION_REQUIRED" && !result.authorizeUrl
      ? authorizationCard(result.reply)
      : undefined;
    await client.replyStreamWithCard(frame, streamId, renderReply(result), true, templateCard ? { templateCard } : undefined);
  } catch (error) {
    console.error("[wecom] message processing failed", error instanceof Error ? error.message : "UNKNOWN");
    await client.replyStream(frame, streamId, "银行服务暂时没有完成这次请求，未执行任何新操作。", true);
  }
}

client.on("message.text", (frame) => void handleMessage(frame, frame.body.text.content));
client.on("message.voice", (frame) => {
  const content = frame.body.voice.content?.trim();
  if (content) void handleMessage(frame, content);
});

client.on("event.enter_chat", (frame) => {
  void client.replyWelcome(frame, {
    msgtype: "text",
    text: { content: "你好，我是 BankPilot。绑定银行身份后，你可以用自然语言查账、分析账单、转账或管理卡片。" },
  });
});

client.on("event.template_card_event", async (frame) => {
  const encoded = frame.body.event.task_id ?? "";
  const splitAt = encoded.indexOf("~");
  const taskId = splitAt > 0 ? encoded.slice(0, splitAt) : "";
  const operationId = splitAt > 0 ? encoded.slice(splitAt + 1) : "";
  const actionKey = frame.body.event.event_key;
  if (!["bankpilot_approve", "bankpilot_reject"].includes(actionKey)) return;
  const approved = actionKey === "bankpilot_approve";
  await client.updateTemplateCard(frame, {
    card_type: "text_notice",
    main_title: { title: approved ? "正在核验并执行" : "正在取消" },
    task_id: encoded,
  });
  try {
    const result = await bankApi("/api/channels/wecom/action", {
      tenantExternalId: frame.body.aibotid,
      subjectExternalId: frame.body.from.userid,
      eventId: frame.body.msgid,
      taskId,
      operationId,
      approved,
    });
    if (result.status === "MFA_REQUIRED") {
      await client.sendMessage(frame.body.from.userid, {
        msgtype: "markdown",
        markdown: { content: `${result.message}\n\n[打开 BankPilot 强验证](${result.authorizeUrl})` },
      });
    }
  } catch (error) {
    console.error("[wecom] action processing failed", error instanceof Error ? error.message : "UNKNOWN");
    await client.sendMessage(frame.body.from.userid, {
      msgtype: "markdown",
      markdown: { content: "操作没有完成。请回到 BankPilot 核对状态后重试。" },
    });
  }
});

let polling = false;
async function pollOutbox() {
  if (polling || !client.isConnected) return;
  polling = true;
  try {
    const { items } = await bankApi("/api/channels/wecom/outbox/claim", { limit: 10 });
    for (const item of items) {
      try {
        await client.sendMessage(item.subjectExternalId, {
          msgtype: "markdown",
          markdown: { content: item.payload.message },
        });
        await bankApi("/api/channels/wecom/outbox/ack", { id: item.id, delivered: true });
      } catch (error) {
        await bankApi("/api/channels/wecom/outbox/ack", {
          id: item.id,
          delivered: false,
          error: error instanceof Error ? error.message : "DELIVERY_FAILED",
        }).catch(() => undefined);
      }
    }
  } catch (error) {
    console.error("[wecom] outbox poll failed", error instanceof Error ? error.message : "UNKNOWN");
  } finally {
    polling = false;
  }
}

client.on("authenticated", () => console.info("[wecom] authenticated"));
client.on("error", (error) => console.error("[wecom] connection error", error.message));
client.connect();
const pollTimer = setInterval(() => void pollOutbox(), 3_000);

function shutdown() {
  clearInterval(pollTimer);
  client.disconnect();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
