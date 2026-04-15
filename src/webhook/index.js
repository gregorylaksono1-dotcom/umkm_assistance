import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { parseIncomingMessage } from "../shared/parsers.js";
import { sanitizeAndCapTokens } from "../shared/sanitize.js";
import {
  evaluateFloodGuard,
  evaluateIncomingMessageRate,
  FLOOD_REPLY_TEXT,
  RATE_LIMIT_REPLY_TEXT,
} from "../shared/rateLimit.js";
import { handleMidtransPaymentCallback } from "./midtransCallback.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const TABLE_MESSAGE = process.env.TABLE_MESSAGE;
const TABLE_SENDER_META = process.env.TABLE_SENDER_META;
const PROCESS_INTENT_ARN = process.env.PROCESS_INTENT_ARN;
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS ?? "3000");

async function replyTelegramText(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    console.warn("telegram_rate_reply_failed", res.status, await res.text());
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
  return { statusCode: 403, headers: { "content-type": "text/plain" }, body: "forbidden" };
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

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "POST";
  const path = eventHttpPath(event);
  if (method === "GET" && path.includes("whatsapp")) {
    return handleWhatsappVerify(event);
  }

  if (method === "POST" && path.includes("midtrans")) {
    console.log("midtrans_dbg", "00_route_hit", {
      method,
      path,
      hasBody: event.body != null && event.body !== "",
      isBase64Encoded: Boolean(event.isBase64Encoded),
    });
    return handleMidtransPaymentCallback(event, ddb);
  }

  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body ?? {};
  } catch {
    return response(400, { ok: false, error: "invalid_json" });
  }
  console.log("Event: ", event);
  const parsed = parseIncomingMessage(path, body);
  if (!parsed) {
    return response(200, { ok: true, ignored: true });
  }

  const now = Date.now();
  const metaGet = await ddb.send(
    new GetCommand({
      TableName: TABLE_SENDER_META,
      Key: { senderId: parsed.senderId },
    }),
  );

  const flood = evaluateFloodGuard(metaGet.Item, now);
  if (flood.outcome === "cooldown") {
    return response(200, { ok: true, flood_cooldown: true });
  }
  if (flood.outcome === "triggered") {
    if (parsed.provider === "telegram") {
      await replyTelegramText(parsed.chatId, FLOOD_REPLY_TEXT);
    }
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_SENDER_META,
        Key: { senderId: parsed.senderId },
        UpdateExpression:
          "SET floodUntil = :fu, floodWindowStart = :fws, floodWindowCount = :fwc",
        ExpressionAttributeValues: {
          ":fu": flood.floodUntil,
          ":fws": flood.floodWindowStart,
          ":fwc": flood.floodWindowCount,
        },
      }),
    );
    return response(200, { ok: true, flood_triggered: true });
  }

  const rate = evaluateIncomingMessageRate(metaGet.Item, now);
  if (!rate.allowed) {
    if (parsed.provider === "telegram") {
      await replyTelegramText(parsed.chatId, RATE_LIMIT_REPLY_TEXT);
    }
    let floodUpdate =
      "SET floodWindowStart = :fws, floodWindowCount = :fwc";
    const floodVals = {
      ":fws": flood.floodWindowStart,
      ":fwc": flood.floodWindowCount,
    };
    if (flood.clearExpiredFloodUntil) {
      floodUpdate += " REMOVE floodUntil";
    }
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_SENDER_META,
        Key: { senderId: parsed.senderId },
        UpdateExpression: floodUpdate,
        ExpressionAttributeValues: floodVals,
      }),
    );
    return response(200, { ok: true, rate_limited: true });
  }

  const textStored = sanitizeAndCapTokens(parsed.text, 4000);

  const item = {
    messageId: parsed.messageId,
    senderId: parsed.senderId,
    GSI1PK: parsed.senderId,
    GSI1SK: now,
    provider: parsed.provider,
    chatId: parsed.chatId,
    text: textStored,
    createdAt: now,
    processed: false,
  };
  if (parsed.hasImage && parsed.imageFileId) {
    item.hasImage = true;
    item.imageFileId = parsed.imageFileId;
  }

  await ddb.send(
    new PutCommand({
      TableName: TABLE_MESSAGE,
      Item: item,
    }),
  );

  let metaUpdateExpr =
    "SET latestMessageId = :mid, latestChatId = :cid, latestProvider = :prov, debounceUntil = :du, rlMinuteSlot = :rms, rlMinuteCount = :rmc, rlHourSlot = :rhs, rlHourCount = :rhc, floodWindowStart = :fws, floodWindowCount = :fwc";
  const metaExprValues = {
    ":mid": parsed.messageId,
    ":cid": parsed.chatId,
    ":prov": parsed.provider,
    ":du": now + DEBOUNCE_MS,
    ":rms": rate.rlMinuteSlot,
    ":rmc": rate.rlMinuteCount,
    ":rhs": rate.rlHourSlot,
    ":rhc": rate.rlHourCount,
    ":fws": flood.floodWindowStart,
    ":fwc": flood.floodWindowCount,
  };
  if (flood.clearExpiredFloodUntil) {
    metaUpdateExpr += " REMOVE floodUntil";
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_SENDER_META,
      Key: { senderId: parsed.senderId },
      UpdateExpression: metaUpdateExpr,
      ExpressionAttributeValues: metaExprValues,
    }),
  );

  const payload = Buffer.from(
    JSON.stringify({
      senderId: parsed.senderId,
      triggerMessageId: parsed.messageId,
      debounceMs: DEBOUNCE_MS,
    }),
  );

  await lambda.send(
    new InvokeCommand({
      FunctionName: PROCESS_INTENT_ARN,
      InvocationType: "Event",
      Payload: payload,
    }),
  );

  return response(200, { ok: true, accepted: true });
}

function response(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  };
}
