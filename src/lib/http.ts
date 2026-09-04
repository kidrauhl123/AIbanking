import { NextResponse } from "next/server";
import { AuthError } from "./auth";

export function apiError(error: unknown, fallback = "REQUEST_FAILED") {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.code, message: authMessage(error.code) }, { status: error.status });
  }
  const code = error instanceof Error ? error.message : fallback;
  const knownStatus: Record<string, number> = {
    ACCOUNT_NOT_FOUND: 404,
    RECIPIENT_NOT_FOUND: 404,
    RECIPIENT_AMBIGUOUS: 409,
    CANNOT_TRANSFER_TO_SELF: 409,
    INSUFFICIENT_FUNDS: 409,
    OPERATION_NOT_FOUND: 404,
    OPERATION_NOT_EXECUTABLE: 409,
    CARD_NOT_FOUND: 404,
    TOKEN_NOT_FOUND: 404,
    AUTH_INVALID: 401,
    AUTH_EXPIRED: 401,
    AUTH_FUSE_ACTIVE: 423,
    AI_NOT_CONFIGURED: 503,
    AI_UPSTREAM_FAILED: 502,
    AI_INVALID_JSON: 502,
    AI_SCHEMA_REJECTED: 502,
    AI_TIMEOUT: 504,
    AGENT_RUN_NOT_FOUND: 404,
    AGENT_RUN_NOT_RESUMABLE: 409,
    AUTHORIZATION_MISMATCH: 409,
    OPERATION_TYPE_NOT_SUPPORTED: 422,
    RESOURCE_REQUIRED: 422,
    BINDING_TOKEN_INVALID: 400,
    CHANNEL_ALREADY_BOUND: 409,
    CHANNEL_IDENTITY_NOT_FOUND: 404,
    OUTBOX_ITEM_NOT_FOUND: 404,
    PUBLIC_URL_NOT_CONFIGURED: 503,
  };
  console.error(error);
  return NextResponse.json({ error: code, message: publicMessage(code) }, { status: knownStatus[code] ?? 500 });
}

function authMessage(code: string) {
  const messages: Record<string, string> = {
    AUTHENTICATION_REQUIRED: "请先登录",
    SESSION_EXPIRED: "登录已过期，请重新登录",
    INVALID_API_TOKEN: "Agent 访问令牌无效或已过期",
    INSUFFICIENT_SCOPE: "当前 Agent 未获得这项权限",
    INVALID_CREDENTIALS: "手机号或密码不正确",
    LOGIN_TEMPORARILY_LOCKED: "连续登录失败，账户已暂时锁定 15 分钟",
    PHONE_ALREADY_REGISTERED: "该手机号已经注册",
    CUSTOMER_UNAVAILABLE: "账户当前不可用",
    INVALID_SCOPE: "包含不支持的 Agent 权限",
    INVALID_REGISTRATION: "请检查姓名、手机号和密码格式",
    MFA_INVALID: "动态验证码不正确",
    SECURITY_CONFIGURATION_REQUIRED: "服务器尚未完成安全密钥配置",
    DEPOSIT_REQUIRES_BANK_APP: "入金只能在银行 APP 内操作",
    CARD_ISSUANCE_REQUIRES_BANK_APP: "开卡只能在银行 APP 内操作",
    CARD_MANAGEMENT_REQUIRES_BANK_APP: "卡片写操作只能在银行 APP 内完成",
    TOKEN_CREATION_REQUIRES_BANK_APP: "访问令牌只能在银行 APP 内签发",
    TOKEN_MANAGEMENT_REQUIRES_BANK_APP: "访问令牌只能在银行 APP 内管理",
    AUTHORIZATION_REQUIRES_BANK_APP: "最终授权必须回到银行 APP 完成",
    MFA_SETUP_REQUIRES_BANK_APP: "多因素认证只能在银行 APP 内设置",
    INVALID_ORIGIN: "请求来源未获允许",
    BANK_APP_SESSION_REQUIRED: "此功能只能在银行 APP 登录后使用",
  };
  return messages[code] ?? "身份验证失败";
}

function publicMessage(code: string) {
  const messages: Record<string, string> = {
    ACCOUNT_NOT_FOUND: "没有找到可用账户",
    RECIPIENT_NOT_FOUND: "没有找到该收款人，请核对手机号或姓名",
    RECIPIENT_AMBIGUOUS: "存在同名客户，请使用手机号转账",
    CANNOT_TRANSFER_TO_SELF: "不能向自己的账户转账",
    INSUFFICIENT_FUNDS: "账户可用余额不足",
    OPERATION_NOT_FOUND: "操作不存在或不属于当前用户",
    OPERATION_NOT_EXECUTABLE: "操作当前不可执行",
    CARD_NOT_FOUND: "没有找到可锁定的卡片",
    TOKEN_NOT_FOUND: "访问令牌不存在",
    AUTH_INVALID: "强验证失败，资金未转出",
    AUTH_EXPIRED: "授权已过期，请重新发起",
    AUTH_FUSE_ACTIVE: "连续验证失败，操作已熔断",
    AI_NOT_CONFIGURED: "真实 AI 模型尚未配置，系统不会使用写死回复代替",
    AI_UPSTREAM_FAILED: "AI 服务暂时不可用，本次没有执行银行操作",
    AI_INVALID_JSON: "AI 输出未通过结构校验，本次没有执行银行操作",
    AI_SCHEMA_REJECTED: "AI 输出未通过结构校验，本次没有执行银行操作",
    AI_TIMEOUT: "AI 响应超时，本次没有执行银行操作",
    AGENT_RUN_NOT_FOUND: "没有找到对应的 Agent 任务",
    AGENT_RUN_NOT_RESUMABLE: "该 Agent 任务当前不能重复授权",
    AUTHORIZATION_MISMATCH: "授权信息与待执行操作不一致",
    OPERATION_TYPE_NOT_SUPPORTED: "该操作暂不支持通过此渠道执行",
    RESOURCE_REQUIRED: "操作信息不完整，请重新发起",
    BINDING_TOKEN_INVALID: "绑定链接无效、已使用或已过期",
    CHANNEL_ALREADY_BOUND: "该企业微信身份已绑定其他账户",
    CHANNEL_IDENTITY_NOT_FOUND: "企业微信身份尚未绑定或已解绑",
    OUTBOX_ITEM_NOT_FOUND: "消息投递任务不存在或已处理",
    PUBLIC_URL_NOT_CONFIGURED: "服务器尚未配置可信公网地址",
  };
  return messages[code] ?? "请求没有完成，请稍后重试";
}

export function assertSameOrigin(request: Request) {
  if (request.headers.get("authorization")?.startsWith("Bearer ")) return;
  const origin = request.headers.get("origin");
  if (!origin) return;
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!forwardedHost || new URL(origin).host !== forwardedHost) throw new AuthError("INVALID_ORIGIN", 403);
}
