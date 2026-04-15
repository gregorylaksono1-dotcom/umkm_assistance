import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { BILLING_PROFILE_SK } from "../shared/creditProfile.js";
import { CREDIT_UNIT_PRICE_IDR } from "../shared/constants.js";
import {
  isMidtransPaymentSuccess,
  orderSkFromOrderId,
  parseApiGatewayBody,
  userPkFromMidtransPayload,
  verifyMidtransSignatureKey,
} from "../shared/midtransNotify.js";
import { getJsonSecret } from "../shared/secrets.js";

const TABLE_SENDER_META = process.env.TABLE_SENDER_META;

function dbg(step, data) {
  console.log("midtrans_dbg", step, data);
}

function midtransServerKeyFromSecret(parsed) {
  return parsed.server_key ?? parsed.secret_key ?? parsed.ServerKey;
}

function response(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  };
}

async function notifyUserCreditsAdded(chatId, credits) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || chatId == null || chatId === "") return;
  const text = `Hai kak! Pembayaran sudah berhasil diproses. ${credits} credit sudah ditambahkan ke saldo kamu. Silakan lanjut pakai DapurArtisan ya.`;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    console.warn("midtrans_telegram_notify_failed", res.status, await res.text());
  }
}

async function resolveLatestChatId(ddb, senderId) {
  if (!TABLE_SENDER_META || !senderId) return null;
  try {
    const out = await ddb.send(
      new GetCommand({
        TableName: TABLE_SENDER_META,
        Key: { senderId: String(senderId) },
      }),
    );
    const cid = out.Item?.latestChatId;
    return cid != null ? cid : null;
  } catch (e) {
    console.warn("midtrans_resolve_chat_failed", e);
    return null;
  }
}

/**
 * GetItem lalu Query PK + begins_with(SK, ORDER#) bila perlu (key tidak ketemu).
 */
async function resolveOrderRecord(ddb, table, userPk, orderId, orderSk) {
  const direct = await ddb.send(
    new GetCommand({
      TableName: table,
      Key: { PK: userPk, SK: orderSk },
    }),
  );
  if (direct.Item) {
    dbg("08b_getitem_direct_hit", { SK: orderSk });
    return { item: direct.Item, key: { PK: userPk, SK: orderSk } };
  }
  dbg("08b_getitem_direct_miss", { SK: orderSk });

  const q = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :op)",
      ExpressionAttributeValues: { ":pk": userPk, ":op": "ORDER#" },
    }),
  );
  const scanned = q.Items ?? [];
  dbg("08b_query_orders", { count: scanned.length, orderIdSought: orderId });
  const hit = scanned.find((i) => i.orderId === orderId || i.SK === orderSk);
  if (hit?.PK && hit?.SK) {
    dbg("08b_query_hit", { SK: hit.SK, orderId: hit.orderId });
    return { item: hit, key: { PK: hit.PK, SK: hit.SK } };
  }
  dbg("08b_query_miss", {});
  return null;
}

function creditsFromGrossAmount(payload) {
  const gross = Number(String(payload.gross_amount ?? "").replace(/,/g, ""));
  if (!Number.isFinite(gross) || gross <= 0) return null;
  const credits = Math.round(gross / CREDIT_UNIT_PRICE_IDR);
  if (credits < 1) return null;
  if (Math.abs(credits * CREDIT_UNIT_PRICE_IDR - gross) > 0.05) return null;
  return credits;
}

/**
 * Handler HTTP POST notifikasi pembayaran Midtrans.
 * TransactWriteItems: update ORDER (PAID, …) + ADD credits PROFILE.
 */
export async function handleMidtransPaymentCallback(event, ddb) {
  const table = process.env.TABLE_BILLING_USAGE_CREDIT;
  const secretArn = process.env.MIDTRANS_SECRET_ARN;
  dbg("01_env", {
    hasTable: Boolean(table),
    hasSecretArn: Boolean(secretArn),
    hasSenderMetaTable: Boolean(TABLE_SENDER_META),
  });
  if (!table || !secretArn) {
    console.error("midtrans_callback_missing_env");
    dbg("01_env_FAIL", { stop: "missing_table_or_secret_arn" });
    return response(500, { ok: false, error: "server_misconfigured" });
  }

  const rawBodyInfo =
    typeof event.body === "string"
      ? { bodyLen: event.body.length, bodyPreview: event.body.slice(0, 120) }
      : { bodyType: typeof event.body };
  dbg("02_raw_body", {
    ...rawBodyInfo,
    isBase64Encoded: Boolean(event.isBase64Encoded),
  });

  const payload = parseApiGatewayBody(event);
  if (!payload || typeof payload !== "object" || !payload.order_id) {
    dbg("03_parse_FAIL", {
      stop: "invalid_body_or_missing_order_id",
      payloadType: typeof payload,
      keys:
        payload && typeof payload === "object"
          ? Object.keys(payload).slice(0, 20)
          : [],
    });
    return response(400, { ok: false, error: "invalid_body" });
  }

  dbg("03_payload_ok", {
    order_id: payload.order_id,
    transaction_status: payload.transaction_status,
    status_code: payload.status_code,
    gross_amount: payload.gross_amount,
    has_signature_key: Boolean(payload.signature_key),
    custom_field1: payload.custom_field1 ?? payload.customField1 ?? null,
    payment_type: payload.payment_type,
  });

  let secretJson;
  try {
    secretJson = await getJsonSecret(secretArn);
  } catch (e) {
    console.error("midtrans_callback_secret_error", e);
    dbg("04_secret_FAIL", { stop: "get_secret_threw", err: String(e?.message ?? e) });
    return response(500, { ok: false, error: "secret_error" });
  }

  const serverKey = midtransServerKeyFromSecret(secretJson);
  if (!serverKey || typeof serverKey !== "string") {
    dbg("04_secret_FAIL", { stop: "server_key_missing_in_json" });
    return response(500, { ok: false, error: "server_key_missing" });
  }
  dbg("04_secret_ok", { serverKeyLen: serverKey.length });

  const sigOk = verifyMidtransSignatureKey(payload, serverKey);
  dbg("05_signature", { ok: sigOk });
  if (!sigOk) {
    console.warn("midtrans_callback_bad_signature", { order_id: payload.order_id });
    dbg("05_signature_FAIL", {
      stop: "invalid_signature",
      order_id: payload.order_id,
      status_code: String(payload.status_code ?? ""),
      gross_amount: String(payload.gross_amount ?? ""),
    });
    return response(403, { ok: false, error: "invalid_signature" });
  }

  const payOk = isMidtransPaymentSuccess(payload);
  dbg("06_payment_status", {
    ok: payOk,
    transaction_status: payload.transaction_status,
  });
  if (!payOk) {
    dbg("06_skip_not_success", { stop: "not_settlement_or_capture" });
    return response(200, { ok: true, ignored: true, reason: "not_success_status" });
  }

  const userPk = userPkFromMidtransPayload(payload);
  const orderSk = orderSkFromOrderId(payload.order_id);
  dbg("07_keys", { userPk, orderSk });
  if (!userPk || !orderSk) {
    console.warn("midtrans_callback_missing_user_mapping", { order_id: payload.order_id });
    dbg("07_keys_FAIL", { stop: "missing_custom_field1_or_order_sk" });
    return response(400, { ok: false, error: "missing_custom_field1" });
  }

  const senderIdFromPayload = String(
    (payload.custom_field1 ?? payload.customField1 ?? "").toString().trim(),
  );

  dbg("08_resolve_order_start", { table, userPk, orderSk, orderId: payload.order_id });
  const resolved = await resolveOrderRecord(
    ddb,
    table,
    userPk,
    String(payload.order_id),
    orderSk,
  );

  dbg("08_resolve_order_result", {
    found: Boolean(resolved?.item),
    orderStatus: resolved?.item?.status ?? null,
    orderCredits: resolved?.item?.credits ?? null,
    resolvedPk: resolved?.key?.PK ?? null,
    resolvedSk: resolved?.key?.SK ?? null,
  });

  let orderKey;
  let creditsToAdd;
  let chatIdForNotify;
  let transactItems;

  const paymentDatetime =
    (payload.settlement_time ?? payload.settlementTime ?? "").toString() ||
    (payload.transaction_time ?? payload.transactionTime ?? "").toString() ||
    new Date().toISOString();
  const transactionId = String(
    payload.transaction_id ?? payload.transactionId ?? "",
  );
  const now = Date.now();
  const grossNum = Number(String(payload.gross_amount ?? "").replace(/,/g, ""));

  if (resolved?.item) {
    const orderItem = resolved.item;
    orderKey = resolved.key;
    if (orderItem.status === "PAID") {
      dbg("09_branch", { stop: "already_paid_duplicate" });
      return response(200, { ok: true, duplicate: true });
    }
    dbg("09_branch", { mode: "update_existing_order" });
    creditsToAdd = Number(orderItem.credits);
    if (!Number.isFinite(creditsToAdd) || creditsToAdd <= 0) {
      const fromGross = creditsFromGrossAmount(payload);
      if (fromGross == null) {
        console.error("midtrans_callback_bad_credits", orderItem);
        dbg("09_bad_credits_FAIL", { stop: "invalid_order_credits", orderItem });
        return response(400, { ok: false, error: "invalid_order_credits" });
      }
      creditsToAdd = fromGross;
    }
    chatIdForNotify =
      orderItem.chatId ??
      (await resolveLatestChatId(ddb, orderItem.userId ?? senderIdFromPayload));

    transactItems = [
      {
        Update: {
          TableName: table,
          Key: orderKey,
          UpdateExpression:
            "SET #st = :paid, payment_datetime = :pdt, transaction_id = :tid, updatedAt = :ua, grossAmount = if_not_exists(grossAmount, :ga)",
          ConditionExpression: "attribute_not_exists(#st) OR #st = :pending",
          ExpressionAttributeNames: { "#st": "status" },
          ExpressionAttributeValues: {
            ":paid": "PAID",
            ":pending": "PENDING_SNAP",
            ":pdt": paymentDatetime,
            ":tid": transactionId,
            ":ua": now,
            ":ga": grossNum,
          },
        },
      },
      {
        Update: {
          TableName: table,
          Key: { PK: userPk, SK: BILLING_PROFILE_SK },
          UpdateExpression: "ADD credits :inc SET updatedAt = :ua",
          ExpressionAttributeValues: {
            ":inc": creditsToAdd,
            ":ua": now,
          },
        },
      },
    ];
  } else {
    dbg("09_branch", { mode: "recovery_put_order_not_in_db" });
    if (!senderIdFromPayload) {
      console.warn("midtrans_callback_recovery_no_sender", { userPk, orderSk });
      dbg("09_recovery_FAIL", { stop: "missing_sender_id" });
      return response(400, { ok: false, error: "missing_custom_field1" });
    }
    creditsToAdd = creditsFromGrossAmount(payload);
    if (creditsToAdd == null) {
      console.warn("midtrans_callback_order_not_found", { userPk, orderSk });
      dbg("09_recovery_FAIL", {
        stop: "order_not_found_and_gross_invalid",
        grossNum,
        unitPrice: CREDIT_UNIT_PRICE_IDR,
      });
      return response(404, { ok: false, error: "order_not_found" });
    }

    const uid = senderIdFromPayload;
    chatIdForNotify = await resolveLatestChatId(ddb, uid);

    console.warn("midtrans_callback_order_recovery_put", {
      userPk,
      orderSk,
      creditsToAdd,
    });
    dbg("09_recovery_credits", { creditsToAdd, chatIdForNotify });

    transactItems = [
      {
        Put: {
          TableName: table,
          Item: {
            PK: userPk,
            SK: orderSk,
            userId: uid,
            orderId: String(payload.order_id),
            credits: creditsToAdd,
            grossAmount: grossNum,
            unitPriceIdr: CREDIT_UNIT_PRICE_IDR,
            status: "PAID",
            payment_datetime: paymentDatetime,
            transaction_id: transactionId,
            createdAt: now,
            updatedAt: now,
            entityType: "ORDER",
            source: "midtrans_webhook_recovery",
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      },
      {
        Update: {
          TableName: table,
          Key: { PK: userPk, SK: BILLING_PROFILE_SK },
          UpdateExpression: "ADD credits :inc SET updatedAt = :ua",
          ExpressionAttributeValues: {
            ":inc": creditsToAdd,
            ":ua": now,
          },
        },
      },
    ];
  }

  dbg("10_transact_start", {
    creditsToAdd,
    transactionId,
    paymentDatetime,
    transactItemCount: transactItems.length,
  });
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: transactItems,
      }),
    );
    dbg("10_transact_ok", { creditsToAdd });
  } catch (e) {
    const name = e?.name ?? e?.Code ?? "";
    const reasons = e?.CancellationReasons;
    console.error("midtrans_callback_transact_error", name, JSON.stringify(reasons), e);
    dbg("10_transact_FAIL", {
      stop: "dynamodb_transact",
      errorName: name,
      reasons: reasons ?? null,
      message: String(e?.message ?? e),
    });
    const conditionalFailed =
      name === "TransactionCanceledException" ||
      name === "ConditionalCheckFailedException" ||
      (Array.isArray(reasons) &&
        reasons.some((r) => r.Code === "ConditionalCheckFailed"));
    if (conditionalFailed) {
      dbg("10_transact_conditional", { treating_as: "duplicate_200" });
      return response(200, { ok: true, duplicate: true, reason: "condition_failed" });
    }
    return response(500, { ok: false, error: "transact_failed" });
  }

  if (chatIdForNotify != null && chatIdForNotify !== "") {
    dbg("11_telegram", { chatIdForNotify, creditsToAdd });
    await notifyUserCreditsAdded(chatIdForNotify, creditsToAdd);
    dbg("11_telegram_done", {});
  } else {
    dbg("11_telegram_skip", { reason: "no_chat_id" });
  }

  dbg("99_done", { order_id: payload.order_id, credits_added: creditsToAdd });
  return response(200, {
    ok: true,
    applied: true,
    order_id: payload.order_id,
    credits_added: creditsToAdd,
  });
}
