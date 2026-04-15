import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getGeminiApiKey } from "../shared/secrets.js";
import { classifyIntent } from "../shared/gemini.js";
import {
  loadRagCredentials,
  ragIntentConfigFromEnv,
  ragKnowledgeConfigFromEnv,
  retrieveProductRagContext,
} from "../shared/ragProduct.js";
import {
  INTENT_CLASSIFIER_GUIDE,
  INTENT_PROCESS_IMAGE_CONFIRMED,
  INTENT_TANYA_INFO,
  INTENT_UNKNOWN,
  INTENT_UPLOAD_GAMBAR,
  LLM_UNAVAILABLE_REPLY_TEXT,
  normalizeIntentForRouting,
} from "../shared/constants.js";
import {
  detectIntentFinalHeuristic,
  pickTriggerWindowItem,
  windowItemToDetectMessage,
} from "../shared/detectIntentFinal.js";
import {
  isActiveUploadDraft,
  queryOpenRequestForUser,
} from "../shared/uploadGambarFlow.js";
import {
  computeUploadAndBannerRoutes,
  handleBeliCredit,
  handleBannerWithImageCreditGate,
  handleTelegramTextReply,
  handleUploadGambar,
  notifyUnknownIntent,
} from "./intentHandlers.js";
import { replyTelegram, notifyUnknownIntentToAdmin } from "./telegramUtils.js";

const WINDOW_SIZE = 7;
const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_DEBOUNCE_MS = 3000;

/** Intent yang boleh diproses saat masih ada draft upload aktif di chat yang sama. */
const INTENTS_ALLOWED_DURING_UPLOAD_DRAFT = new Set([
  INTENT_UPLOAD_GAMBAR,
  INTENT_PROCESS_IMAGE_CONFIRMED,
]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} ddb
 * @param {string} tableMessage
 * @param {string} senderId
 * @param {{ messageId: string, senderId: string }[]} keys
 */
async function markMessagesProcessed(ddb, tableMessage, keys) {
  await Promise.all(
    keys.map((k) =>
      ddb.send(
        new UpdateCommand({
          TableName: tableMessage,
          Key: { messageId: k.messageId, senderId: k.senderId },
          UpdateExpression: "SET #proc = :p",
          ExpressionAttributeNames: { "#proc": "processed" },
          ExpressionAttributeValues: { ":p": true },
        }),
      ),
    ),
  );
}

function linesForClassification(windowItems) {
  return windowItems
    .map((i) => {
      const t = (i.text ?? "").trim();
      if (t && t !== "[gambar]") return t;
      if (i.hasImage || i.imageFileId) return "[user mengirim gambar]";
      return "";
    })
    .filter(Boolean);
}

/**
 * @param {unknown} event
 * @returns {{ ok: true, senderId: string, triggerMessageId: string, debounceMs: number } | { ok: false, error: string }}
 */
export function parseProcessIntentPayload(event) {
  const payload =
    event && typeof event === "object" && "senderId" in event
      ? event
      : typeof event === "string"
        ? JSON.parse(event)
        : {};
  const { senderId, triggerMessageId, debounceMs = DEFAULT_DEBOUNCE_MS } =
    payload;
  if (!senderId || !triggerMessageId) {
    return { ok: false, error: "bad_payload" };
  }
  return {
    ok: true,
    senderId,
    triggerMessageId,
    debounceMs: Number(debounceMs),
  };
}

/**
 * @param {object} p
 * @returns {Promise<{ superseded: true } | { meta: Record<string, unknown> }>}
 */
async function loadSenderMetaOrSuperseded(p) {
  const { ddb, tableSenderMeta, senderId, triggerMessageId } = p;
  const meta = await ddb.send(
    new GetCommand({ TableName: tableSenderMeta, Key: { senderId } }),
  );
  if (!meta.Item || meta.Item.latestMessageId !== triggerMessageId) {
    return { superseded: true };
  }
  return { meta: meta.Item };
}

/**
 * @param {object} p
 * @returns {Promise<{ windowItems: object[], timelineItems: object[], classifyLines: string[], keys: object[], chatId: unknown, provider: unknown }>}
 */
async function loadMessageWindowAndTimeline(p) {
  const {
    ddb,
    tableMessage,
    gsiSenderTime,
    senderId,
    meta,
    historyLimit = DEFAULT_HISTORY_LIMIT,
  } = p;

  const q = await ddb.send(
    new QueryCommand({
      TableName: tableMessage,
      IndexName: gsiSenderTime,
      KeyConditionExpression: "GSI1PK = :s",
      ExpressionAttributeValues: { ":s": senderId },
      ScanIndexForward: false,
      Limit: 40,
    }),
  );

  const items = (q.Items ?? []).filter((i) => i.processed !== true);
  items.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

  const windowItems = items.slice(-WINDOW_SIZE);
  const classifyLines = linesForClassification(windowItems);

  const qHistory = await ddb.send(
    new QueryCommand({
      TableName: tableMessage,
      IndexName: gsiSenderTime,
      KeyConditionExpression: "GSI1PK = :s",
      ExpressionAttributeValues: { ":s": senderId },
      ScanIndexForward: false,
      Limit: historyLimit,
    }),
  );
  const timelineItems = [...(qHistory.Items ?? [])].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );

  const keys = windowItems.map((i) => ({
    messageId: i.messageId,
    senderId: i.senderId,
  }));
  const chatId =
    meta.latestChatId ?? windowItems[windowItems.length - 1]?.chatId;
  const provider =
    meta.latestProvider ?? windowItems[windowItems.length - 1]?.provider;

  return {
    windowItems,
    timelineItems,
    classifyLines,
    keys,
    chatId,
    provider,
  };
}

/**
 * @returns {Promise<{ ragResult: object|null, intentKnowledgeForClassifier: string, classified: object }>}
 */
async function runIntentRagAndClassifier(apiKey, classifyLines) {
  let ragResult = null;
  let intentKnowledgeForClassifier = "";
  try {
    const intentRagCfg = ragIntentConfigFromEnv();
    const intentCreds = await loadRagCredentials(intentRagCfg);
    ragResult = await retrieveProductRagContext(
      classifyLines.join("\n"),
      intentCreds,
      { phase: "intent" },
    );
    intentKnowledgeForClassifier =
      ragResult.vectorIntent &&
      ragResult.vectorIntent !== INTENT_UNKNOWN &&
      ragResult.vectorIntent !== "unknown"
        ? [
            `**Sinyal metadata kutipan (agregasi vektor):** "${ragResult.vectorIntent}". Gunakan jika selaras dengan pesan user; jika tidak, tentukan dari kutipan teks.`,
            ragResult.context,
          ].join("\n\n---\n\n")
        : ragResult.context;
  } catch (ragErr) {
    console.warn("intent_rag_unavailable_fallback_static", ragErr);
    intentKnowledgeForClassifier = [
      "Panduan intent (fallback — RAG tidak tersedia):",
      INTENT_CLASSIFIER_GUIDE,
    ].join("\n\n");
  }

  const classified = await classifyIntent(
    apiKey,
    classifyLines,
    intentKnowledgeForClassifier,
  );

  return { ragResult, intentKnowledgeForClassifier, classified };
}

/**
 * Fallback vektor + konteks RAG balasan (indeks intent vs knowledge).
 */
async function resolveFinalIntentAndProductContext(
  classifyLines,
  ragResult,
  classified,
) {
  let intent = classified.intent;
  const geminiIntent = classified.intent;
  let usedVectorFallback = false;
  if (
    intent === INTENT_UNKNOWN &&
    ragResult?.vectorIntent &&
    ragResult.vectorIntent !== INTENT_UNKNOWN &&
    ragResult.vectorIntent !== "unknown"
  ) {
    intent = ragResult.vectorIntent;
    usedVectorFallback = true;
  }

  let productRagContextForReply = null;
  try {
    if (intent === INTENT_TANYA_INFO) {
      const knCfg = ragKnowledgeConfigFromEnv();
      const knCreds = await loadRagCredentials(knCfg);
      const knResult = await retrieveProductRagContext(
        classifyLines.join("\n"),
        knCreds,
        { phase: "knowledge" },
      );
      productRagContextForReply = knResult.context;
    } else if (ragResult?.context != null) {
      productRagContextForReply = ragResult.context;
    }
  } catch (knErr) {
    console.warn("knowledge_rag_unavailable", knErr);
    productRagContextForReply =
      intent === INTENT_TANYA_INFO ? null : ragResult?.context ?? null;
  }

  return {
    intent,
    geminiIntent,
    usedVectorFallback,
    productRagContextForReply,
  };
}

/**
 * @returns {Promise<object|null>} null bila tidak perlu blok; object response jika blok.
 */
async function maybeReturnForOpenUploadDraft(p) {
  const {
    ddb,
    tableRequestResource,
    gsiRequestUserProcess,
    chatId,
    senderId,
    intent,
    provider,
    keys,
    tableMessage,
    windowItems,
  } = p;

  if (
    !tableRequestResource ||
    chatId == null ||
    !senderId ||
    INTENTS_ALLOWED_DURING_UPLOAD_DRAFT.has(intent)
  ) {
    return null;
  }

  const openDraft = await queryOpenRequestForUser(
    ddb,
    tableRequestResource,
    gsiRequestUserProcess,
    senderId,
  );
  if (
    !openDraft ||
    String(openDraft.chatId ?? "") !== String(chatId) ||
    !isActiveUploadDraft(openDraft)
  ) {
    return null;
  }

  const canTelegramDraftGate =
    provider === "telegram" && Boolean(process.env.TELEGRAM_BOT_TOKEN);
  if (canTelegramDraftGate) {
    await replyTelegram(
      chatId,
      "Kak, masih ada proses upload/edit foto yang belum selesai. Mohon diselesaikan dulu ya (lengkapi foto dan tema/gaya, lalu konfirmasi). Setelah itu baru bisa lanjut pertanyaan lain.",
    );
  }
  await markMessagesProcessed(ddb, tableMessage, keys);
  console.log("upload_draft_blocks_other_intent", {
    intent,
    senderId: String(senderId),
  });
  return {
    ok: true,
    deferred: "upload_draft_pending",
    intent,
    mergedCount: windowItems.length,
  };
}

function logIntentResolution(p) {
  const {
    intent,
    geminiIntent,
    ragResult,
    usedVectorFallback,
    classifyLines,
    productRagContextForReply,
    classified,
    skippedRagForShortcut,
    intentFinalHeuristicSource,
  } = p;
  console.log("intent_rag_resolution", {
    finalIntent: intent,
    geminiIntent,
    vectorIntent: ragResult?.vectorIntent ?? null,
    usedVectorFallback,
    usedKnowledgeRag: intent === INTENT_TANYA_INFO,
    skippedRagForShortcut: Boolean(skippedRagForShortcut),
    intentFinalHeuristicSource: intentFinalHeuristicSource ?? null,
    classifyLinesPreview: classifyLines
      .join(" | ")
      .replace(/\s+/g, " ")
      .slice(0, 400),
    ragContextCharCount: productRagContextForReply?.length ?? 0,
    geminiRawSnippet: String(classified.rawModelText ?? "").slice(0, 500),
  });
}

/**
 * Urutan: beli credit → upload gambar → gate banner → balasan teks / unknown.
 */
async function dispatchByIntent(ctx) {
  const beliOut = await handleBeliCredit(ctx);
  if (beliOut) return beliOut;

  const uploadOut = await handleUploadGambar(ctx);
  if (uploadOut) return uploadOut;

  const bannerGateOut = await handleBannerWithImageCreditGate(ctx);
  if (bannerGateOut) return bannerGateOut;

  await handleTelegramTextReply(ctx);
  await notifyUnknownIntent(ctx);

  return { ok: true, intent: ctx.intent, mergedCount: ctx.windowItems.length };
}

/**
 * @param {object} deps
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} deps.ddb
 * @param {string} deps.tableMessage
 * @param {string} deps.tableSenderMeta
 * @param {string} deps.tableBillingUsageCredit
 * @param {string} [deps.tableRequestResource]
 * @param {string} [deps.midtransSecretArn]
 * @param {string} deps.geminiSecretArn
 * @param {string} deps.geminiSecretKey
 * @param {string} deps.gsiSenderTime
 * @param {string} deps.gsiRequestUserProcess
 * @param {unknown} event
 */
export async function runIntentProcessingPipeline(deps, event) {
  const {
    ddb,
    tableMessage,
    tableSenderMeta,
    tableBillingUsageCredit,
    tableRequestResource,
    tableGenerationRequest,
    tableGenerationConfirmIdempotency,
    midtransSecretArn,
    geminiSecretArn,
    geminiSecretKey,
    gsiSenderTime,
    gsiRequestUserProcess,
  } = deps;

  const parsed = parseProcessIntentPayload(event);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const { senderId, triggerMessageId, debounceMs } = parsed;
  await sleep(debounceMs);

  const metaResult = await loadSenderMetaOrSuperseded({
    ddb,
    tableSenderMeta,
    senderId,
    triggerMessageId,
  });
  if ("superseded" in metaResult) {
    return { ok: true, skipped: "superseded" };
  }

  const { meta } = metaResult;
  const msgCtx = await loadMessageWindowAndTimeline({
    ddb,
    tableMessage,
    gsiSenderTime,
    senderId,
    meta,
  });

  const { windowItems, timelineItems, classifyLines, keys, chatId, provider } =
    msgCtx;

  if (classifyLines.length === 0) {
    return { ok: true, skipped: "no_text" };
  }

  let intent;
  let productRagContextForReply = null;

  try {
    const apiKey = await getGeminiApiKey(geminiSecretArn, geminiSecretKey);

    let openDraft = null;
    if (tableRequestResource && chatId != null && senderId) {
      openDraft = await queryOpenRequestForUser(
        ddb,
        tableRequestResource,
        gsiRequestUserProcess,
        senderId,
      );
    }
    const session =
      openDraft &&
      String(openDraft.chatId ?? "") === String(chatId) &&
      isActiveUploadDraft(openDraft)
        ? { state: "waiting_instruction" }
        : {};

    const triggerItem = pickTriggerWindowItem(windowItems, triggerMessageId);
    const message = windowItemToDetectMessage(triggerItem);
    const heuristicResult = detectIntentFinalHeuristic(message, session);

    let ragResult = null;
    /** @type {{ intent?: string, rawModelText?: string, source?: string, heuristicSource?: string }} */
    let classified = { rawModelText: "" };
    let geminiIntent;
    let usedVectorFallback = false;
    let skippedRagForShortcut = false;
    /** @type {string|undefined} */
    let intentFinalHeuristicSource;

    if (heuristicResult) {
      skippedRagForShortcut = true;
      intentFinalHeuristicSource = heuristicResult.source;
      intent = normalizeIntentForRouting(heuristicResult.intent);
      geminiIntent = intent;
      classified = {
        intent,
        rawModelText: "",
        source: "intent_final_heuristic",
        heuristicSource: heuristicResult.source,
      };
      productRagContextForReply = null;

      if (intent === INTENT_TANYA_INFO) {
        try {
          const knCfg = ragKnowledgeConfigFromEnv();
          const knCreds = await loadRagCredentials(knCfg);
          const knResult = await retrieveProductRagContext(
            classifyLines.join("\n"),
            knCreds,
            { phase: "knowledge" },
          );
          productRagContextForReply = knResult.context;
        } catch (knErr) {
          console.warn("knowledge_rag_heuristic_tanya_info", knErr);
          productRagContextForReply = null;
        }
      }
    } else {
      const ragOut = await runIntentRagAndClassifier(apiKey, classifyLines);
      ragResult = ragOut.ragResult;
      classified = ragOut.classified;

      const resolved = await resolveFinalIntentAndProductContext(
        classifyLines,
        ragResult,
        classified,
      );

      intent = resolved.intent;
      geminiIntent = resolved.geminiIntent;
      usedVectorFallback = resolved.usedVectorFallback;
      productRagContextForReply = resolved.productRagContextForReply;
    }

    const draftBlock = await maybeReturnForOpenUploadDraft({
      ddb,
      tableRequestResource,
      gsiRequestUserProcess,
      chatId,
      senderId,
      intent,
      provider,
      keys,
      tableMessage,
      windowItems,
    });
    if (draftBlock) return draftBlock;

    await markMessagesProcessed(ddb, tableMessage, keys);

    logIntentResolution({
      intent,
      geminiIntent,
      ragResult,
      usedVectorFallback,
      classifyLines,
      productRagContextForReply,
      classified,
      skippedRagForShortcut,
      intentFinalHeuristicSource,
    });

    const canTelegram =
      provider === "telegram" && Boolean(process.env.TELEGRAM_BOT_TOKEN);

    const routes = await computeUploadAndBannerRoutes({
      ddb,
      intent,
      windowItems,
      chatId,
      senderId,
      tableRequestResource,
      tableBilling: tableBillingUsageCredit,
    });

    const ctx = {
      ddb,
      apiKey,
      intent,
      classifyLines,
      timelineItems,
      windowItems,
      chatId,
      provider,
      senderId,
      triggerMessageId,
      canTelegram,
      replyTelegram,
      productRagContextForReply,
      midtransSecretArn,
      tableBilling: tableBillingUsageCredit,
      tableRequestResource,
      tableGenerationRequest,
      tableGenerationConfirmIdempotency,
      gsiRequestUserProcess,
      uploadGambarPath: routes.uploadGambarPath,
      bannerIntentWithImage: routes.bannerIntentWithImage,
      notifyUnknown: notifyUnknownIntentToAdmin,
    };

    return await dispatchByIntent(ctx);
  } catch (err) {
    console.error("process_intent_llm_error", err);
    if (provider === "telegram" && process.env.TELEGRAM_BOT_TOKEN && chatId) {
      await replyTelegram(chatId, LLM_UNAVAILABLE_REPLY_TEXT);
    }
    return {
      ok: false,
      error: "llm_unavailable",
      intent: intent ?? "unknown",
      mergedCount: windowItems.length,
    };
  }
}
