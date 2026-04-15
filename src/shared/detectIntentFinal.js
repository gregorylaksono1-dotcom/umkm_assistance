import {
  INTENT_BELI_CREDIT,
  INTENT_BUATKAN_BANNER,
  INTENT_BUATKAN_PROMO_TEXT,
  INTENT_PROCESS_IMAGE_CONFIRMED,
  INTENT_SALAM,
  INTENT_TANYA_INFO,
  INTENT_UPLOAD_GAMBAR,
} from "./constants.js";

/**
 * @typedef {{ text?: string, caption?: string, photo?: boolean }} DetectMessage
 * @typedef {{ state?: "waiting_instruction" }} DetectSession
 * @typedef {{ intent: string, source: string }} DetectIntentResult
 */

/**
 * @param {Record<string, unknown>|undefined} item
 * @returns {DetectMessage}
 */
export function windowItemToDetectMessage(item) {
  if (!item) {
    return { text: "", caption: "", photo: false };
  }
  const raw = String(item.text ?? "").trim();
  const photo = Boolean(item.imageFileId || item.hasImage);
  return {
    text: raw,
    caption: raw,
    photo,
  };
}

/**
 * @param {Record<string, unknown>[]} windowItems
 * @param {string} triggerMessageId
 */
export function pickTriggerWindowItem(windowItems, triggerMessageId) {
  const tid = String(triggerMessageId ?? "");
  const found = windowItems.find((i) => String(i.messageId ?? "") === tid);
  return found ?? windowItems[windowItems.length - 1];
}

/**
 * Pertanyaan umum (override ke tanya_info) — setelah gambar & konfirmasi singkat.
 * @param {string} text lowercased full message
 */
export function isQuestion(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (t.includes("?")) return true;
  return /^(apa|apakah|bagaimana|berapa|mengapa|kenapa|kapan|dimana|di\s*mana|kok|kenap|bisa|boleh)\b/i.test(
    t,
  );
}

export function isEditInstruction(text) {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return false;
  return (
    /\b(ubah|ganti|revisi|edit|crop|potong|zoom|terang|gelap|warna|kontras|brightness|filter)\b/.test(
      t,
    ) ||
    t.includes("mau edit") ||
    t.includes("ingin edit") ||
    t.includes("mau upload") ||
    t.includes("tolong edit")
  );
}

export function isPurchaseIntent(text) {
  const t = String(text ?? "").toLowerCase();
  return (
    /\b(beli|top\s*up|isi\s+saldo|tambah\s+saldo|bayar|checkout|pembelian)\b/.test(
      t,
    ) && /\b(credit|kredit|saldo)\b/.test(t)
  );
}

export function isCheckCredit(text) {
  const t = String(text ?? "").toLowerCase();
  return (
    (/\b(cek|lihat|cek\s+saldo|sisa)\b/.test(t) &&
      /\b(credit|kredit|saldo)\b/.test(t)) ||
    /\bberapa\s+(sisa\s+)?(credit|kredit|saldo)\b/.test(t)
  );
}

export function isBannerRequest(text) {
  const t = String(text ?? "").toLowerCase();
  return (
    /\b(banner|poster|spanduk|flyer|feed\s*ig|thumbnail)\b/.test(t) ||
    /\b(buat(?:kan)?|desain(?:kan)?)\b/.test(t) &&
      /\b(banner|poster|promo)\b/.test(t)
  );
}

export function isPromoText(text) {
  const t = String(text ?? "").toLowerCase();
  return (
    /\b(teks\s+promo|caption\s+jualan|copywriting|kata[\s-]*kata\s+promo|tulis(?:kan)?\s+promo)\b/.test(
      t,
    ) || (/\bbuat(?:kan)?\b/.test(t) && /\b(promo|copy)\b/.test(t))
  );
}

export function isGreeting(text) {
  const t = String(text ?? "").toLowerCase().trim();
  if (!t) return false;
  if (t.length > 80) return false;
  return (
    /^(halo|hai|hi|hey|hallo|hello|pagi|siang|sore|malam|bro|sis|kak)\b/.test(
      t,
    ) ||
    /^assalam(u|ualaikum)/.test(t) ||
    /^waalaikumsalam/.test(t) ||
    /^selamat\s+(pagi|siang|sore|malam)\b/.test(t)
  );
}

/**
 * Deteksi deterministik (tanpa RAG). Mengembalikan null → lanjut RAG + classifier.
 *
 * Urutan: session → gambar → konfirmasi singkat → pertanyaan → aksi → salam.
 *
 * @param {DetectMessage} message
 * @param {DetectSession} session
 * @returns {DetectIntentResult | null}
 */
export function detectIntentFinalHeuristic(message, session) {
  const raw = String(message?.text || message?.caption || "").trim();
  const text = raw.toLowerCase();
  const hasImage = Boolean(message?.photo);

  if (session?.state === "waiting_instruction") {
    return {
      intent: INTENT_UPLOAD_GAMBAR,
      source: "session_waiting_instruction",
    };
  }

  if (hasImage) {
    return { intent: INTENT_UPLOAD_GAMBAR, source: "has_image" };
  }

  const short = raw.toLowerCase();
  if (["ya", "ok", "oke", "setuju"].includes(short)) {
    return {
      intent: INTENT_PROCESS_IMAGE_CONFIRMED,
      source: "short_confirm",
    };
  }

  if (isQuestion(text)) {
    return { intent: INTENT_TANYA_INFO, source: "question_override" };
  }

  if (isEditInstruction(text)) {
    return { intent: INTENT_UPLOAD_GAMBAR, source: "edit_instruction" };
  }

  if (isPurchaseIntent(text)) {
    return { intent: INTENT_BELI_CREDIT, source: "purchase" };
  }

  if (isCheckCredit(text)) {
    return { intent: "cek kredit", source: "check_credit" };
  }

  if (isBannerRequest(text)) {
    return { intent: INTENT_BUATKAN_BANNER, source: "banner_request" };
  }

  if (isPromoText(text)) {
    return { intent: INTENT_BUATKAN_PROMO_TEXT, source: "promo_text" };
  }

  if (isGreeting(text)) {
    return { intent: INTENT_SALAM, source: "greeting" };
  }

  return null;
}
