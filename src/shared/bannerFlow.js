import {
  BANNER_ASK_WHEN_READY,
  BANNER_FALLBACK_INSUFFICIENT,
  INTENT_BUATKAN_BANNER,
} from "./constants.js";

const PLACEHOLDER_IMAGE = "[gambar]";
const READY_PATTERNS = [
  /sudah\s+siap/i,
  /\bsiap\s+(untuk\s+)?(di)?proses/i,
  /\bproses\b/i,
  /^gas\b/i,
  /sudah\s+lengkap/i,
  /silakan\s+(di)?proses/i,
  /^ya\b/i,
  /^iya\b/i,
  /^y\b$/i,
  /^yes\b/i,
  /\bok(e)?\b/i,
  /^sip\b/i,
];

/** Teks banner: bukan placeholder gambar saja, minimal beberapa karakter bermakna. */
export function hasMeaningfulBannerText(text) {
  const t = String(text ?? "").trim();
  if (t.length < 3) return false;
  if (t === PLACEHOLDER_IMAGE) return false;
  return true;
}

export function userSaysReadyToProcess(texts) {
  const blob = texts.join("\n").trim();
  if (!blob) return false;
  return READY_PATTERNS.some((re) => re.test(blob));
}

/**
 * @param {Array<{ text?: string, hasImage?: boolean, imageFileId?: string }>} timelineItems ascending createdAt
 */
export function analyzeBannerMaterials(timelineItems) {
  let hasImage = false;
  let hasText = false;
  for (const it of timelineItems) {
    if (it.imageFileId || it.hasImage) hasImage = true;
    if (hasMeaningfulBannerText(it.text)) hasText = true;
  }
  return { hasImage, hasText };
}

/**
 * @param {string} intent
 * @param {string[]} windowTexts untuk deteksi "siap"
 * @param {ReturnType<typeof analyzeBannerMaterials>} materials
 */
export function resolveBannerReply(intent, windowTexts, materials) {
  if (intent !== INTENT_BUATKAN_BANNER) return null;
  const ready = userSaysReadyToProcess(windowTexts);
  const { hasImage, hasText } = materials;
  const complete = hasImage && hasText;

  if (ready && !complete) {
    return BANNER_FALLBACK_INSUFFICIENT;
  }
  if (!complete) {
    return `Hai kak! Untuk banner kami butuh gambar dan teks promosinya (boleh dikirim terpisah ya). Kalau sudah lengkap, ${BANNER_ASK_WHEN_READY} 🙂`;
  }
  if (!ready) {
    return `Makasih kak, gambar & teksnya sudah kami terima. ${BANNER_ASK_WHEN_READY.charAt(0).toUpperCase()}${BANNER_ASK_WHEN_READY.slice(1)} 🙂`;
  }
  return null;
}
