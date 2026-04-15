import Midtrans from "midtrans-client";
import {
  CREDIT_UNIT_PRICE_IDR,
  MIN_CREDIT_PURCHASE,
} from "./constants.js";
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

/**
 * Ambil jumlah credit dari teks user (beberapa bubble digabung).
 * Utamakan pola eksplisit "N credit"; fallback angka tunggal di baris terakhir.
 */
export function extractPurchaseCreditsFromUserLines(lines, minCredits = MIN_CREDIT_PURCHASE) {
  const joined = lines.join(" ").toLowerCase();
  const fromExplicit = [];
  const reCredit = /(\d{1,6})\s*(?:credit|credits|kredit)\b/gi;
  let m;
  while ((m = reCredit.exec(joined)) !== null) {
    fromExplicit.push(parseInt(m[1], 10));
  }
  if (fromExplicit.length > 0) {
    return Math.max(...fromExplicit);
  }

  const reBeli = /\b(?:beli|top\s*up|topup|isi|tambah|order|mau)\s+(?:\w+\s*){0,4}(\d{1,6})\b/gi;
  while ((m = reBeli.exec(joined)) !== null) {
    fromExplicit.push(parseInt(m[1], 10));
  }
  if (fromExplicit.length > 0) {
    return Math.max(...fromExplicit);
  }

  const last = (lines[lines.length - 1] ?? "").trim();
  const solo = last.match(/^\s*(\d{1,6})\s*$/);
  if (solo) {
    const n = parseInt(solo[1], 10);
    if (n >= minCredits && n <= 50000) return n;
  }

  const nums = [...joined.matchAll(/\b(\d{2,6})\b/g)].map((x) => parseInt(x[1], 10));
  const plausible = nums.filter((n) => n >= minCredits && n <= 50000);
  if (plausible.length === 1) return plausible[0];

  return null;
}

function orderIdNow() {
  return `ORDER-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Buat transaksi Snap Midtrans; mengembalikan { orderId, redirect_url, token }.
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
