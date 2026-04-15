import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  FREE_CREDIT_INITIAL,
  INTENT_PROCESS_IMAGE_CONFIRMED,
  INTENT_UPLOAD_GAMBAR,
  UPLOAD_S3_BUCKET_DEFAULT,
  UPLOAD_THEME_OPTIONS,
} from "./constants.js";
import { ensureBillingProfile } from "./creditProfile.js";
import {
  buildGenerationConfirmIdempotencyKey,
  getGenerationConfirmIdempotency,
  transactSubmitGenerationRequest,
} from "./generationRequestSubmit.js";
import { extractUploadGambarSlots } from "./gemini.js";
import { userSaysReadyToProcess } from "./bannerFlow.js";

const s3 = new S3Client({});

const PLACEHOLDER = "[gambar]";
const GSI_FALSE = "false";
const GSI_TRUE = "true";

/** @param {string|undefined} text */
function meaningfulUserText(text) {
  const t = String(text ?? "").trim();
  if (!t || t === PLACEHOLDER) return "";
  return t;
}

/**
 * @param {string} line
 * @returns {string|null} theme id or null
 */
export function matchThemeFromText(line) {
  const low = line.toLowerCase().trim();
  if (!low) return null;
  for (const opt of UPLOAD_THEME_OPTIONS) {
    if (low === opt.id.toLowerCase()) return opt.id;
    if (low.includes(opt.label.toLowerCase())) return opt.id;
    if (opt.keywords?.some((k) => low.includes(k.toLowerCase()))) return opt.id;
  }
  return null;
}

/**
 * @param {string} raw
 */
export function parseUploadTextFields(raw) {
  const t = String(raw ?? "").replace(/\[gambar\]/gi, "").trim();
  if (!t) return { theme: null, caption: null };

  let theme = null;
  let caption = null;
  let rest = t;

  const themeEq = t.match(/tema\s*[:=]\s*(.+?)(?=\n|$|caption\s*[:=])/is);
  if (themeEq) {
    const candidate = themeEq[1].trim().split("\n")[0].trim();
    theme = matchThemeFromText(candidate) ?? candidate;
    rest = rest.replace(themeEq[0], "\n").trim();
  }

  const capEq = rest.match(/caption\s*[:=]\s*(.+)/is);
  if (capEq) {
    caption = capEq[1].trim();
    rest = rest.replace(capEq[0], "").trim();
  }

  if (!theme && rest.length > 0) {
    const lines = rest.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines[0]) {
      const m = matchThemeFromText(lines[0]);
      if (m) {
        theme = m;
        caption = lines.slice(1).join("\n").trim() || caption;
      } else {
        theme = lines[0];
        caption = lines.slice(1).join("\n").trim() || caption;
      }
    }
  }

  return {
    theme: theme ? String(theme).trim() : null,
    caption: caption ? String(caption).trim() : null,
  };
}

export function formatThemePrompt() {
  const lines = UPLOAD_THEME_OPTIONS.map(
    (o, i) => `${i + 1}. ${o.label} (ketik: ${o.id})`,
  );
  return `Pilih tema/gaya untuk fotonya ya kak:\n${lines.join("\n")}\n\nBisa balas nomor, nama tema, atau id di dalam kurung.`;
}

/** Label baca manusia untuk id tema (kalau ada di katalog). */
function themeLabelForDisplay(themeRaw) {
  const raw = String(themeRaw ?? "").trim();
  if (!raw) return "(belum ada)";
  const opt = UPLOAD_THEME_OPTIONS.find(
    (o) => o.id.toLowerCase() === raw.toLowerCase(),
  );
  return opt ? `${opt.label} (${opt.id})` : raw;
}

/** Pesan konfirmasi: pastikan user setuju tema/gaya sebelum lanjut (setara intent process_image_confirmed). */
function buildThemeStyleConfirmTelegramMessage(resource) {
  const themeLine = themeLabelForDisplay(resource.theme);
  const bt = resource.bannerText || "(tidak ada — opsional)";
  const n = resource.pendingImageEntries?.length ?? 0;
  return `Sudah lengkap. Tolong konfirmasi dulu ya kak:

— Foto: ${n} gambar
— Tema / gaya: ${themeLine}
— Teks banner/promo: ${bt}

Benarkan tema dan gaya di atas? Kalau sudah pas, balas "ya" /"setuju" / "benar" agar kami lanjut proses. Kalau mau ubah, kirim tema atau teks baru dulu.`;
}

/**
 * @param {boolean} hasPendingImages
 * @param {boolean} hasTheme
 * @param {Record<string, unknown>} resource
 * @returns {{ text: string, appendThemePrompt: boolean }}
 */
export function buildMissingUploadSlotsReply(
  hasPendingImages,
  hasTheme,
  resource,
) {
  const themeVal = resource.theme ? String(resource.theme).trim() : "";
  const hasBanner = Boolean(
    String(resource.bannerText ?? resource.caption ?? "").trim(),
  );
  const received = [];
  if (hasPendingImages) received.push("Gambar");
  if (hasTheme) {
    received.push(
      themeVal ? `tema/gaya (${themeVal})` : "tema/gaya",
    );
  }
  if (hasBanner) received.push("teks banner/promo");

  const needImage = !hasPendingImages;
  const needTheme = !hasTheme;

  if (needImage && needTheme) {
    return {
      text: "Kak silahkan diupload gambar dan dipilih tema/gaya nya ya — ditunggu fotonya dan pilihannya ya.",
      appendThemePrompt: true,
    };
  }
  if (needTheme && hasPendingImages) {
    const head =
      received.length > 0
        ? `${received.join(" dan ")} sudah kami terima, ditunggu tema/gayanya ya kak.`
        : "Gambar sudah kami terima, ditunggu tema/gayanya ya kak.";
    return { text: head, appendThemePrompt: true };
  }
  if (needImage && hasTheme) {
    const head =
      received.length > 0
        ? `${received.join(" dan ")} sudah kami terima, ditunggu fotonya ya kak.`
        : "Tema/gayanya sudah kami terima, ditunggu fotonya ya kak.";
    return { text: head, appendThemePrompt: false };
  }
  return {
    text: "Kak, masih ada yang kurang untuk lanjut — cek foto, tema, atau teks banner ya.",
    appendThemePrompt: !hasTheme,
  };
}

function normalizeThemeFromSlot(raw) {
  if (raw == null || !String(raw).trim()) return null;
  const s = String(raw).trim();
  return matchThemeFromText(s) ?? s;
}

/**
 * @param {Record<string, unknown>} resource
 */
export function resolveJobKindFromResource(resource) {
  const hasPending =
    Array.isArray(resource.pendingImageEntries) &&
    resource.pendingImageEntries.length > 0;
  const hasS3 =
    Array.isArray(resource.s3Keys) && resource.s3Keys.length > 0;
  const hasImg = hasPending || hasS3;
  const hasTheme = resource.theme && String(resource.theme).trim().length > 0;
  const b =
    resource.bannerText ?? resource.caption ?? "";
  const hasBanner = String(b).trim().length > 0;
  if (hasImg && hasTheme && hasBanner) return "banner";
  if (hasImg && hasTheme) return "edit_image";
  return "generic_upload";
}

/**
 * @deprecated Gunakan resolveJobKindFromResource setelah merge resource.
 */
export async function resolveImageJobKindForBilling(p) {
  const { ddb, tableRequestResource, chatId, senderId, windowItems } = p;
  const last = windowItems[windowItems.length - 1];
  const lastHasImage = Boolean(last?.imageFileId || last?.hasImage);
  const lastRaw = String(last?.text ?? "");
  const parsed = parseUploadTextFields(lastRaw);

  let resource = null;
  if (ddb && tableRequestResource && chatId != null && senderId != null) {
    resource = await getRequestResource(
      ddb,
      tableRequestResource,
      String(chatId),
      String(senderId),
    );
  }

  const hasStoredImage =
    Array.isArray(resource?.pendingImageEntries) &&
    resource.pendingImageEntries.length > 0;
  const hasS3 =
    Array.isArray(resource?.s3Keys) && resource.s3Keys.length > 0;
  const storedTheme =
    resource?.theme && String(resource.theme).trim().length > 0;

  if (lastHasImage && parsed.theme && parsed.caption) {
    return "banner";
  }
  if (lastHasImage && parsed.theme && !parsed.caption) {
    return "edit_image";
  }

  if (!lastHasImage && (hasStoredImage || hasS3) && storedTheme) {
    if (parsed.caption) return "banner";

    const lines = lastRaw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length >= 2) {
      const firstIsTheme = Boolean(matchThemeFromText(lines[0]));
      if (firstIsTheme) {
        const rest = lines.slice(1).join("\n").trim();
        if (rest.length > 0) return "banner";
      }
    }

    const single = lines.length === 1 ? lines[0] : "";
    if (
      single &&
      !matchThemeFromText(single) &&
      single.length >= 12 &&
      !/^caption\s*:/i.test(lastRaw)
    ) {
      return "banner";
    }

    if (matchThemeFromText(meaningfulUserText(lastRaw)) || parsed.theme) {
      return "edit_image";
    }
    return "generic_upload";
  }

  if (lastHasImage && !parsed.theme && !parsed.caption) {
    return "generic_upload";
  }

  return "generic_upload";
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} ddb
 * @param {string} tableName
 * @param {string} gsiName
 * @param {string} userId
 */
export async function queryOpenRequestForUser(ddb, tableName, gsiName, userId) {
  if (!tableName || !gsiName || userId == null) return null;
  const out = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: gsiName,
      KeyConditionExpression:
        "resourceUserId = :u AND resourceIsProcessKey = :k",
      ExpressionAttributeValues: {
        ":u": String(userId),
        ":k": GSI_FALSE,
      },
      Limit: 10,
    }),
  );
  const items = out.Items ?? [];
  if (items.length > 1) {
    console.warn("request_resource_multiple_open", {
      userId: String(userId),
      count: items.length,
    });
  }
  return items[0] ?? null;
}

/**
 * Draft upload yang masih perlu diselesaikan (bukan baris kosong default).
 * Dipakai untuk mengalihkan intent lain sampai alur upload selesai.
 * @param {Record<string, unknown>|null|undefined} resource
 */
export function isActiveUploadDraft(resource) {
  if (!resource || resource.isProcess === true) return false;
  if (isStalePostJobResourceRow(resource)) return false;

  const pendingLen = Array.isArray(resource.pendingImageEntries)
    ? resource.pendingImageEntries.length
    : 0;
  if (pendingLen > 0) return true;

  const snapshotShown =
    resource.confirmSnapshotShown != null &&
    String(resource.confirmSnapshotShown).trim().length > 0;
  const awaiting =
    awaitingUserConfirmIsTrue(resource) ||
    (!awaitingUserConfirmIsExplicitlyFalse(resource) && snapshotShown);

  const hasImg = Array.isArray(resource.s3Keys) && resource.s3Keys.length > 0;

  /** Tema/banner saja tanpa pending gambar & tanpa tunggu konfirmasi bukan alasan blok (sisa job / extract LLM). */
  return hasImg || awaiting;
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} ddb
 * @param {string} tableName
 * @param {string} chatId
 * @param {string} userId
 */
export async function getRequestResource(ddb, tableName, chatId, userId) {
  if (!tableName || chatId == null || userId == null) return null;
  const out = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { chatId: String(chatId), userId: String(userId) },
    }),
  );
  return out.Item ?? null;
}

function applyGsiKeys(resource) {
  const uid = String(resource.userId ?? "");
  resource.resourceUserId = uid;
  resource.resourceIsProcessKey = resource.isProcess === true ? GSI_TRUE : GSI_FALSE;
}

async function downloadTelegramFile(token, fileId) {
  const metaUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const metaRes = await fetch(metaUrl);
  const metaJson = await metaRes.json();
  if (!metaJson.ok || !metaJson.result?.file_path) {
    throw new Error(`telegram_getFile_failed: ${JSON.stringify(metaJson)}`);
  }
  const path = metaJson.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${token}/${path}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) {
    throw new Error(`telegram_download_failed: ${fileRes.status}`);
  }
  const buf = Buffer.from(await fileRes.arrayBuffer());
  const extRaw = path.includes(".") ? path.split(".").pop() : "jpg";
  const ext =
    extRaw && /^[a-z0-9]+$/i.test(extRaw) ? extRaw.toLowerCase() : "jpg";
  const contentType =
    ext === "png"
      ? "image/png"
      : ext === "webp"
        ? "image/webp"
        : "image/jpeg";
  return { buf, contentType, ext };
}

function buildSnapshot(resource) {
  const ids = (resource.pendingImageEntries ?? [])
    .map((e) => String(e.messageId))
    .sort();
  return JSON.stringify({
    m: ids,
    t: resource.theme ?? "",
    b: String(resource.bannerText ?? resource.caption ?? "").trim(),
  });
}

/** Bool dari Dynamo; CSV/import kadang jadi string. */
function awaitingUserConfirmIsTrue(row) {
  const v = row?.awaitingUserConfirm;
  if (v === true) return true;
  if (typeof v === "string" && ["true", "1"].includes(v.toLowerCase().trim())) {
    return true;
  }
  return false;
}

function awaitingUserConfirmIsExplicitlyFalse(row) {
  const v = row?.awaitingUserConfirm;
  if (v === false) return true;
  if (typeof v === "string" && ["false", "0"].includes(v.toLowerCase().trim())) {
    return true;
  }
  return false;
}

/** Job sudah dikonfirmasi & diproses (bukan draft terbuka). */
function rowIsProcessCompleted(row) {
  if (!row) return false;
  if (row.isProcess === true) return true;
  if (row.resourceIsProcessKey === GSI_TRUE) return true;
  const v = String(row.isProcess ?? "").toLowerCase();
  return v === "true" || v === "1";
}

/**
 * Baris sisa setelah job diproses: isProcess sudah false tapi field draft/upload masih menempel
 * (worker / TTL tidak mereset). Bukan draft aktif — user boleh intent lain & tidak diblok gate.
 */
function isStalePostJobResourceRow(row) {
  if (!row || row.isProcess === true) return false;
  if (awaitingUserConfirmIsTrue(row)) return false;
  const pendingLen = Array.isArray(row.pendingImageEntries)
    ? row.pendingImageEntries.length
    : 0;
  if (pendingLen > 0) return false;
  if (row.jobKind != null && String(row.jobKind).trim() !== "") return true;
  const s3Len = Array.isArray(row.s3Keys) ? row.s3Keys.length : 0;
  if (s3Len > 0) return true;
  if (
    awaitingUserConfirmIsExplicitlyFalse(row) &&
    row.confirmSnapshotShown != null &&
    String(row.confirmSnapshotShown).trim().length > 0
  ) {
    return true;
  }
  return false;
}

/**
 * Draft baru setelah job selesai — tanpa spread field lama (upload_gambar berikutnya = request baru).
 * Hanya mempertahankan chatId, userId, createdOn.
 */
function resetDraftOnCompletedRow(item, bucket, now) {
  const row = {
    chatId: String(item.chatId ?? ""),
    userId: String(item.userId ?? ""),
    bucket,
    s3Keys: [],
    pendingImageEntries: [],
    theme: undefined,
    bannerText: undefined,
    caption: undefined,
    isProcess: false,
    awaitingUserConfirm: false,
    confirmSnapshotShown: undefined,
    lastConfirmSnapshot: undefined,
    uploadedMessageIds: [],
    jobKind: undefined,
    updatedAt: now,
    createdOn: item.createdOn ?? now,
  };
  applyGsiKeys(row);
  return row;
}

/**
 * Satu baris terbuka (isProcess false) per userId; PK chatId + userId.
 */
async function loadOrCreateDraftResource({
  ddb,
  table,
  gsiName,
  chatId,
  userId,
  bucket,
  now,
}) {
  const curChat = String(chatId);
  const curUid = String(userId);

  const openFromGsi = await queryOpenRequestForUser(ddb, table, gsiName, curUid);
  if (
    openFromGsi &&
    String(openFromGsi.chatId) !== curChat &&
    openFromGsi.resourceIsProcessKey === GSI_FALSE
  ) {
    await ddb.send(
      new DeleteCommand({
        TableName: table,
        Key: {
          chatId: openFromGsi.chatId,
          userId: openFromGsi.userId,
        },
      }),
    );
  }

  let row = await getRequestResource(ddb, table, curChat, curUid);

  if (!row) {
    row = {
      chatId: curChat,
      userId: curUid,
      bucket,
      s3Keys: [],
      pendingImageEntries: [],
      isProcess: false,
      createdOn: now,
      awaitingUserConfirm: false,
    };
    applyGsiKeys(row);
    return row;
  }

  if (isStalePostJobResourceRow(row)) {
    row = resetDraftOnCompletedRow(row, bucket, now);
    await persistResource(ddb, table, row);
    return row;
  }

  if (rowIsProcessCompleted(row)) {
    return resetDraftOnCompletedRow(row, bucket, now);
  }

  row.s3Keys = Array.isArray(row.s3Keys) ? row.s3Keys : [];
  row.pendingImageEntries = Array.isArray(row.pendingImageEntries)
    ? row.pendingImageEntries
    : [];
  row.bucket = bucket;
  applyGsiKeys(row);
  return row;
}

async function persistResource(ddb, table, resource) {
  applyGsiKeys(resource);
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: resource,
    }),
  );
}

/**
 * @param {object} opts
 * @param {string} [opts.jobKind]
 * @param {string} [opts.triggerMessageId] — untuk idempotensi confirm (payload process-intent)
 * @param {string} [opts.tableGenerationRequest]
 * @param {string} [opts.tableGenerationConfirmIdempotency]
 */
export async function runUploadGambarFlow(opts) {
  const {
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
    classifiedIntent,
    gsiUserProcess,
    jobKind: jobKindOpt,
    triggerMessageId: triggerMessageIdOpt,
    tableGenerationRequest,
    tableGenerationConfirmIdempotency,
  } = opts;

  if (!apiKey) {
    return { handled: false };
  }

  const bucket =
    String(process.env.UPLOAD_S3_BUCKET ?? UPLOAD_S3_BUCKET_DEFAULT).trim() ||
    UPLOAD_S3_BUCKET_DEFAULT;
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const gsi = gsiUserProcess ?? "userProcess";
  const now = Date.now();

  const windowHasImage = windowItems.some((i) => i.imageFileId || i.hasImage);

  let resource = await loadOrCreateDraftResource({
    ddb,
    table: tableRequestResource,
    gsiName: gsi,
    chatId,
    userId: senderId,
    bucket,
    now,
  });

  const hasImageInWindow = windowHasImage;
  const textLines = timelineItems
    .slice(-12)
    .map((i) => meaningfulUserText(i.text))
    .filter(Boolean);
  const userTextBlobFallback =
    textLines.join("\n") ||
    windowItems
      .map((i) => meaningfulUserText(i.text))
      .filter(Boolean)
      .join("\n");

  /** Teks dari bubble yang punya gambar + caption di pesan yang sama → prioritas untuk LLM. */
  const comboTexts = windowItems
    .filter(
      (i) =>
        (i.imageFileId || i.hasImage) && meaningfulUserText(i.text),
    )
    .map((i) => meaningfulUserText(i.text));
  const hasImageTextCombo = comboTexts.length > 0;
  const userTextBlobForLlm = hasImageTextCombo
    ? comboTexts.join("\n")
    : userTextBlobFallback;

  let llm = { themeStyle: null, bannerText: null };
  if (String(userTextBlobForLlm ?? "").trim()) {
    try {
      llm = await extractUploadGambarSlots(apiKey, {
        userTextBlob: userTextBlobForLlm,
        hasImageInWindow,
        hasImageTextCombo,
      });
      console.log("llm extractUploadGambarSlots: ", llm);
    } catch (e) {
      console.warn("extract_upload_slots_failed", e);
    }
  }

  /** Hanya Gemini — tidak memaksa tema/banner dari parser teks atau baris pertama chat. */
  const themeFromLlm = normalizeThemeFromSlot(llm.themeStyle);
  if (themeFromLlm) {
    resource.theme = themeFromLlm;
  }

  const bannerFromLlm = llm.bannerText?.trim() ? llm.bannerText.trim() : null;
  if (bannerFromLlm) {
    resource.bannerText = bannerFromLlm;
    resource.caption = bannerFromLlm;
  }

  if (jobKindOpt) {
    resource.jobKind = jobKindOpt;
  }

  const seen = new Set(
    (resource.pendingImageEntries ?? []).map((e) => String(e.messageId)),
  );
  for (const item of windowItems) {
    const mid = String(item.messageId ?? "");
    const fid = item.imageFileId ? String(item.imageFileId) : "";
    if (!mid || !fid || seen.has(mid)) continue;
    if (String(item.provider ?? provider) !== "telegram" || !token) continue;
    resource.pendingImageEntries.push({
      messageId: mid,
      fileId: fid,
      provider: String(item.provider ?? provider ?? "telegram"),
    });
    seen.add(mid);
  }

  resource.updatedAt = now;

  /**
   * Draft sudah foto + tema + teks banner: pesan baru dengan intent upload_gambar
   * dianggap revisi — reset snapshot konfirmasi agar alur sama seperti upload awal
   * (ringkasan + konfirmasi ulang, tidak tertahan di waitingConfirm).
   */
  const hasPendingAfterMerge = resource.pendingImageEntries.length > 0;
  const hasThemeAfter = Boolean(resource.theme && String(resource.theme).trim());
  const hasBannerAfter = Boolean(
    String(resource.bannerText ?? resource.caption ?? "").trim(),
  );
  if (
    classifiedIntent === INTENT_UPLOAD_GAMBAR &&
    hasPendingAfterMerge &&
    hasThemeAfter &&
    hasBannerAfter
  ) {
    resource.confirmSnapshotShown = undefined;
  }

  if (windowHasImage && provider === "whatsapp") {
    console.warn("upload_gambar_whatsapp_image_not_supported_yet", {
      chatId: String(chatId),
      userId: String(senderId),
    });
    await persistResource(ddb, tableRequestResource, resource);
    return { handled: true, skipReason: "whatsapp_image_unsupported" };
  }

  const hasPendingImages = resource.pendingImageEntries.length > 0;
  const hasTheme = Boolean(resource.theme && String(resource.theme).trim());

  if (!hasPendingImages || !hasTheme) {
    resource.awaitingUserConfirm = false;
    resource.confirmSnapshotShown = undefined;
    await persistResource(ddb, tableRequestResource, resource);

    if (canTelegram && chatId) {
      const { text: head, appendThemePrompt } = buildMissingUploadSlotsReply(
        hasPendingImages,
        hasTheme,
        resource,
      );
      let msg = head;
      if (appendThemePrompt) {
        msg += `\n\n${formatThemePrompt()}`;
      } else if (!hasPendingImages) {
        msg += " Silakan kirim foto ke chat ini.";
      }
      await replyTelegram(chatId, msg);
    }
    return { handled: true, needSlots: true };
  }

  const snapshot = buildSnapshot(resource);
  const sameAsShown = resource.confirmSnapshotShown === snapshot;

  const recentForReady = timelineItems
    .slice(-8)
    .map((i) => meaningfulUserText(i.text))
    .filter(Boolean);
  const readyBlob =
    recentForReady.length > 0 ? recentForReady : classifyLinesFromWindow(windowItems);

  const intentConfirms =
    classifiedIntent === INTENT_PROCESS_IMAGE_CONFIRMED ||
    userSaysReadyToProcess(readyBlob);

  if (!sameAsShown) {
    resource.confirmSnapshotShown = snapshot;
    resource.awaitingUserConfirm = true;
    await persistResource(ddb, tableRequestResource, resource);

    console.log("upload_awaiting_theme_style_confirm", {
      chatId: String(chatId ?? ""),
      userId: String(senderId ?? ""),
      theme: resource.theme ?? null,
      themeDisplay: themeLabelForDisplay(resource.theme),
      bannerText: resource.bannerText ?? null,
      photoCount: resource.pendingImageEntries.length,
      snapshot,
      nextStep:
        "Balasan user (ya/setuju/…) akan dianggap process_image_confirmed untuk lanjut proses",
    });

    if (canTelegram && chatId) {
      await replyTelegram(
        chatId,
        buildThemeStyleConfirmTelegramMessage(resource),
      );
    }
    return { handled: true, askedConfirm: true, draftUpdated: true };
  }

  if (resource.awaitingUserConfirm && intentConfirms) {
    console.log("process_image_confirmed", {
      stage: "user_confirmed_enter_pipeline",
      intent: INTENT_PROCESS_IMAGE_CONFIRMED,
      classifiedIntent: classifiedIntent ?? null,
      matchedByClassifierIntent:
        classifiedIntent === INTENT_PROCESS_IMAGE_CONFIRMED,
      matchedByReadyHeuristic: userSaysReadyToProcess(readyBlob),
      theme: resource.theme ?? null,
      bannerText: resource.bannerText ?? null,
      photoCount: resource.pendingImageEntries.length,
      userTextPreview: readyBlob.join("\n").slice(0, 400),
    });

    const jobKind = resolveJobKindFromResource(resource);
    const profile = await ensureBillingProfile(ddb, tableBilling, senderId);
    if (profile.kind !== "ok") {
      return { handled: false };
    }

    const paid = profile.credits > 0;
    const free = profile.free_credit > 0;

    if (jobKind === "banner") {
      if (profile.credits <= 0) {
        if (canTelegram && chatId) {
          await replyTelegram(
            chatId,
            "Untuk permintaan dengan teks banner/promo, perlu saldo credit berbayar. Top up dulu ya kak.",
          );
        }
        return { handled: true, credit_gate: "blocked_banner_needs_paid_credits" };
      }
    } else {
      if (profile.credits <= 0 && profile.free_credit <= 0) {
        if (canTelegram && chatId) {
          await replyTelegram(
            chatId,
            "Saldo credit berbayar dan slot gratis habis. Top up dulu ya supaya bisa diproses.",
          );
        }
        return { handled: true, credit_gate: "blocked_insufficient" };
      }
      if (
        !paid &&
        resource.pendingImageEntries.length > FREE_CREDIT_INITIAL
      ) {
        if (canTelegram && chatId) {
          await replyTelegram(
            chatId,
            `Untuk pakai slot gratis, maksimal ${FREE_CREDIT_INITIAL} foto per permintaan ya kak. Kurangi foto atau top up credit.`,
          );
        }
        return { handled: true, credit_gate: "blocked_free_image_limit" };
      }
    }

    const triggerMessageId = String(
      triggerMessageIdOpt ??
        windowItems[windowItems.length - 1]?.messageId ??
        "",
    ).trim();
    if (
      !tableGenerationRequest ||
      !tableGenerationConfirmIdempotency ||
      !triggerMessageId
    ) {
      console.error("generation_submit_config_missing", {
        hasGenTable: Boolean(tableGenerationRequest),
        hasIdemTable: Boolean(tableGenerationConfirmIdempotency),
        triggerMessageId: triggerMessageId || null,
      });
      if (canTelegram && chatId) {
        await replyTelegram(
          chatId,
          "Maaf kak, sistem generasi belum dikonfigurasi. Hubungi admin ya.",
        );
      }
      return { handled: true, error: "generation_submit_config_missing" };
    }

    const idemKey = buildGenerationConfirmIdempotencyKey(
      senderId,
      triggerMessageId,
    );
    const existingGen = await getGenerationConfirmIdempotency(
      ddb,
      tableGenerationConfirmIdempotency,
      idemKey,
    );
    if (existingGen) {
      console.log("process_image_confirmed_duplicate", {
        generationId: existingGen.generationId,
        senderId: String(senderId),
        triggerMessageId,
      });
      if (canTelegram && chatId) {
        await replyTelegram(
          chatId,
          "Permintaan ini sudah kami terima sebelumnya dan sedang / sudah diproses ya kak.",
        );
      }
      return {
        handled: true,
        duplicate_confirm: true,
        generationId: existingGen.generationId,
      };
    }

    const s3Keys = [];
    try {
      for (const ent of resource.pendingImageEntries) {
        const { buf, contentType, ext } = await downloadTelegramFile(
          token,
          ent.fileId,
        );
        const safeFid = ent.fileId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-24);
        const key = `uploads/${senderId}/${ent.messageId}_${safeFid}.${ext}`;
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buf,
            ContentType: contentType,
          }),
        );
        s3Keys.push(key);
      }
    } catch (e) {
      console.error("upload_gambar_s3_error", e);
      if (canTelegram && chatId) {
        await replyTelegram(
          chatId,
          "Maaf kak, gagal mengunggah gambarnya. Coba lagi ya.",
        );
      }
      return { handled: true, error: "upload_failed" };
    }

    const usePaidCredit = jobKind === "banner" || paid;
    let generationId;
    try {
      const out = await transactSubmitGenerationRequest({
        ddb,
        tableGenerationRequest,
        tableIdempotency: tableGenerationConfirmIdempotency,
        tableRequestResource,
        tableBilling,
        senderId,
        chatId,
        triggerMessageId,
        provider,
        bucket,
        s3Keys,
        theme: resource.theme,
        bannerText: resource.bannerText ?? resource.caption ?? undefined,
        usePaidCredit,
      });
      generationId = out.generationId;
    } catch (e) {
      const reasons = e?.CancellationReasons ?? e?.cancellationReasons ?? [];
      const hasConditionalFail = reasons.some(
        (r) =>
          (r?.Code ?? r?.code) === "ConditionalCheckFailed",
      );
      if (e?.name === "TransactionCanceledException" && hasConditionalFail) {
        const dup = await getGenerationConfirmIdempotency(
          ddb,
          tableGenerationConfirmIdempotency,
          idemKey,
        );
        if (dup && canTelegram && chatId) {
          await replyTelegram(
            chatId,
            "Permintaan ini sudah kami terima sebelumnya dan sedang / sudah diproses ya kak.",
          );
        }
        return {
          handled: true,
          duplicate_confirm: true,
          generationId: dup?.generationId,
        };
      }
      console.error("generation_submit_transact_failed", e);
      if (canTelegram && chatId) {
        await replyTelegram(
          chatId,
          "Maaf kak, saldo tidak cukup atau gagal menyimpan permintaan. Coba cek saldo ya.",
        );
      }
      return { handled: true, error: "generation_submit_failed" };
    }

    console.log("process_image_confirmed", {
      stage: "after_s3_and_generation_transact",
      intent: INTENT_PROCESS_IMAGE_CONFIRMED,
      chatId: String(chatId),
      userId: String(senderId),
      bucket,
      s3Keys,
      theme: resource.theme,
      bannerText: resource.bannerText ?? null,
      jobKind,
      generationId,
    });

    if (canTelegram && chatId) {
      await replyTelegram(
        chatId,
        "Siap kak! Permintaan sudah dikonfirmasi dan kami proses sesuai ringkasan tadi.",
      );
    }
    return { handled: true, confirmed: true, jobKind, generationId };
  }

  if (!resource.awaitingUserConfirm) {
    resource.awaitingUserConfirm = true;
    await persistResource(ddb, tableRequestResource, resource);

    console.log("upload_awaiting_theme_style_confirm", {
      chatId: String(chatId ?? ""),
      userId: String(senderId ?? ""),
      theme: resource.theme ?? null,
      themeDisplay: themeLabelForDisplay(resource.theme),
      bannerText: resource.bannerText ?? null,
      photoCount: resource.pendingImageEntries.length,
      snapshot: buildSnapshot(resource),
      nextStep:
        "Balasan user (ya/setuju/…) akan dianggap process_image_confirmed untuk lanjut proses",
    });

    if (canTelegram && chatId) {
      await replyTelegram(
        chatId,
        buildThemeStyleConfirmTelegramMessage(resource),
      );
    }
    return { handled: true, askedConfirm: true };
  }

  await persistResource(ddb, tableRequestResource, resource);
  return { handled: true, waitingConfirm: true };
}

function classifyLinesFromWindow(windowItems) {
  return windowItems
    .map((i) => {
      const t = (i.text ?? "").trim();
      if (t && t !== "[gambar]") return t;
      if (i.hasImage || i.imageFileId) return "[user mengirim gambar]";
      return "";
    })
    .filter(Boolean);
}
