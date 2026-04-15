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
import { isProcessImageConfirmPhrase } from "../shared/detectIntentFinal.js";
import {
  clearSenderConversation,
  CONV_STATE_WAITING_TOPUP_AMOUNT,
  CONV_STATE_WAITING_TOPUP_CONFIRMATION,
  patchSenderConversation,
  readConversationState,
} from "../shared/senderConversationMeta.js";
import { SPEC_INTENT } from "../shared/statefulIntentClassifier.js";
import { replyAndRememberState } from "./telegramUtils.js";

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

/** @param {string[]} lines */
function looksLikeTopupCancelFromLines(lines) {
  const last = String(lines[lines.length - 1] ?? "").toLowerCase();
  return /\b(batal|tidak\s*jadi|ga\s*jadi|gajadi|batalin|enggak|engga|cancel|tdk|gak\s*jadi)\b/i.test(
    last,
  );
}

/** @param {string[]} lines */
function looksLikeTopupConfirmFromLines(lines) {
  const last = lines.filter(Boolean);
  const t = String(last[last.length - 1] ?? "").trim();
  if (!t) return false;
  if (t.length <= 56 && isProcessImageConfirmPhrase(t)) return true;
  return /^(ya|y|yes|ok|oke|okee|sip|setuju|gas|lanjut|betul|benar|boleh)\b/i.test(
    t,
  );
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
    tableSenderMeta,
    senderMetaSnapshot,
    specIntent: specIntentRaw,
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

  const meta = senderMetaSnapshot ?? {};
  const persistedState = readConversationState(meta.conversationState);
  const specIntentNorm = String(specIntentRaw ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  const pendingFromMeta =
    meta.pendingTopUpCredits != null && meta.pendingTopUpCredits !== ""
      ? Math.max(0, Math.trunc(Number(meta.pendingTopUpCredits)))
      : null;

  const purchaseLines = userTextLinesForPurchase(timelineItems, 3);
  const linesForCredits =
    purchaseLines.length > 0 ? purchaseLines : classifyLines;
  console.log("linesForCredits: ", linesForCredits);
  const creditsParsed = extractPurchaseCreditsFromUserLines(
    linesForCredits,
    MIN_CREDIT_PURCHASE,
  );
  console.log("creditsParsed: ", creditsParsed);

  const remember =
    canTelegram && chatId && tableSenderMeta
      ? async (text, nextState, pendingCredits) => {
          await replyAndRememberState({
            ddb,
            tableSenderMeta,
            senderId,
            chatId,
            text,
            nextConversationState: nextState,
            pendingTopUpCredits: pendingCredits,
          });
        }
      : async (text, nextState, pendingCredits) => {
          if (canTelegram) await replyTelegram(chatId, text);
          if (ddb && tableSenderMeta) {
            await patchSenderConversation(ddb, tableSenderMeta, senderId, {
              lastSystemMessage: text,
              conversationState: nextState ?? "",
              pendingTopUpCredits: pendingCredits,
            });
          }
        };

  const inTopUpFlow =
    persistedState === CONV_STATE_WAITING_TOPUP_AMOUNT ||
    persistedState === CONV_STATE_WAITING_TOPUP_CONFIRMATION;

  const cancelIntent =
    specIntentNorm === SPEC_INTENT.CANCEL_TOPUP ||
    (inTopUpFlow && looksLikeTopupCancelFromLines(classifyLines));

  if (cancelIntent && inTopUpFlow) {
    await clearSenderConversation(ddb, tableSenderMeta, senderId);
    if (canTelegram) {
      await replyTelegram(
        chatId,
        "Oke kak, pembelian credit-nya kami batalkan. Kalau mau top up lagi, bilang saja ya.",
      );
    }
    return { ok: true, intent, mergedCount: windowItems.length };
  }

  if (cancelIntent && !inTopUpFlow && canTelegram) {
    await replyTelegram(
      chatId,
      "Saat ini tidak ada pembelian credit yang menunggu konfirmasi ya kak.",
    );
    return { ok: true, intent, mergedCount: windowItems.length };
  }

  /** @param {number} c */
  async function createSnapAndReply(c) {
    let replyText;
    let redirectUrl;
    try {
      const snap = await createSnapCreditPurchase({
        secretArn: midtransSecretArn,
        userId: senderId,
        credits: c,
      });
      await ddb.send(
        new PutCommand({
          TableName: tableBilling,
          Item: {
            PK: `USER#${String(senderId)}`,
            SK: `ORDER#${snap.orderId}`,
            userId: String(senderId),
            orderId: snap.orderId,
            credits: c,
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
    await patchSenderConversation(ddb, tableSenderMeta, senderId, {
      conversationState: "",
      lastSystemMessage: replyText,
      pendingTopUpCredits: null,
    });
    if (canTelegram) await replyTelegram(chatId, replyText);
    return { redirectUrl, replyText };
  }

  if (persistedState === CONV_STATE_WAITING_TOPUP_CONFIRMATION) {
    const confirmNow =
      specIntentNorm === SPEC_INTENT.CONFIRM_TOPUP ||
      looksLikeTopupConfirmFromLines(classifyLines);

    if (
      specIntentNorm === SPEC_INTENT.PROVIDE_TOPUP_AMOUNT &&
      creditsParsed != null &&
      creditsParsed >= MIN_CREDIT_PURCHASE
    ) {
      const gross = creditsParsed * CREDIT_UNIT_PRICE_IDR;
      const msg = `Baik kak, kami ubah jadi **${creditsParsed} credit** (± Rp ${gross.toLocaleString("id-ID")}).\n\nKonfirmasi beli? Balas **ya** untuk lanjut atau **tidak** untuk batal.`;
      await remember(msg, CONV_STATE_WAITING_TOPUP_CONFIRMATION, creditsParsed);
      return { ok: true, intent, mergedCount: windowItems.length };
    }

    if (confirmNow) {
      const useCredits =
        pendingFromMeta != null && pendingFromMeta >= MIN_CREDIT_PURCHASE
          ? pendingFromMeta
          : creditsParsed;
      if (useCredits == null || useCredits < MIN_CREDIT_PURCHASE) {
        const msg = `Kak, kami tidak menemukan jumlah credit yang valid. Sebutkan lagi jumlahnya ya (minimal ${MIN_CREDIT_PURCHASE}).`;
        await remember(msg, CONV_STATE_WAITING_TOPUP_AMOUNT, null);
        return { ok: true, intent, mergedCount: windowItems.length };
      }
      const out = await createSnapAndReply(useCredits);
      return {
        ok: true,
        intent,
        mergedCount: windowItems.length,
        redirect_url: out.redirectUrl,
      };
    }

    const remind = `Mohon konfirmasi dulu ya kak: balas **ya** untuk lanjut bayar, atau **tidak** kalau mau batal.`;
    await remember(
      remind,
      CONV_STATE_WAITING_TOPUP_CONFIRMATION,
      pendingFromMeta ?? undefined,
    );
    return { ok: true, intent, mergedCount: windowItems.length };
  }

  if (persistedState === CONV_STATE_WAITING_TOPUP_AMOUNT) {
    if (creditsParsed != null && creditsParsed >= MIN_CREDIT_PURCHASE) {
      const gross = creditsParsed * CREDIT_UNIT_PRICE_IDR;
      const msg = `Konfirmasi beli **${creditsParsed} credit** (± Rp ${gross.toLocaleString("id-ID")})?\n\nBalas **ya** untuk dapatkan link bayar, atau **tidak** untuk batal.`;
      await remember(msg, CONV_STATE_WAITING_TOPUP_CONFIRMATION, creditsParsed);
      return { ok: true, intent, mergedCount: windowItems.length };
    }
    const msg = `Kak, sebutkan jumlah credit yang mau dibeli ya (minimal ${MIN_CREDIT_PURCHASE}). Contoh: 20 atau "beli 20 credit".`;
    await remember(msg, CONV_STATE_WAITING_TOPUP_AMOUNT, undefined);
    return { ok: true, intent, mergedCount: windowItems.length };
  }

  if (creditsParsed == null) {
    const msg = `Kak, sebutkan jumlah credit yang mau dibeli ya (minimal ${MIN_CREDIT_PURCHASE}). Contoh: beli 20 credit`;
    await remember(msg, CONV_STATE_WAITING_TOPUP_AMOUNT, undefined);
    return { ok: true, intent, mergedCount: windowItems.length };
  }

  if (creditsParsed < MIN_CREDIT_PURCHASE) {
    const replyText = `Minimal pembelian ${MIN_CREDIT_PURCHASE} credit ya kak.`;
    if (canTelegram) await replyTelegram(chatId, replyText);
    return {
      ok: true,
      intent,
      mergedCount: windowItems.length,
    };
  }

  const gross = creditsParsed * CREDIT_UNIT_PRICE_IDR;
  const msg = `Konfirmasi beli **${creditsParsed} credit** (± Rp ${gross.toLocaleString("id-ID")})?\n\nBalas **ya** untuk dapatkan link bayar, atau **tidak** untuk batal.`;
  await remember(
    msg,
    CONV_STATE_WAITING_TOPUP_CONFIRMATION,
    creditsParsed,
  );
  return { ok: true, intent, mergedCount: windowItems.length };
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
    tableGenerationRequest,
    tableGenerationConfirmIdempotency,
    tableSenderMeta,
    uploadSlotResetAfterAt,
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
    triggerMessageId,
  } = ctx;

  if (!uploadGambarPath) return null;
  console.log("Masuk handleUploadGambar: ", intent);

  if (intent === INTENT_UPLOAD_GAMBAR && tableBilling) {
    const profile = await ensureBillingProfile(ddb, tableBilling, senderId);
    const paidCredits =
      profile.kind === "ok" ? Math.max(0, Number(profile.credits) || 0) : 0;
    if (paidCredits <= 0) {
      if (canTelegram && chatId) {
        await replyTelegram(
          chatId,
          "Untuk upload dan edit foto, perlu saldo credit berbayar (field credits) lebih dari 0. Silakan top up dulu ya kak.",
        );
      }
      return {
        ok: true,
        intent,
        mergedCount: windowItems.length,
        upload_flow: {
          handled: true,
          credit_gate: "upload_blocked_zero_paid_credits",
        },
      };
    }
  }

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
    triggerMessageId,
    tableGenerationRequest,
    tableGenerationConfirmIdempotency,
    tableSenderMeta,
    uploadSlotResetAfterAt,
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
