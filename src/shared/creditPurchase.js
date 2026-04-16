import { PutCommand } from "@aws-sdk/lib-dynamodb";
import Midtrans from "midtrans-client";
import { CREDIT_UNIT_PRICE_IDR } from "./constants.js";
import { billingUserPk } from "./creditProfile.js";
import { getJsonSecret } from "./secrets.js";

function midtransKeysFromSecret(parsed) {
  const serverKey = parsed.server_key ?? parsed.secret_key ?? parsed.ServerKey;
  const clientKey = parsed.client_key ?? parsed.ClientKey;
  if (!serverKey || !clientKey) {
    throw new Error(
      "Midtrans secret JSON harus berisi server_key (atau secret_key) dan client_key",
    );
  }
  return { serverKey: String(serverKey), clientKey: String(clientKey) };
}

function orderIdNow() {
  return `ORDER-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Buat transaksi Snap Midtrans; mengembalikan { orderId, redirect_url, token, grossAmount }.
 * Panggil dari API/backend Anda setelah validasi jumlah credit user.
 */
export async function createSnapCreditPurchase({
  secretArn,
  userId,
  credits,
  unitPriceIdr = CREDIT_UNIT_PRICE_IDR,
  isProduction = process.env.MIDTRANS_IS_PRODUCTION === "true",
}) {
  const parsed = await getJsonSecret(secretArn);
  const { serverKey, clientKey } = midtransKeysFromSecret(parsed);

  const grossAmount = credits * unitPriceIdr;
  const orderId = orderIdNow();

  const parameter = {
    transaction_details: {
      order_id: orderId,
      gross_amount: grossAmount,
    },
    customer_details: {
      id: String(userId),
    },
    item_details: [
      {
        id: "IM-01",
        price: unitPriceIdr,
        quantity: credits,
        name: `${credits} Credits`,
      },
    ],
    expiry: {
      duration: 1,
      unit: "days",
    },
    custom_field1: String(userId),
  };

  const snap = new Midtrans.Snap({
    isProduction,
    serverKey,
    clientKey,
  });

  const res = await snap.createTransaction(parameter);
  const redirectUrl = res?.redirect_url;
  if (!redirectUrl || typeof redirectUrl !== "string") {
    throw new Error("Midtrans tidak mengembalikan redirect_url");
  }
  return {
    orderId,
    grossAmount,
    redirect_url: redirectUrl,
    token: res?.token,
  };
}

/**
 * Baris ORDER yang diharapkan notifikasi Midtrans (status PAID / recovery).
 * Panggil setelah `createSnapCreditPurchase` dengan orderId & grossAmount yang sama.
 *
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} ddb
 * @param {string} tableBilling
 * @param {{
 *   senderId: string,
 *   orderId: string,
 *   credits: number,
 *   grossAmount: number,
 *   provider?: string | null,
 *   chatId?: string | null,
 * }} p
 */
export async function putPendingCreditOrder(ddb, tableBilling, p) {
  const now = Date.now();
  await ddb.send(
    new PutCommand({
      TableName: tableBilling,
      Item: {
        PK: billingUserPk(p.senderId),
        SK: `ORDER#${p.orderId}`,
        userId: String(p.senderId),
        orderId: p.orderId,
        credits: p.credits,
        grossAmount: p.grossAmount,
        unitPriceIdr: CREDIT_UNIT_PRICE_IDR,
        provider: p.provider ?? null,
        chatId: p.chatId != null ? String(p.chatId) : null,
        createdAt: now,
        status: "PENDING_SNAP",
        entityType: "ORDER",
      },
    }),
  );
}

/**
 * Snap + persist ORDER (satu alur untuk API Anda).
 */
export async function createSnapWithPendingOrder(ddb, tableBilling, opts) {
  const {
    secretArn,
    userId,
    credits,
    provider,
    chatId,
    unitPriceIdr,
    isProduction,
  } = opts;
  const snap = await createSnapCreditPurchase({
    secretArn,
    userId: String(userId),
    credits,
    unitPriceIdr,
    isProduction,
  });
  await putPendingCreditOrder(ddb, tableBilling, {
    senderId: String(userId),
    orderId: snap.orderId,
    credits,
    grossAmount: snap.grossAmount,
    provider: provider ?? null,
    chatId: chatId ?? null,
  });
  return snap;
}
