/**
 * Ekstrak data aman dari Telegram Bot API `Update` (hanya properti yang dibaca).
 * Tidak ada eval / eksekusi — hanya akses field JSON.
 *
 * @param {unknown} body — objek hasil JSON.parse body webhook
 * @returns {null | {
 *   senderId: string,
 *   chatId: string,
 *   messageId: string,
 *   text: string,
 *   hasImage: boolean,
 *   imageFileId: string | null,
 *   provider: "telegram",
 * }}
 */
export function parseTelegramUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const msg =
    /** @type {Record<string, unknown>} */ (body).message ??
    /** @type {Record<string, unknown>} */ (body).edited_message ??
    /** @type {Record<string, unknown>} */ (body).channel_post ??
    null;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;

  const from = /** @type {Record<string, unknown>} */ (msg).from;
  const chat = /** @type {Record<string, unknown>} */ (msg).chat;
  if (!from || typeof from !== "object" || from.id == null) return null;
  if (!chat || typeof chat !== "object" || chat.id == null) return null;

  const messageId = /** @type {Record<string, unknown>} */ (msg).message_id;
  if (messageId == null) return null;

  let text = "";
  const rawText = /** @type {Record<string, unknown>} */ (msg).text;
  if (typeof rawText === "string") text = rawText;
  const cap = /** @type {Record<string, unknown>} */ (msg).caption;
  if (!text && typeof cap === "string") text = cap;
  text = text.trim().slice(0, 4000);

  let hasImage = false;
  let imageFileId = null;
  const photos = /** @type {Record<string, unknown>} */ (msg).photo;
  if (Array.isArray(photos) && photos.length > 0) {
    hasImage = true;
    const last = photos[photos.length - 1];
    if (last && typeof last === "object" && last.file_id != null) {
      imageFileId = String(last.file_id);
    }
  }
  const doc = /** @type {Record<string, unknown>} */ (msg).document;
  if (doc && typeof doc === "object") {
    const mime = /** @type {Record<string, unknown>} */ (doc).mime_type;
    if (typeof mime === "string" && mime.startsWith("image/")) {
      hasImage = true;
      const fid = /** @type {Record<string, unknown>} */ (doc).file_id;
      if (fid != null) imageFileId = String(fid);
    }
  }

  return {
    senderId: String(from.id),
    chatId: String(chat.id),
    messageId: String(messageId),
    text,
    hasImage,
    imageFileId,
    provider: "telegram",
  };
}
