/** Intent yang boleh diklasifikasi dari pesan user (bukan teks balasan sistem). */
export const INTENTS = [
  "salam",
  "cek_kredit",
  "beli_credit",
  "upload_gambar",
  "process_image_confirmed",
  "buatkan_banner",
  "tanya_info"
];

/** Hint untuk classifier (bukan nilai JSON intent). */
export const INTENT_CLASSIFIER_GUIDE = `
Pilih SATU key intent berikut (snake_case persis):
- salam — sapaan saja: halo, hi, hai, assalamualaikum, selamat pagi/siang/sore/malam, dll. Tanpa pertanyaan bisnis konkret; jika ada tanya harga/fitur di pesan yang sama, pilih intent tanya_* yang relevan
- tanya_harga — tanya harga/biaya secara umum, paket, murah/mahal (tanpa niat beli/top up konkret)
- beli_credit — mau beli/top up credit, isi saldo, cara bayar, payment link, checkout, minimal pembelian (bedakan dari sekadar tanya harga)
- tanya_fitur — fitur, tema gaya, apa saja bisa, AI styling, banner/caption/hashtag
- tanya_keuntungan — keuntungan, kenapa pakai, bedanya apa, value, cocok untuk siapa
- tanya_cara_pakai — cara pakai, langkah, mulai dari mana, tutorial singkat
- cek kredit — cek saldo/kredit sisa (bukan beli)
- upload gambar — mau kirim/upload/unggah foto gambar makanan, lampiran gambar, niat upload; atau bubble yang hanya berisi gambar tanpa teks (bedakan dari tanya_cara_pakai yang hanya tanya langkah tanpa niat kirim file)
- process_image_confirmed — user SETUJU memulai proses setelah melihat ringkasan (ya/ok/setuju/gas/lanjut proses/sudah siap); bukan sekadar menyebut tema
- buatkan banner — minta desain/banner/poster promosi
`.trim();

export const INTENT_LIST_PROMPT = INTENTS.map((i) => `- ${i}`).join("\n");

export const INTENT_BUATKAN_BANNER = "buatkan banner";

/** Minta teks promo / copywriting (bukan desain gambar). */
export const INTENT_BUATKAN_PROMO_TEXT = "buatkan_promo_text";

export const INTENT_SALAM = "salam";

export const INTENT_BELI_CREDIT = "beli_credit";

/** Info produk / FAQ umum — jawaban dari indeks pengetahuan Pinecone terpisah. */
export const INTENT_TANYA_INFO = "tanya_info";

export const INTENT_UPLOAD_GAMBAR = "upload gambar";

/** User mengonfirmasi permintaan edit/upload gambar siap diproses (setelah ringkasan). */
export const INTENT_PROCESS_IMAGE_CONFIRMED = "process_image_confirmed";

export const INTENT_UNKNOWN = "unknown";

/**
 * Menyamakan label dari model / RAG / metadata Pinecone ke string intent * yang dipakai `if (intent === INTENT_*)` di router (beda spasi vs underscore).
 * @param {string|null|undefined} intent
 */
export function normalizeIntentForRouting(intent) {
  const s = String(intent ?? "").trim();
  if (!s) return INTENT_UNKNOWN;
  const lower = s.toLowerCase();
  const aliases = new Map([
    ["upload_gambar", INTENT_UPLOAD_GAMBAR],
    ["upload gambar", INTENT_UPLOAD_GAMBAR],
    ["cek_kredit", "cek kredit"],
    ["buatkan_banner", INTENT_BUATKAN_BANNER],
    ["buatkan banner", INTENT_BUATKAN_BANNER],
    ["buatkan_promo_text", INTENT_BUATKAN_PROMO_TEXT],
  ]);
  if (aliases.has(lower)) return aliases.get(lower);
  const under = lower.replace(/\s+/g, "_");
  if (aliases.has(under)) return aliases.get(under);
  return s;
}

/** Harga per credit (IDR), selaras dengan knowledge / produk. */
export const CREDIT_UNIT_PRICE_IDR = 600;

/** Minimum credit per transaksi pembelian. */
export const MIN_CREDIT_PURCHASE = 10;

/** Intent info produk: jawaban dari RAG (Pinecone) + Gemini, bukan markdown statis. */
export const PRODUCT_RAG_INTENTS = new Set([
  INTENT_TANYA_INFO,
  INTENT_BUATKAN_PROMO_TEXT,
  "tanya_harga",
  "tanya_fitur",
  "tanya_keuntungan",
  "tanya_cara_pakai",
  "cek kredit",
  "cek_kredit",
  "unknown",
]);

/** Balasan fallback ketika user bilang siap proses tapi gambar/teks banner belum lengkap. */
export const BANNER_FALLBACK_INSUFFICIENT = "data kurang untuk pembuatan banner";

/** Ajakan user memberi kabar saat materi banner sudah lengkap. */
export const BANNER_ASK_WHEN_READY =
  "tolong kasih tau ya kak kalau sudah siap untuk di proses";

/** Balasan bila Gemini / langkah LLM gagal (tanpa memanggil model lagi). */
export const LLM_UNAVAILABLE_REPLY_TEXT =
  "Maaf kak, sistem sedang mengalami gangguan. Boleh tolong coba lagi nanti ya \u{1F64F} Terima kasih.";

/** Slot upload gratis (billing_usage_credit PROFILE) untuk user tanpa credit berbayar. */
export const FREE_CREDIT_INITIAL = 3;

/** Bucket S3 untuk unggahan foto (override lewat env UPLOAD_S3_BUCKET). */
export const UPLOAD_S3_BUCKET_DEFAULT = "dapurartisan";

/** Pilihan tema / gaya untuk alur INTENT_UPLOAD_GAMBAR. */
export const UPLOAD_THEME_OPTIONS = [
  {
    id: "minimalis_modern",
    label: "Minimalis modern",
    keywords: ["minimalis", "modern", "bersih"],
  },
  {
    id: "warung_tradisional",
    label: "Warung tradisional",
    keywords: ["tradisional", "warung", "rumahan"],
  },
  {
    id: "premium_dark",
    label: "Premium gelap (moody)",
    keywords: ["premium", "gelap", "moody", "elegan"],
  },
  {
    id: "cerah_social",
    label: "Cerah untuk sosmed",
    keywords: ["cerah", "instagram", "sosmed", "colorful"],
  },
];
