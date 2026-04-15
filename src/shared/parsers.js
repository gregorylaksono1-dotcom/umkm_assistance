function telegramFromBody(body) {
  const msg = body?.message ?? body?.edited_message;
  if (!msg) return null;
  const text = (msg.text ?? msg.caption ?? "").trim();
  const photos = msg.photo;
  const largest = photos?.length ? photos[photos.length - 1] : null;
  const imageFileId = largest?.file_id ? String(largest.file_id) : "";
  if (!text && !imageFileId) return null;
  const senderId = String(msg.from?.id ?? msg.chat?.id ?? "");
  const messageId = String(msg.message_id ?? "");
  const chatId = String(msg.chat?.id ?? "");
  if (!senderId || !messageId) return null;
  return {
    provider: "telegram",
    senderId,
    messageId,
    chatId,
    text: text || (imageFileId ? "[gambar]" : ""),
    imageFileId: imageFileId || undefined,
    hasImage: Boolean(imageFileId),
  };
}

function whatsappFromBody(body) {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const wmsg = value?.messages?.[0];
  if (!wmsg || wmsg.type !== "text") return null;
  const text = wmsg.text?.body ?? "";
  if (!text) return null;
  const senderId = String(wmsg.from ?? "");
  const messageId = String(wmsg.id ?? "");
  if (!senderId || !messageId) return null;
  return {
    provider: "whatsapp",
    senderId,
    messageId,
    chatId: senderId,
    text,
  };
}

export function parseIncomingMessage(path, body) {
  if (!body || typeof body !== "object") return null;
  if (path?.includes("whatsapp")) return whatsappFromBody(body);
  return telegramFromBody(body);
}
