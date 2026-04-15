import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  INTENTS,
  normalizeIntentForRouting,
  UPLOAD_THEME_OPTIONS,
} from "./constants.js";
import { sanitizeAndCapTokens } from "./sanitize.js";

const MODEL_ID = "gemini-2.5-flash-lite";

const GEMINI_RETRY_DELAY_MS = 1000;

const WHATSAPP_ADMIN_SYSTEM = `Kamu admin chat DapurArtisan (AI konten UMKM makanan). Gaya: santai, singkat, sedikit menjual (bantu closing). Bahasa Indonesia; emoji boleh secukupnya. Di akhir jawaban, selalu ajak user mencoba / lanjut pakai layanan (CTA singkat, natural).`;

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Satu percobaan ulang setelah jeda bila API sibut (503) / overload. */
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

/**
 * Gemini kadang membungkus JSON dengan ```json ... ``` atau menambah teks di luar objek.
 * @param {string} raw
 * @returns {Record<string, unknown>|null}
 */
export function parseJsonObjectFromModelText(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?\s*/i, "");
  s = s.replace(/\s*```\s*$/i, "");
  s = s.trim();
  try {
    const parsed = JSON.parse(s);
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    const i = s.indexOf("{");
    const j = s.lastIndexOf("}");
    if (i < 0 || j <= i) return null;
    try {
      const parsed = JSON.parse(s.slice(i, j + 1));
      return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }
}

function normalizeIntent(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  const hit = INTENTS.find((i) => i.toLowerCase() === s);
  if (hit) return hit;
  const sUnder = s.replace(/\s+/g, "_");
  const hitUnder = INTENTS.find((i) => i.replace(/\s+/g, "_") === sUnder);
  if (hitUnder) return hitUnder;
  const fuzzy = INTENTS.find((i) => {
    const iu = i.replace(/\s+/g, "_");
    if (i === "salam") return false;
    return sUnder.includes(iu) || iu.includes(sUnder);
  });
  return fuzzy ?? "unknown";
}

/**
 * Klasifikasi intent memakai kutipan pengetahuan (RAG atau panduan statis INTENT_CLASSIFIER_GUIDE).
 * @param {string} apiKey — Gemini
 * @param {string[]} userTexts — baris pesan user
 * @param {string} intentKnowledgeFromRag — teks konteks dari retrieveProductRagContext / INTENT_CLASSIFIER_GUIDE
 * @param {{ source?: string }} [options] — mis. `{ source: "gemini_only" }` untuk logging
 */
export async function classifyIntent(
  apiKey,
  userTexts,
  intentKnowledgeFromRag,
  options = {},
) {
  const lines = userTexts.filter(Boolean).map((t) => sanitizeAndCapTokens(t, 200));
  const combined = lines.join("\n");
  const promptBody = sanitizeAndCapTokens(combined, 400);
  const ragBlock = String(intentKnowledgeFromRag ?? "").trim().slice(0, 12000);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_ID,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 96,
      responseMimeType: "application/json",
    },
  });

  const prompt = `Anda mengklasifikasi intent chat pelanggan DapurArtisan (Bahasa Indonesia).

**Satu-satunya referensi label intent** ada di kutipan pengetahuan berikut (RAG / basis internal). Jangan mengira-ngira kategori di luar kutipan.
${ragBlock || "(Tidak ada kutipan — jawab unknown.)"}

Aturan keluaran:
- HANYA JSON valid: {"intent":"<string>"}
- Nilai "intent" = label intent persis seperti di kutipan (termasuk bentuk tanya_harga atau frasa dengan spasi bila kutipan menuliskannya demikian), atau "unknown" bila tidak cocok.
- Pesan user bisa beberapa baris.

Pesan user:
${promptBody}`;

  const outSource = options.source ?? "rag_classifier";

  const result = await withGeminiRetry(() => model.generateContent(prompt));
  const text = result.response.text();
  const parsed = parseJsonObjectFromModelText(text);
  if (!parsed || !("intent" in parsed)) {
    return { intent: "unknown", rawModelText: text, source: outSource };
  }
  const intent = normalizeIntentForRouting(normalizeIntent(parsed.intent));
  return { intent, rawModelText: text, source: outSource };
}

const THEME_HINT = UPLOAD_THEME_OPTIONS.map((o) => `${o.id}: ${o.label}`).join("; ");

/**
 * Ekstrak tema/gaya dan teks banner (opsional) dari pesan user untuk alur upload gambar.
 * Keberadaan lampiran gambar ditentukan di luar (structured); LLM hanya mengisi teks.
 *
 * @param {string} apiKey
 * @param {{ userTextBlob: string, hasImageInWindow: boolean, hasImageTextCombo?: boolean }} ctx
 * @returns {Promise<{ themeStyle: string|null, bannerText: string|null, rawModelText?: string }>}
 */
export async function extractUploadGambarSlots(apiKey, ctx) {
  const blob = sanitizeAndCapTokens(String(ctx.userTextBlob ?? ""), 400);
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_ID,
    generationConfig: {
      temperature: 0.15,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
    },
  });

  const imageNote = ctx.hasImageTextCombo
    ? "Pesan ini mencakup gambar dan teks dalam bubble yang sama — utamakan teks tersebut untuk tema dan teks banner."
    : ctx.hasImageInWindow
      ? "User sudah mengirim lampiran gambar di jendela pesan ini."
      : "Belum terdeteksi lampiran gambar di jendela pesan ini (boleh tetap isi slot dari teks).";

  const prompt = `Ekstrak slot untuk alur edit foto DapurArtisan dari pesan user (Bahasa Indonesia).

${imageNote}

**themeStyle** — pilih **persis salah satu id** dari daftar jika pesan user jelas cocok; jika user hanya menggambarkan gaya secara umum, pilih id yang paling mendekati; jika tidak memungkinkan, null.
Daftar tema: ${THEME_HINT}

**bannerText** — teks promosi / headline / CTA / harga / diskon yang user sebut untuk dipakai di banner; jika tidak ada, null.

Pesan user (bisa beberapa baris digabung):
"""
${blob || "(kosong)"}
"""

HANYA JSON valid, tanpa markdown:
{"themeStyle":string|null,"bannerText":string|null}`;

  const result = await withGeminiRetry(() => model.generateContent(prompt));
  const text = result.response.text();
  const parsed = parseJsonObjectFromModelText(text);
  if (!parsed) {
    return { themeStyle: null, bannerText: null, rawModelText: text };
  }
  const themeStyle =
    parsed.themeStyle != null && String(parsed.themeStyle).trim()
      ? String(parsed.themeStyle).trim()
      : null;
  const bannerText =
    parsed.bannerText != null && String(parsed.bannerText).trim()
      ? String(parsed.bannerText).trim()
      : null;
  return { themeStyle, bannerText, rawModelText: text };
}

/**
 * Chat-style reply (setara createChatCompletion): system = admin WhatsApp ramah, user = prompt Anda.
 * Mengembalikan teks balasan model.
 */
export async function generateResponse(apiKey, prompt) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const userText = sanitizeAndCapTokens(String(prompt ?? ""), 4000);

  const model = genAI.getGenerativeModel({
    model: MODEL_ID,
    systemInstruction: WHATSAPP_ADMIN_SYSTEM,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  });

  const result = await withGeminiRetry(() => model.generateContent(userText));
  return result.response.text();
}
