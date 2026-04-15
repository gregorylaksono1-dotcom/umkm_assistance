import { patchSenderConversation } from "../shared/senderConversationMeta.js";

/** Util Telegram ringan untuk process-intent (hindari dependensi siklik dengan intentHandlers). */

export async function replyTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    console.warn("telegram_send_failed", res.status, await res.text());
  }
}

export async function notifyUnknownIntentToAdmin({
  userLines,
  senderId,
  userChatId,
  provider,
}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminId = process.env.TELEGRAM_UNKNOWN_NOTIFY_CHAT_ID;
  if (!token || !adminId) return;

  const userText = userLines.join("\n").trim() || "(kosong)";
  const body = [
    "[DapurArtisan] intent: unknown",
    `provider: ${provider ?? "-"}`,
    `senderId: ${senderId}`,
    `chatId: ${userChatId ?? "-"}`,
    "",
    "Pesan user:",
    "---",
    userText,
  ].join("\n");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: adminId, text: body.slice(0, 4000) }),
  });
  if (!res.ok) {
    console.warn("telegram_unknown_notify_failed", res.status, await res.text());
  }
}

/**
 * Kirim balasan Telegram lalu persist lastSystemMessage (+ opsional state / pending top-up) ke SenderMeta.
 * @param {object} p
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} [p.ddb]
 * @param {string} [p.tableSenderMeta]
 * @param {string} [p.senderId]
 * @param {unknown} p.chatId
 * @param {string} p.text
 * @param {string|null|undefined} [p.nextConversationState] — undefined = jangan ubah conversationState
 * @param {number|null|undefined} [p.pendingTopUpCredits] — undefined = jangan ubah
 */
export async function replyAndRememberState(p) {
  const {
    ddb,
    tableSenderMeta,
    senderId,
    chatId,
    text,
    nextConversationState,
    pendingTopUpCredits,
  } = p;
  await replyTelegram(chatId, text);
  if (!ddb || !tableSenderMeta || senderId == null || senderId === "") return;
  /** @type {{ lastSystemMessage: string, conversationState?: string|null, pendingTopUpCredits?: number|null }} */
  const patch = { lastSystemMessage: text };
  if (nextConversationState !== undefined) {
    patch.conversationState =
      nextConversationState == null || nextConversationState === ""
        ? ""
        : String(nextConversationState);
  }
  if (pendingTopUpCredits !== undefined) {
    patch.pendingTopUpCredits = pendingTopUpCredits;
  }
  await patchSenderConversation(ddb, tableSenderMeta, senderId, patch);
}
