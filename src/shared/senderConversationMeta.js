import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

export const CONV_STATE_WAITING_TOPUP_CONFIRMATION =
  "WAITING_TOPUP_CONFIRMATION";
export const CONV_STATE_WAITING_TOPUP_AMOUNT = "WAITING_TOPUP_AMOUNT";
export const CONV_STATE_WAITING_IMAGE_PROMPT = "WAITING_IMAGE_PROMPT";

const MAX_LAST_MSG = 1000;

/**
 * @param {unknown} v
 * @returns {string|null}
 */
export function readConversationState(v) {
  if (v == null || v === "") return null;
  return String(v);
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} ddb
 * @param {string} tableSenderMeta
 * @param {string} senderId
 * @param {{
 *   conversationState?: string | null;
 *   lastSystemMessage?: string | null;
 *   pendingTopUpCredits?: number | null;
 * }} patch — undefined = jangan ubah field tersebut
 */
export async function patchSenderConversation(ddb, tableSenderMeta, senderId, patch) {
  if (!tableSenderMeta || senderId == null || senderId === "") return;

  const sets = [];
  const removes = [];
  /** @type {Record<string, unknown>} */
  const vals = {};

  if (patch.conversationState !== undefined) {
    sets.push("conversationState = :cs");
    vals[":cs"] =
      patch.conversationState == null || patch.conversationState === ""
        ? ""
        : String(patch.conversationState);
  }
  if (patch.lastSystemMessage !== undefined) {
    sets.push("lastSystemMessage = :lm");
    const s = String(patch.lastSystemMessage ?? "").slice(0, MAX_LAST_MSG);
    vals[":lm"] = s;
  }
  if (patch.pendingTopUpCredits !== undefined) {
    if (patch.pendingTopUpCredits == null || patch.pendingTopUpCredits === "") {
      removes.push("pendingTopUpCredits");
    } else {
      sets.push("pendingTopUpCredits = :ptc");
      vals[":ptc"] = Math.max(0, Math.trunc(Number(patch.pendingTopUpCredits)));
    }
  }

  if (sets.length === 0 && removes.length === 0) return;

  sets.push("conversationUpdatedAt = :ua");
  vals[":ua"] = Date.now();

  const parts = [];
  if (sets.length) parts.push(`SET ${sets.join(", ")}`);
  if (removes.length) parts.push(`REMOVE ${removes.join(", ")}`);

  await ddb.send(
    new UpdateCommand({
      TableName: tableSenderMeta,
      Key: { senderId: String(senderId) },
      UpdateExpression: parts.join(" "),
      ExpressionAttributeValues: Object.keys(vals).length ? vals : undefined,
    }),
  );
}

/**
 * Hapus konteks percakapan (top-up batal / selesai).
 */
export async function clearSenderConversation(ddb, tableSenderMeta, senderId) {
  await patchSenderConversation(ddb, tableSenderMeta, senderId, {
    conversationState: "",
    lastSystemMessage: "",
    pendingTopUpCredits: null,
  });
}

