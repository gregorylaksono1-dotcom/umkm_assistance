import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { parseTelegramUpdate } from "../shared/parseTelegramUpdate.js";
import { handleTelegramCommand } from "../shared/telegramCommands.js";
import { handleMidtransPaymentCallback } from "./midtransCallback.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_SENDER_META = process.env.TABLE_SENDER_META;
const TABLE_BILLING = process.env.TABLE_BILLING_USAGE_CREDIT;
const TABLE_REQUEST_RESOURCE = process.env.TABLE_REQUEST_RESOURCE;
const MIDTRANS_SECRET_ARN = process.env.MIDTRANS_SECRET_ARN;
const GEMINI_SECRET_ARN = process.env.GEMINI_SECRET_ARN ?? "";
const GEMINI_SECRET_KEY_NAME = process.env.GEMINI_SECRET_KEY_NAME ?? "gemini_api_key";
const THIRD_PARTY_AI_SECRET_ARN = process.env.THIRD_PARTY_AI_SECRET_ARN ?? "";
const UPLOAD_S3_BUCKET = process.env.UPLOAD_S3_BUCKET ?? "";

/**
 * @param {string|number} chatId
 * @param {string} text
 * @param {{ replyToMessageId?: string|number }} [opts]
 */
async function replyTelegram(chatId, text, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || chatId == null || chatId === "") return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: String(text ?? "").slice(0, 4096),
  };
  const mid = opts.replyToMessageId;
  if (mid != null && mid !== "") {
    const n = Number(mid);
    if (Number.isFinite(n)) {
      payload.reply_parameters = { message_id: n };
    }
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.warn("telegram_send_failed", res.status, await res.text());
  }
}

function handleWhatsappVerify(event) {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN ?? "";
  const qs = event.rawQueryString ?? "";
  const params = new URLSearchParams(qs);
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (mode === "subscribe" && expected && token === expected && challenge) {
    return {
      statusCode: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: challenge,
    };
  }
  return {
    statusCode: 403,
    headers: { "content-type": "text/plain" },
    body: "forbidden",
  };
}

function eventHttpPath(event) {
  return (
    event.rawPath ??
    event.path ??
    event.requestContext?.http?.path ??
    event.requestContext?.resourcePath ??
    ""
  );
}

function response(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  };
}

/**
 * Simpan jejak chat terakhir (Midtrans callback memakai latestChatId untuk notifikasi Telegram).
 * @param {{ senderId: string, chatId: string, messageId: string, provider: string }} parsed
 */
async function persistTelegramSenderMeta(parsed) {
  if (!TABLE_SENDER_META) return;
  const now = Date.now();
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_SENDER_META,
      Key: { senderId: parsed.senderId },
      UpdateExpression:
        "SET latestChatId = :c, latestProvider = :p, latestMessageId = :m, lastInboundAt = :t",
      ExpressionAttributeValues: {
        ":c": parsed.chatId,
        ":p": parsed.provider,
        ":m": parsed.messageId,
        ":t": now,
      },
    }),
  );
}

/** @param {Record<string, unknown>} event */
async function handleTelegramWebhook(event) {
  let body;
  try {
    body =
      typeof event.body === "string"
        ? JSON.parse(event.body || "{}")
        : event.body ?? {};
  } catch {
    return response(400, { ok: false, error: "invalid_json" });
  }

  const parsed = parseTelegramUpdate(body);
  if (!parsed) {
    return response(200, {
      ok: true,
      ignored: true,
      reason: "no_parsable_message",
    });
  }

  try {
    await persistTelegramSenderMeta(parsed);
  } catch (err) {
    console.error("telegram_sender_meta_update_failed", err);
    return response(500, { ok: false, error: "meta_update_failed" });
  }

  let replyText;
  /** @type {{ chatId?: string|number, replyToMessageId?: string|number }} */
  let replyOpts = {};
  try {
    const out = await handleTelegramCommand({
      ddb,
      tableBilling: TABLE_BILLING,
      tableRequestResource: TABLE_REQUEST_RESOURCE,
      midtransSecretArn: MIDTRANS_SECRET_ARN,
      geminiSecretArn: GEMINI_SECRET_ARN,
      geminiSecretKeyName: GEMINI_SECRET_KEY_NAME,
      thirdPartyAiSecretArn: THIRD_PARTY_AI_SECRET_ARN,
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
      uploadS3Bucket: UPLOAD_S3_BUCKET,
      parsed,
    });
    if (out && typeof out === "object" && "text" in out) {
      replyText = out.text;
      if (out.chatId != null && out.chatId !== "") {
        replyOpts.chatId = out.chatId;
      }
      if (out.replyToMessageId != null && out.replyToMessageId !== "") {
        replyOpts.replyToMessageId = out.replyToMessageId;
      }
    } else {
      replyText = out;
    }
  } catch (err) {
    console.error("telegram_command_error", err);
    replyText = "Terjadi kesalahan. Coba lagi nanti.";
  }

  const targetChatId =
    replyOpts.chatId != null && replyOpts.chatId !== ""
      ? replyOpts.chatId
      : parsed.chatId;
  await replyTelegram(targetChatId, replyText, replyOpts);

  return response(200, {
    ok: true,
    accepted: true,
    provider: "telegram",
    senderId: parsed.senderId,
    messageId: parsed.messageId,
    hasText: Boolean(parsed.text),
    hasImage: parsed.hasImage,
  });
}

/**
 * Lambda webhook: Telegram (POST), WhatsApp (GET/POST), Midtrans (POST).
 */
export async function handler(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "POST";
  const path = eventHttpPath(event);

  if (method === "GET" && path.includes("whatsapp")) {
    return handleWhatsappVerify(event);
  }

  if (method === "POST" && path.includes("midtrans")) {
    return handleMidtransPaymentCallback(event, ddb);
  }

  if (method === "POST" && path.includes("telegram")) {
    return handleTelegramWebhook(event);
  }

  if (method === "POST" && path.includes("whatsapp")) {
    return response(200, {
      ok: true,
      ignored: true,
      hint: "Chat ingest dinonaktifkan — hanya Midtrans + billing di stack ini.",
    });
  }

  return response(404, { ok: false, error: "not_found" });
}
