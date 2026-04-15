import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { generateResponse } from "../shared/gemini.js";
import {
  KNOWLEDGE_FALLBACK_GUIDE,
  knowledgeMarkdownForIntent,
} from "../shared/knowledgeMarkdown.js";
import {
   loadRagCredentials,
  ragKnowledgeConfigFromEnv,
  retrieveProductRagContext,
} from "../shared/ragProduct.js";
import { ensureBillingProfile } from "../shared/creditProfile.js";
import {
  getRequestResource,
  runUploadGambarFlow,
} from "../shared/uploadGambarFlow.js";
import {
  CREDIT_UNIT_PRICE_IDR,
  INTENT_BELI_CREDIT,
  INTENT_BUATKAN_BANNER,
  INTENT_PROCESS_IMAGE_CONFIRMED,
  INTENT_SALAM,
  INTENT_TANYA_INFO,
  INTENT_UNKNOWN,
  INTENT_UPLOAD_GAMBAR,
  MIN_CREDIT_PURCHASE,
  PRODUCT_RAG_INTENTS,
} from "../shared/constants.js";
import {
  createSnapCreditPurchase,
  extractPurchaseCreditsFromUserLines,
} from "../shared/creditPurchase.js";
import { analyzeBannerMaterials, resolveBannerReply } from "../shared/bannerFlow.js";

/** @param {object[]} windowItems */
export function windowHasImageAttachment(windowItems) {
  return windowItems.some((i) => Boolean(i.hasImage || i.imageFileId));
}

export function userTextLinesForPurchase(timelineItems, limit = 24) {
  return timelineItems
    .slice(-limit)
    .map((i) => (i.text ?? "").trim())
    .filter((t) => t && t !== "[gambar]");
}

/**
 * @param {object} p
 * @returns {Promise<{ hasImageNow: boolean, bannerIntentWithImage: boolean, uploadGambarPath: boolean }>}
 */
export async function computeUploadAndBannerRoutes(p) {
  const {
    ddb,
    intent,
    windowItems,
    chatId,
    senderId,
    tableRequestResource,
    tableBilling,
  } = p;

  const hasImageNow = windowHasImageAttachment(windowItems);
  const bannerIntentWithImage = intent === INTENT_BUATKAN_BANNER && hasImageNow;

  const localRequestRow =
    tableRequestResource && chatId != null
      ? await getRequestResource(
          ddb,
          tableRequestResource,
          String(chatId),
          String(senderId),
        )
      : null;

  const inOpenImageDraft = Boolean(
    localRequestRow &&
      localRequestRow.isProcess !== true &&
      (localRequestRow.resourceIsProcessKey === "false" ||
        localRequestRow.resourceIsProcessKey == null),
  );

  /** Jangan lanjutkan draft upload untuk intent murni teks / FAQ (termasuk saat draft masih terbuka). */
  const blockDraftImageFlow =
    intent === INTENT_SALAM ||
    intent === "cek kredit" ||
    intent === INTENT_TANYA_INFO ||
    (!inOpenImageDraft && PRODUCT_RAG_INTENTS.has(intent));

  const uploadGambarPath =
    intent !== INTENT_BUATKAN_BANNER &&
    Boolean(tableRequestResource && tableBilling) &&
    (intent === INTENT_UPLOAD_GAMBAR ||
      intent === INTENT_PROCESS_IMAGE_CONFIRMED ||
      (inOpenImageDraft && !blockDraftImageFlow));

  return {
    hasImageNow,
    bannerIntentWithImage,
    uploadGambarPath,
  };
}

/**
 * @param {object} ctx
 * @returns {Promise<object|null>} response object untuk langsung return dari handler, atau null
 */
export async function handleBeliCredit(ctx) {
  const {
    intent,
    ddb,
    chatId,
    canTelegram,
    senderId,
    provider,
    classifyLines,
    timelineItems,
    windowItems,
    replyTelegram,
    midtransSecretArn,
    tableBilling,
  } = ctx;

  if (intent !== INTENT_BELI_CREDIT) return null;
  console.log("Masuk handleBeliCredit: ", intent);
  if (!midtransSecretArn || !tableBilling) {
    console.error("billing_env_missing", {
      hasMidtransArn: Boolean(midtransSecretArn),
      hasBillingTable: Boolean(tableBilling),
    });
    if (canTelegram) {
      const admin = process.env.ADMIN_EMAIL
        ? ` (${process.env.ADMIN_EMAIL})`
        : "";
      await replyTelegram(
        chatId,
        `Maaf kak, sistem pembayaran belum siap. Hubungi admin ya${admin}.`,
      );
    }
    return {
      ok: false,
      error: "billing_not_configured",
      intent,
      mergedCount: windowItems.length,
    };
  }

  const purchaseLines = userTextLinesForPurchase(timelineItems, 24);
  const linesForCredits =
    purchaseLines.length > 0 ? purchaseLines : classifyLines;
  const credits = extractPurchaseCreditsFromUserLines(
    linesForCredits,
    MIN_CREDIT_PURCHASE,
  );

  let replyText;
  let redirectUrl;
  if (credits == null) {
    replyText = `Kak, sebutkan jumlah credit yang mau dibeli ya (minimal ${MIN_CREDIT_PURCHASE}). Contoh: beli 20 credit`;
  } else if (credits < MIN_CREDIT_PURCHASE) {
    replyText = `Minimal pembelian ${MIN_CREDIT_PURCHASE} credit ya kak.`;
  } else {
    try {
      const snap = await createSnapCreditPurchase({
        secretArn: midtransSecretArn,
        userId: senderId,
        credits,
      });
      await ddb.send(
        new PutCommand({
          TableName: tableBilling,
          Item: {
            PK: `USER#${String(senderId)}`,
            SK: `ORDER#${snap.orderId}`,
            userId: String(senderId),
            orderId: snap.orderId,
            credits,
            grossAmount: snap.grossAmount,
            unitPriceIdr: CREDIT_UNIT_PRICE_IDR,
            provider: provider ?? null,
            chatId: chatId != null ? String(chatId) : null,
            createdAt: Date.now(),
            status: "PENDING_SNAP",
            entityType: "ORDER",
          },
        }),
      );
      redirectUrl = snap.redirect_url;
      replyText = `Silakan lanjut bayar lewat link ini:\n${snap.redirect_url}\n\nOrder: ${snap.orderId}`;
    } catch (e) {
      console.error("midtrans_snap_error", e);
      replyText =
        "Maaf kak, link pembayaran gagal dibuat. Coba lagi sebentar lagi atau hubungi admin ya.";
    }
  }

  if (canTelegram) await replyTelegram(chatId, replyText);
  return {
    ok: true,
    intent,
    mergedCount: windowItems.length,
    redirect_url: redirectUrl,
  };
}

/**
 * @param {object} ctx
 * @returns {Promise<object|null>}
 */
export async function handleUploadGambar(ctx) {
  const {
    uploadGambarPath,
    ddb,
    tableRequestResource,
    tableBilling,
    senderId,
    chatId,
    provider,
    canTelegram,
    windowItems,
    timelineItems,
    replyTelegram,
    apiKey,
    intent,
    gsiRequestUserProcess,
  } = ctx;

  if (!uploadGambarPath) return null;
  console.log("Masuk handleUploadGambar: ", intent);
  const uploadOut = await runUploadGambarFlow({
    ddb,
    tableRequestResource,
    tableBilling,
    senderId,
    chatId,
    provider,
    canTelegram,
    windowItems,
    timelineItems,
    replyTelegram,
    apiKey,
    classifiedIntent: intent,
    gsiUserProcess: gsiRequestUserProcess,
  });

  if (!uploadOut.handled) return null;

  return {
    ok: true,
    intent,
    mergedCount: windowItems.length,
    upload_flow: uploadOut,
  };
}

/**
 * @param {object} ctx
 * @returns {Promise<object|null>}
 */
export async function handleBannerWithImageCreditGate(ctx) {
  const {
    bannerIntentWithImage,
    ddb,
    tableBilling,
    senderId,
    chatId,
    canTelegram,
    replyTelegram,
    intent,
    windowItems,
  } = ctx;
  
  if (!bannerIntentWithImage) return null;
  console.log("Masuk handleBannerWithImageCreditGate: ", intent);
  if (!tableBilling) {
    console.error("billing_table_missing_for_banner_gate");
    if (canTelegram) {
      await replyTelegram(
        chatId,
        "Maaf kak, pengecekan saldo sementara tidak tersedia. Coba lagi nanti atau hubungi admin ya.",
      );
    }
    return {
      ok: false,
      error: "billing_not_configured",
      intent,
      mergedCount: windowItems.length,
    };
  }

  const topupHint = `Untuk isi saldo, balas di chat misalnya "beli ${MIN_CREDIT_PURCHASE} credit" atau jumlah lain (minimal ${MIN_CREDIT_PURCHASE} credit per transaksi).`;

  const profileState = await ensureBillingProfile(
    ddb,
    tableBilling,
    senderId,
  );
  if (profileState.kind !== "ok" || profileState.credits <= 0) {
    const replyText = `Hai kak, untuk pembuatan banner dengan gambar perlu saldo credit berbayar (saat ini ${profileState.kind === "ok" ? profileState.credits : 0} credit). ${topupHint}`;
    if (canTelegram) await replyTelegram(chatId, replyText);
    return {
      ok: true,
      intent,
      mergedCount: windowItems.length,
      credit_gate: "blocked_banner_needs_paid_credits",
      credits: profileState.kind === "ok" ? profileState.credits : 0,
    };
  }

  return null;
}

/**
 * RAG intro + user block → generateResponse (reuse untuk semua intent RAG produk).
 */
function buildProductRagPrompt(intent, ragContext, classifyLines) {
  const userBlock = `Pertanyaan / pesan pelanggan:
"""
${classifyLines.join("\n")}
"""

Jawab: santai, singkat, sedikit menjual. Bahasa Indonesia. Di akhir, wajib ajak user cobain / lanjut pakai DapurArtisan (CTA natural). Jangan sebut "intent" atau istilah teknis.`;

  if (intent === INTENT_UNKNOWN) {
    return `Utamakan kutipan basis pengetahuan berikut (RAG). Jika tidak cukup menjawab, jangan mengarang fakta produk, harga, atau fitur. Ikuti panduan fallback:

${KNOWLEDGE_FALLBACK_GUIDE}

---

Kutipan basis pengetahuan:
${ragContext}

---

${userBlock}`;
  }

  return `Gunakan HANYA fakta yang tersirat dari kutipan basis pengetahuan berikut (RAG). Jangan mengarang di luar kutipan.

Kutipan basis pengetahuan:
${ragContext}

---

${userBlock}`;
}

async function resolveProductRagContext(ctx) {
  const { productRagContextForReply, intent, classifyLines } = ctx;
  if (productRagContextForReply != null) {
    return productRagContextForReply;
  }
  try {
    const ragCfg = ragKnowledgeConfigFromEnv();
    const creds = await loadRagCredentials(ragCfg);
    const rag = await retrieveProductRagContext(classifyLines.join("\n"), creds);
    return rag.context;
  } catch (ragErr) {
    console.warn("rag_product_fallback_markdown", ragErr);
    return knowledgeMarkdownForIntent(intent);
  }
}

/** Salam + perkenalan DapurArtisan */
async function replySalam(ctx) {
  const { apiKey, classifyLines } = ctx;
  return generateResponse(
    apiKey,
    `Ini pesan sapaan / salam dari pengguna:
"""
${classifyLines.join("\n")}
"""

Balas dengan sopan & natural (boleh mirror salam mereka, mis. waalaikumsalam kalau cocok). Singkat dan hangat.

Lalu dalam 1–2 kalimat: perkenalkan DapurArtisan sebagai bantu konten makanan (foto jadi siap posting: tema, banner, caption, hashtag). Ajak mereka langsung cobain — mis. upload foto makanan & pilih tema. Gaya santai, sedikit jualan, tutup dengan CTA jelas.`,
  );
}

/** Intent di PRODUCT_RAG_INTENTS (cek kredit, tanya_*, unknown, …) */
async function replyProductRagIntent(ctx) {
  const { apiKey, intent, classifyLines } = ctx;
  const ragContext = await resolveProductRagContext(ctx);
  const ragIntro = buildProductRagPrompt(intent, ragContext, classifyLines);
  return generateResponse(apiKey, ragIntro);
}

/** Banner: alur deterministik atau LLM */
async function replyBuatkanBanner(ctx) {
  const { apiKey, intent, classifyLines, timelineItems } = ctx;
  const recentForReady = timelineItems
    .slice(-8)
    .map((i) => (i.text ?? "").trim())
    .filter(Boolean);
  const readyTexts =
    recentForReady.length > 0 ? recentForReady : classifyLines;

  const materials = analyzeBannerMaterials(timelineItems);
  const deterministic = resolveBannerReply(intent, readyTexts, materials);
  if (deterministic) return deterministic;

  return generateResponse(
    apiKey,
    `Pesan terbaru pelanggan:
"""
${classifyLines.join("\n")}
"""

Mereka minta banner; gambar & teks promosi sudah ada dan mereka siap diproses. Balas singkat sebagai admin: konfirmasi lanjut (tanpa janji SLA spesifik jika tidak pasti).`,
  );
}

/** Sisanya: balasan generik berdasarkan label intent */
async function replyGenericIntent(ctx) {
  const { apiKey, intent, classifyLines } = ctx;
  return generateResponse(
    apiKey,
    `Pesan pelanggan (bisa beberapa bubble digabung):
"""
${classifyLines.join("\n")}
"""

Konteks kebutuhan (internal): "${intent}"

Balas santai & singkat, agak jualan. Tutup dengan ajakan cobain DapurArtisan. Jangan sebut "intent" atau istilah teknis.`,
  );
}

/**
 * Telegram: satu pintu keluar untuk semua intent yang membalas teks.
 * @param {object} ctx
 */
export async function handleTelegramTextReply(ctx) {
  const { provider, intent, chatId, replyTelegram } = ctx;

  if (provider !== "telegram" || !process.env.TELEGRAM_BOT_TOKEN) {
    return;
  }

  let replyText;
  if (intent === INTENT_SALAM) {
    console.log("Masuk handleTelegramTextReply: ", intent);
    replyText = await replySalam(ctx);
  } else if (PRODUCT_RAG_INTENTS.has(intent)) {
    console.log("Masuk handleTelegramTextReply: ", intent);
    replyText = await replyProductRagIntent(ctx);
  } else if (intent === INTENT_BUATKAN_BANNER) {
    console.log("Masuk handleTelegramTextReply: ", intent);
    replyText = await replyBuatkanBanner(ctx);
  } else {
    console.log("Masuk handleTelegramTextReply: ", intent);
    replyText = await replyGenericIntent(ctx);
  }

  await replyTelegram(chatId, replyText);
}

/**
 * @param {object} ctx
 */
export async function notifyUnknownIntent(ctx) {
  
  const { intent, classifyLines, senderId, chatId, provider, notifyUnknown } =
    ctx;
  if (intent !== INTENT_UNKNOWN || !process.env.TELEGRAM_BOT_TOKEN) return;
  console.log("Masuk notifyUnknownIntent: ", intent);
  await notifyUnknown({
    userLines: classifyLines,
    senderId,
    userChatId: chatId,
    provider,
  });
}
