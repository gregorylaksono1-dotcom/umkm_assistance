import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL_ID = "gemini-2.5-flash-lite";
const RETRY_MS = 1000;

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

async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isRetryableGeminiError(err)) throw err;
    await sleepMs(RETRY_MS);
    return await fn();
  }
}

/**
 * Terjemahkan / rapikan instruksi user ke bahasa Inggris untuk pipeline gambar atau video.
 *
 * @param {string} apiKey
 * @param {string} instruction — teks keterangan (biasanya Indonesia)
 * @param {"image"|"video"} mediaType
 * @returns {Promise<string>}
 */
export async function translateInstructionToEnglish(apiKey, instruction, mediaType) {
  const text = String(instruction ?? "").trim().slice(0, 3500);
  if (!text) {
    throw new Error("empty_instruction");
  }

  const pipelineHint =
    mediaType === "video"
      ? "video generation from a single source image"
      : "image editing / restyling from a source photo";

  const prompt = `Translate and refine the following user instruction into clear, natural English for an AI ${pipelineHint}.

Rules:
- Output ONLY the English instruction text. No quotes, labels, or preamble.
- Keep all concrete details: subjects, actions, style, colors, mood, composition.
- The input may be Indonesian, English, or mixed.

User instruction:
${text}`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_ID,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 512,
    },
  });

  const result = await withRetry(() => model.generateContent(prompt));
  const out = String(result.response.text() ?? "").trim();
  if (!out) {
    throw new Error("empty_translation");
  }
  return out.slice(0, 4000);
}
