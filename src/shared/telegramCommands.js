import { createSnapWithPendingOrder } from "./creditPurchase.js";
import {
  consumeOneMediaCredit,
  ensureBillingProfile,
  refundOneMediaCredit,
} from "./creditProfile.js";
import {
  INFO_PRODUCT_URL,
  MIN_CREDIT_PURCHASE,
  UPLOAD_S3_BUCKET_DEFAULT,
} from "./constants.js";
import { translateInstructionToEnglish } from "./instructionTranslateGemini.js";
import {
  getRequestResourceChatId,
  putPendingRequestResource,
} from "./requestResourceWrite.js";
import { presignedGetObjectUrls } from "./s3PresignedGet.js";
import { getGeminiApiKey } from "./secrets.js";
import { postThirdPartyAiJob } from "./thirdPartyAiClient.js";
import { uploadTelegramFileToS3 } from "./telegramS3Upload.js";

const MSG_INVALID = "Perintah belum sesuai.";
const MSG_PROCESSING =
  "Oke siap kak permintaan sedang di proses. Mohon ditunggu ya kak \u{1F64F}";
const MSG_GAMBAR_NO_FILE =
  "Kak, file gambar nya belum dikasih. Tolong ulangi lagi ya proses gambar/video nya \u{1F64F}";
const MSG_GAMBAR_NO_KETERANGAN =
  "Kak, baru ada gambarnya, untuk keterangannya belum diterima. Tolong ulangi lagi ya proses gambar/video nya \u{1F64F}";
const MSG_CREDIT_INSUFFICIENT_MEDIA =
  "Maaf kak, kredit tidak cukup untuk memproses permintaan ini. Silakan top up dulu ya.";
const MSG_MEDIA_BACKEND_FAILED =
  "Maaf kak, gagal mengunggah atau menyimpan permintaan. Kredit tidak terpakai. Silakan coba lagi.";
const MSG_THIRD_PARTY_FAILED =
  "Maaf kak, layanan AI gagal memproses gambar. Kredit sudah dikembalikan. Silakan coba lagi.";
const MSG_PRESIGN_FAILED =
  "Selesai kak, hasil sudah tersimpan tapi link unduh sementara gagal dibuat. Coba lagi nanti atau hubungi admin.";

function buildMenuText() {
  return [
    "Perintah yang tersedia:",
    "",
    "• menu — daftar perintah",
    "• info — info produk",
    "• credit — sisa kredit",
    `• topup <angka> — beli credit (min. ${MIN_CREDIT_PURCHASE}), contoh: topup 10`,
    "• gambar <keterangan> — unggah satu foto + teks: gambar <apa yang diinginkan>",
    "  contoh caption: gambar ubah makanan ini jadi gaya instagramable",
    "• video <keterangan> — unggah satu foto + teks: video <deskripsi video>",
    "  contoh caption: video jadikan kucing di gambar berlari di salju",
  ].join("\n");
}

/**
 * Ambil keterangan: teks setelah perintah `gambar` / `video` (boleh /gambar).
 * @param {string} text
 * @param {"gambar"|"video"} command
 * @returns {string|null}
 */
export function parseKeteranganAfterCommand(text, command) {
  const t = String(text ?? "").trim();
  const re = new RegExp(`^\\/?${command}\\b\\s+(.+)$`, "is");
  const m = t.match(re);
  if (!m) return null;
  const k = m[1].trim();
  return k.length > 0 ? k : null;
}

/**
 * @param {string} raw
 * @returns {number|null}
 */
function parseTopupAmount(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  const m = s.match(/^topup\s+(\d+)\s*$/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < MIN_CREDIT_PURCHASE) return null;
  return n;
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} ddb
 * @param {string} tableBilling
 * @param {string} senderId
 * @returns {Promise<{ error: string } | { error: null, source: "paid"|"free" }>}
 */
async function chargeOneCreditForMedia(ddb, tableBilling, senderId) {
  if (!tableBilling) {
    return { error: "Layanan billing belum dikonfigurasi." };
  }
  await ensureBillingProfile(ddb, tableBilling, senderId);
  const consumed = await consumeOneMediaCredit(ddb, tableBilling, senderId);
  if (consumed.kind === "insufficient") {
    return { error: MSG_CREDIT_INSUFFICIENT_MEDIA };
  }
  return { error: null, source: consumed.source };
}

/**
 * @param {object} ctx
 * @param {string} keterangan
 * @param {"image"|"video"} mediaType
 * @param {"paid"|"free"} creditRefundSource — sumber kredit yang dipotong; dipakai refund jika API AI gagal.
 * @returns {Promise<null | { text: string, chatId: string, replyToMessageId: string }>}
 */
async function uploadAndPersistRequestResource(
  ctx,
  keterangan,
  mediaType,
  creditRefundSource,
) {
  const {
    ddb,
    tableRequestResource,
    telegramBotToken,
    uploadS3Bucket,
    parsed,
  } = ctx;
  const bucket = String(uploadS3Bucket ?? "").trim() || UPLOAD_S3_BUCKET_DEFAULT;
  if (!telegramBotToken || !tableRequestResource) {
    throw new Error("request_resource_not_configured");
  }
  if (!parsed.imageFileId) {
    throw new Error("missing_file_id");
  }
  const sourceS3Key = await uploadTelegramFileToS3({
    botToken: telegramBotToken,
    fileId: parsed.imageFileId,
    bucket,
    userId: parsed.senderId,
    messageId: parsed.messageId,
  });

  const { geminiSecretArn, geminiSecretKeyName } = ctx;
  if (!geminiSecretArn) {
    throw new Error("gemini_not_configured");
  }
  const apiKey = await getGeminiApiKey(
    geminiSecretArn,
    geminiSecretKeyName || "gemini_api_key",
  );
  const translation = await translateInstructionToEnglish(
    apiKey,
    keterangan,
    mediaType,
  );

  await putPendingRequestResource(ddb, tableRequestResource, {
    chatId: parsed.chatId,
    userId: parsed.senderId,
    sourceS3Key,
    type: mediaType,
    keterangan,
    translation,
    messageId: parsed.messageId,
  });

  const thirdArn = String(ctx.thirdPartyAiSecretArn ?? "").trim();

  if (thirdArn) {
    let out;
    try {
      out = await postThirdPartyAiJob({
        secretArn: thirdArn,
        bucket,
        sourceS3Key,
        prompt: translation,
        imagination: "subtle",
        ddb,
        tableRequestResource,
        messageId: parsed.messageId,
        userId: parsed.senderId,
      });
    } catch (e) {
      console.error("third_party_ai_failed", {
        message: String(e?.message ?? e),
        chatId: parsed.chatId,
        userId: parsed.senderId,
      });
      const { tableBilling } = ctx;
      if (tableBilling) {
        try {
          await refundOneMediaCredit(
            ddb,
            tableBilling,
            parsed.senderId,
            creditRefundSource,
          );
        } catch (re) {
          console.error("third_party_refund_failed", re);
        }
      }
      const rowChatId = await getRequestResourceChatId(
        ddb,
        tableRequestResource,
        parsed.messageId,
        parsed.senderId,
      );
      const replyChatId =
        rowChatId != null ? rowChatId : String(parsed.chatId);
      return {
        text: MSG_THIRD_PARTY_FAILED,
        chatId: replyChatId,
        replyToMessageId: String(parsed.messageId),
      };
    }

    console.log("third_party_ai_ok", {
      status: out.status,
      taskId: out.taskId,
      resultKeys: out.resultKeys,
      chatId: parsed.chatId,
      userId: parsed.senderId,
    });

    const rowChatId = await getRequestResourceChatId(
      ddb,
      tableRequestResource,
      parsed.messageId,
      parsed.senderId,
    );
    const replyChatId =
      rowChatId != null ? rowChatId : String(parsed.chatId);

    try {
      const urls = await presignedGetObjectUrls(bucket, out.resultKeys);
      const text = [
        "Selesai kak. Link unduh hasil (berlaku ~24 jam):",
        ...urls,
      ].join("\n");
      return {
        text,
        chatId: replyChatId,
        replyToMessageId: String(parsed.messageId),
      };
    } catch (pe) {
      console.error("presigned_get_urls_failed", pe);
      return {
        text: MSG_PRESIGN_FAILED,
        chatId: replyChatId,
        replyToMessageId: String(parsed.messageId),
      };
    }
  } else {
    console.warn("third_party_ai_skipped_no_secret");
  }
  return null;
}

/**
 * @param {object} ctx
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} ctx.ddb
 * @param {string} ctx.tableBilling
 * @param {string} [ctx.tableRequestResource]
 * @param {string} [ctx.telegramBotToken]
 * @param {string} [ctx.uploadS3Bucket]
 * @param {string} [ctx.midtransSecretArn]
 * @param {string} [ctx.geminiSecretArn]
 * @param {string} [ctx.geminiSecretKeyName]
 * @param {string} [ctx.thirdPartyAiSecretArn]
 * @param {{ senderId: string, chatId: string, messageId: string, text: string, hasImage: boolean, imageFileId: string|null }} ctx.parsed
 */
export async function handleTelegramCommand(ctx) {
  const { ddb, tableBilling, midtransSecretArn, parsed } = ctx;
  const text = String(parsed.text ?? "").trim();
  const lower = text.toLowerCase();
  const hasImage = Boolean(parsed.hasImage);

  if (!text && !hasImage) {
    return buildMenuText();
  }

  if (lower === "menu" || lower === "/menu") {
    return buildMenuText();
  }

  if (lower === "info" || lower === "/info") {
    return `Info produk ada di sini ${INFO_PRODUCT_URL}`;
  }

  if (lower === "credit" || lower === "/credit") {
    if (!tableBilling) {
      return "Layanan billing belum dikonfigurasi.";
    }
    const profile = await ensureBillingProfile(ddb, tableBilling, parsed.senderId);
    if (profile.kind === "missing") {
      return "Profil tidak ditemukan.";
    }
    return `Sisa kredit berbayar: ${profile.credits}. Kredit gratis: ${profile.free_credit}.`;
  }

  const topupN = parseTopupAmount(text);
  if (topupN != null) {
    if (!midtransSecretArn || !tableBilling) {
      return "Pembayaran belum dikonfigurasi. Hubungi admin.";
    }
    try {
      const snap = await createSnapWithPendingOrder(ddb, tableBilling, {
        secretArn: midtransSecretArn,
        userId: parsed.senderId,
        credits: topupN,
        provider: "telegram",
        chatId: parsed.chatId,
      });
      return `Silakan lanjut bayar:\n${snap.redirect_url}\n\nOrder: ${snap.orderId}`;
    } catch (e) {
      console.error("topup_snap_error", e);
      return "Gagal membuat link pembayaran. Coba lagi nanti atau hubungi admin.";
    }
  }

  if (/^\s*\/?gambar\b/i.test(text)) {
    const ket = parseKeteranganAfterCommand(text, "gambar");
    if (!hasImage) {
      return MSG_GAMBAR_NO_FILE;
    }
    if (!ket) {
      return MSG_GAMBAR_NO_KETERANGAN;
    }
    const charge = await chargeOneCreditForMedia(
      ddb,
      tableBilling,
      parsed.senderId,
    );
    if (charge.error) return charge.error;
    try {
      const done = await uploadAndPersistRequestResource(
        ctx,
        ket,
        "image",
        charge.source,
      );
      if (done) return done;
    } catch (e) {
      console.error("gambar_persist_failed", e);
      await refundOneMediaCredit(
        ddb,
        tableBilling,
        parsed.senderId,
        charge.source,
      );
      return MSG_MEDIA_BACKEND_FAILED;
    }
    return MSG_PROCESSING;
  }

  if (/^\s*\/?video\b/i.test(text)) {
    const ket = parseKeteranganAfterCommand(text, "video");
    if (!hasImage) {
      return MSG_GAMBAR_NO_FILE;
    }
    if (!ket) {
      return MSG_GAMBAR_NO_KETERANGAN;
    }
    const charge = await chargeOneCreditForMedia(
      ddb,
      tableBilling,
      parsed.senderId,
    );
    if (charge.error) return charge.error;
    try {
      const done = await uploadAndPersistRequestResource(
        ctx,
        ket,
        "video",
        charge.source,
      );
      if (done) return done;
    } catch (e) {
      console.error("video_persist_failed", e);
      await refundOneMediaCredit(
        ddb,
        tableBilling,
        parsed.senderId,
        charge.source,
      );
      return MSG_MEDIA_BACKEND_FAILED;
    }
    return MSG_PROCESSING;
  }

  if (hasImage) {
    return MSG_INVALID;
  }

  if (lower.startsWith("topup")) {
    return `Format: topup <angka> (minimal ${MIN_CREDIT_PURCHASE}).`;
  }

  return `Perintah tidak dikenali. Ketik menu untuk bantuan.`;
}
