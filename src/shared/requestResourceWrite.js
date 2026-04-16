import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Kunci tabel: attribute `chatId` (HASH) = Telegram messageId; `userId` (RANGE) = pengirim.
 *
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} ddb
 * @param {string} tableName
 * @param {{
 *   chatId: string,
 *   userId: string,
 *   sourceS3Key: string,
 *   type: "image" | "video",
 *   keterangan: string,
 *   translation: string,
 *   messageId: string,
 * }} row — `chatId` = id chat Telegram; `messageId` = id pesan (jadi nilai HASH).
 */
export async function putPendingRequestResource(ddb, tableName, row) {
  const now = Date.now();
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        chatId: String(row.messageId),
        userId: String(row.userId),
        telegramChatId: String(row.chatId),
        sourceS3Key: String(row.sourceS3Key),
        type: row.type,
        status: "PENDING",
        keterangan: String(row.keterangan ?? "").slice(0, 4000),
        translation: String(row.translation ?? "").slice(0, 4000),
        provider: "telegram",
        createdAt: now,
      },
    }),
  );
}

/**
 * Setelah hasil AI tersimpan di S3.
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} ddb
 * @param {string} tableName
 * @param {{ messageId: string, userId: string, resultS3Key: string }} p
 */
export async function markRequestResourceSuccess(ddb, tableName, p) {
  const now = Date.now();
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: {
        chatId: String(p.messageId),
        userId: String(p.userId),
      },
      UpdateExpression:
        "SET #r = :r, #s = :s, completedAt = :t",
      ExpressionAttributeNames: {
        "#r": "result",
        "#s": "status",
      },
      ExpressionAttributeValues: {
        ":r": String(p.resultS3Key),
        ":s": "SUCCESS",
        ":t": now,
      },
    }),
  );
}

/**
 * Ambil id chat Telegram tersimpan (untuk balasan ke chat yang benar).
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} ddb
 * @param {string} tableName
 * @param {string} messageId — nilai kunci HASH (sama seperti di `putPendingRequestResource`).
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
export async function getRequestResourceChatId(ddb, tableName, messageId, userId) {
  const out = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        chatId: String(messageId),
        userId: String(userId),
      },
      ProjectionExpression: "telegramChatId",
    }),
  );
  const c = out.Item?.telegramChatId;
  return c != null && c !== "" ? String(c) : null;
}
