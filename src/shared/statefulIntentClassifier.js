import { GoogleGenerativeAI } from "@google/generative-ai";
import { parseJsonObjectFromModelText } from "./gemini.js";
import { sanitizeAndCapTokens } from "./sanitize.js";
import {
  CONV_STATE_WAITING_IMAGE_PROMPT,
  CONV_STATE_WAITING_TOPUP_AMOUNT,
  CONV_STATE_WAITING_TOPUP_CONFIRMATION,
} from "./senderConversationMeta.js";

const MODEL_ID = "gemini-2.5-flash-lite";
const GEMINI_RETRY_DELAY_MS = 1000;

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableGeminiError(err) {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (status === 503 || status === 429) return true;
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("unavailable") ||
    msg.includes("overloaded") ||
    msg.includes("too many requests")
  );
}

async function withGeminiRetry(generateOnce) {
  try {
    return await generateOnce();
  } catch (err) {
    if (!isRetryableGeminiError(err)) throw err;
    await sleepMs(GEMINI_RETRY_DELAY_MS);
    return await generateOnce();
  }
}

export const SPEC_INTENT = {
  CONFIRM_TOPUP: "CONFIRM_TOPUP",
  CANCEL_TOPUP: "CANCEL_TOPUP",
  PROVIDE_TOPUP_AMOUNT: "PROVIDE_TOPUP_AMOUNT",
  TOPUP: "TOPUP",
  EDIT_IMAGE: "EDIT_IMAGE",
  GENERATE_IMAGE: "GENERATE_IMAGE",
  FAQ: "FAQ",
  SMALL_TALK: "SMALL_TALK",
  UNKNOWN: "UNKNOWN",
};

const ALL_SPEC = new Set(Object.values(SPEC_INTENT));

/**
 * @param {string|null} effectiveState
 * @returns {string[]}
 */
export function getAllowedSpecIntentsForState(effectiveState) {
  const s = effectiveState == null || effectiveState === "" ? null : String(effectiveState);
  if (s === CONV_STATE_WAITING_TOPUP_AMOUNT) {
    return [
      SPEC_INTENT.PROVIDE_TOPUP_AMOUNT,
      SPEC_INTENT.CANCEL_TOPUP,
      SPEC_INTENT.UNKNOWN,
    ];
  }
  if (s === CONV_STATE_WAITING_TOPUP_CONFIRMATION) {
    return [
      SPEC_INTENT.CONFIRM_TOPUP,
      SPEC_INTENT.CANCEL_TOPUP,
      SPEC_INTENT.PROVIDE_TOPUP_AMOUNT,
      SPEC_INTENT.UNKNOWN,
    ];
  }
  if (s === CONV_STATE_WAITING_IMAGE_PROMPT) {
    return [
      SPEC_INTENT.EDIT_IMAGE,
      SPEC_INTENT.GENERATE_IMAGE,
      SPEC_INTENT.TOPUP,
      SPEC_INTENT.FAQ,
      SPEC_INTENT.SMALL_TALK,
      SPEC_INTENT.UNKNOWN,
    ];
  }
  return [
    SPEC_INTENT.TOPUP,
    SPEC_INTENT.EDIT_IMAGE,
    SPEC_INTENT.GENERATE_IMAGE,
    SPEC_INTENT.FAQ,
    SPEC_INTENT.SMALL_TALK,
    SPEC_INTENT.UNKNOWN,
 ];
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeSpecIntent(raw) {
  const u = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  if (ALL_SPEC.has(u)) return u;
  const aliases = new Map([
    ["TOP_UP", SPEC_INTENT.TOPUP],
    ["BUY_CREDITS", SPEC_INTENT.TOPUP],
    ["PURCHASE_CREDITS", SPEC_INTENT.TOPUP],
    ["IMAGE_EDIT", SPEC_INTENT.EDIT_IMAGE],
    ["CREATE_IMAGE", SPEC_INTENT.GENERATE_IMAGE],
  ]);
  if (aliases.has(u)) return aliases.get(u);
  return SPEC_INTENT.UNKNOWN;
}

/**
 * @param {string} specIntent
 * @param {string|null} effectiveState
 * @returns {string}
 */
export function coerceSpecIntentToAllowed(specIntent, effectiveState) {
  const normalized = normalizeSpecIntent(specIntent);
  const allowed = getAllowedSpecIntentsForState(effectiveState);
  if (allowed.includes(normalized)) return normalized;
  return SPEC_INTENT.UNKNOWN;
}

const STATEFUL_RULES = `
Anda mengklasifikasi intent chat pelanggan DapurArtisan (Bahasa Indonesia) dengan **state percakapan**.

## State (current_state)
- null / kosong: percakapan bebas.
- WAITING_TOPUP_AMOUNT: bot baru meminta user menulis jumlah credit yang mau dibeli.
- WAITING_TOPUP_CONFIRMATION: bot menunggu konfirmasi (ya/tidak) sebelum link pembayaran.
- WAITING_IMAGE_PROMPT: bot sedang menunggu instruksi lanjutan untuk upload/edit foto (tema, teks banner, atau konfirmasi ringkasan). User boleh juga meminta top-up credit (TOPUP) untuk mengalihkan ke pembelian.

## Aturan
- **Jangan mengabaikan state.** Jika current_state mengunci pilihan, pilih hanya intent yang masuk akal untuk state itu.
- Gunakan **last_system_message** (jika ada) sebagai konteks apa yang baru saja ditanyakan bot.
- Pesan user bisa beberapa baris (gabungan).

## Label intent (HANYA salah satu, huruf besar, underscore)
- TOPUP — user ingin beli/top up credit / isi saldo / minta link bayar (bukan saat state WAITING_TOPUP_AMOUNT; di sana gunakan PROVIDE_TOPUP_AMOUNT untuk angka).
- PROVIDE_TOPUP_AMOUNT — user memberikan jumlah credit (angka) saat menunggu jumlah atau mengubah jumlah di langkah konfirmasi.
- CONFIRM_TOPUP — user setuju melanjutkan pembelian (ya/ok/setuju/gas) saat WAITING_TOPUP_CONFIRMATION.
- CANCEL_TOPUP — user membatalkan top-up (batal/tidak/ga jadi/cancel).
- EDIT_IMAGE — melanjutkan alur foto: tema, caption/banner, revisi edit foto.
- GENERATE_IMAGE — minta gambar/banner/poster promosi baru (bukan sekadar FAQ).
- FAQ — pertanyaan info produk, harga, cara pakai, fitur.
- SMALL_TALK — sapaan ringan tanpa tujuan bisnis jelas.
- UNKNOWN — tidak yakin atau di luar daftar yang diizinkan untuk state ini.

## Output
HANYA JSON valid:
{"intent":"<LABEL>","confidence":<angka 0..1>,"reason":"<satu kalimat singkat bahasa Indonesia>"}

## Intent yang diizinkan untuk state saat ini
Akan diberikan di bagian "ALLOWED_INTENTS" pada prompt — pilih **hanya** dari daftar itu. Jika ragu, gunakan UNKNOWN.
`.trim();

/**
 * @param {string} apiKey
 * @param {{
 *   current_state: string|null,
 *   last_system_message: string,
 *   user_message: string,
 *   ragGuideSlice?: string,
 * }} input
 * @returns {Promise<{ specIntent: string, confidence: number, reason: string, rawModelText: string, source: string }>}
 */
export async function classifyIntentWithState(apiKey, input) {
  const currentState =
    input.current_state == null || input.current_state === ""
      ? "null"
      : String(input.current_state);
  const lastMsg = sanitizeAndCapTokens(
    String(input.last_system_message ?? ""),
    800,
  );
  const userMsg = sanitizeAndCapTokens(String(input.user_message ?? ""), 600);
  const rag = String(input.ragGuideSlice ?? "")
    .trim()
    .slice(0, 4000);
  const effectiveStateForAllow =
    currentState === "null" ? null : currentState;
  const allowed = getAllowedSpecIntentsForState(effectiveStateForAllow);
  const allowedBlock = allowed.join(", ");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_ID,
    generationConfig: {
      temperature: 0.15,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
    },
  });

  const prompt = `${STATEFUL_RULES}

ALLOWED_INTENTS untuk state ini: ${allowedBlock}

**Kutipan ringkas produk (referensi sekunder, jangan mengabaikan state):**
${rag || "(tidak ada)"}

**current_state:** ${currentState}
**last_system_message:**
"""
${lastMsg || "(kosong)"}
"""

**user_message:**
"""
${userMsg || "(kosong)"}
"""
`;

  const result = await withGeminiRetry(() => model.generateContent(prompt));
  const text = result.response.text();
  const parsed = parseJsonObjectFromModelText(text);
  let specIntent = SPEC_INTENT.UNKNOWN;
  let confidence = 0;
  let reason = "";

  if (parsed && typeof parsed === "object") {
    specIntent = normalizeSpecIntent(parsed.intent);
    const c = Number(parsed.confidence);
    confidence = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0;
    reason = String(parsed.reason ?? "").trim().slice(0, 300);
  }

  specIntent = coerceSpecIntentToAllowed(specIntent, effectiveStateForAllow);

  return {
    specIntent,
    confidence,
    reason,
    rawModelText: text,
    source: "stateful_classifier",
  };
}
