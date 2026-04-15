import { createHash } from "node:crypto";
import { billingUserPk } from "./creditProfile.js";

/** Midtrans menganggap sukses untuk Snap / pembayaran selesai. */
export function isMidtransPaymentSuccess(payload) {
  const ts = String(payload.transaction_status ?? payload.transactionStatus ?? "").toLowerCase();
  return ts === "settlement" || ts === "capture";
}

/** Variasi string gross_amount yang dipakai Midtrans saat membentuk signature. */
function midtransGrossAmountSignatureVariants(grossRaw) {
  const s = String(grossRaw ?? "").trim();
  const out = [];
  const add = (x) => {
    if (x == null || x === "") return;
    if (!out.includes(x)) out.push(x);
  };
  add(s);
  const n = Number(String(s).replace(/,/g, ""));
  if (Number.isFinite(n)) {
    add(n.toFixed(2));
    add(String(Math.trunc(n)));
    if (Math.abs(n - Math.trunc(n)) < 1e-9) {
      add(`${Math.trunc(n)}.00`);
    }
  }
  return out;
}

/**
 * Verifikasi signature_key: SHA512(order_id + status_code + gross_amount + serverKey)
 * Mencoba beberapa format gross_amount (mis. "6000.00" vs "6000") agar cocok dengan notifikasi JSON.
 * @see https://docs.midtrans.com/reference/handle-notifications
 */
export function verifyMidtransSignatureKey(payload, serverKey) {
  const orderId = String(payload.order_id ?? payload.orderId ?? "");
  const statusCode = String(payload.status_code ?? payload.statusCode ?? "");
  const signatureKey = String(payload.signature_key ?? payload.signatureKey ?? "");
  if (!orderId || !signatureKey || !serverKey) return false;

  const grossVariants = midtransGrossAmountSignatureVariants(
    payload.gross_amount ?? payload.grossAmount ?? "",
  );
  for (const grossAmount of grossVariants) {
    const input = orderId + statusCode + grossAmount + serverKey;
    const hash = createHash("sha512").update(input, "utf8").digest("hex");
    if (hash.toLowerCase() === signatureKey.toLowerCase()) return true;
  }
  return false;
}

export function orderSkFromOrderId(orderId) {
  if (!orderId) return null;
  return `ORDER#${String(orderId)}`;
}

function extractUserIdFromPayload(payload) {
  let v = (payload.custom_field1 ?? payload.customField1 ?? "").toString().trim();
  if (v) return v;
  const cd = payload.customer_details ?? payload.customerDetails;
  if (typeof cd === "string") {
    try {
      const p = JSON.parse(cd);
      v = String(p?.id ?? p?.ID ?? "").trim();
      if (v) return v;
    } catch {
      /* ignore */
    }
  }
  if (cd && typeof cd === "object") {
    v = String(cd.id ?? cd.ID ?? "").trim();
    if (v) return v;
  }
  return "";
}

/** custom_field1 (Snap) atau customer_details.id = userId (senderId). */
export function userPkFromMidtransPayload(payload) {
  const uid = extractUserIdFromPayload(payload);
  if (!uid) return null;
  return billingUserPk(uid);
}

export function parseApiGatewayBody(event) {
  let raw = event.body ?? "";
  if (event.isBase64Encoded && typeof raw === "string") {
    raw = Buffer.from(raw, "base64").toString("utf8");
  }
  if (typeof raw !== "string") {
    return raw && typeof raw === "object" ? raw : {};
  }
  const headers = event.headers ?? {};
  const ct = headerValue(headers, "content-type").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(raw || "{}");
    } catch {
      return {};
    }
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    try {
      return Object.fromEntries(new URLSearchParams(raw).entries());
    } catch {
      return {};
    }
  }
}

function headerValue(headers, name) {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return String(v ?? "");
  }
  return "";
}
