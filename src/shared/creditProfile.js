import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { FREE_CREDIT_INITIAL } from "./constants.js";

/** Sort key item profil saldo user di billing_usage_credit. */
export const BILLING_PROFILE_SK = "PROFILE";

export function billingUserPk(senderId) {
  return `USER#${String(senderId)}`;
}

/**
 * @param {Record<string, unknown>|undefined} item — baris PROFILE dari DynamoDB
 * @returns {{ kind: "missing" } | { kind: "ok", credits: number, free_credit: number }}
 */
export function interpretProfileItem(item) {
  if (!item) return { kind: "missing" };
  const raw = item.credits ?? item.creditBalance ?? item.balance;
  const credits = Number(raw);
  const n = Number.isFinite(credits) ? Math.trunc(credits) : 0;
  const fraw = item.free_credit ?? item.freeCredit;
  const f = Number(fraw);
  const freeCredit = Number.isFinite(f) ? Math.max(0, Math.trunc(f)) : 0;
  return { kind: "ok", credits: n, free_credit: freeCredit };
}

/**
 * Pastikan baris PROFILE ada. Jika belum, buat dengan credits 0 dan free_credit mengikuti FREE_CREDIT_INITIAL.
 * Profil lama tanpa field free_credit diberi nilai 0 sekali.
 *
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} ddb
 * @param {string} tableName
 * @param {string} senderId
 */
export async function ensureBillingProfile(ddb, tableName, senderId) {
  const pk = billingUserPk(senderId);
  const sk = BILLING_PROFILE_SK;
  const existing = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { PK: pk, SK: sk } }),
  );
  if (existing.Item) {
    const fc = existing.Item.free_credit;
    const fcAlt = existing.Item.freeCredit;
    const hasFree = fc != null || fcAlt != null;
    if (fc == null && fcAlt != null) {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: pk, SK: sk },
            UpdateExpression: "SET free_credit = :f, updatedAt = :ua REMOVE freeCredit",
            ExpressionAttributeValues: {
              ":f": Number(fcAlt) || 0,
              ":ua": Date.now(),
            },
          }),
        );
      } catch (e) {
        console.warn("ensure_billing_profile_migrate_freeCredit", e);
      }
    } else if (!hasFree) {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { PK: pk, SK: sk },
            UpdateExpression: "SET free_credit = :z, updatedAt = :ua",
            ExpressionAttributeValues: {
              ":z": 0,
              ":ua": Date.now(),
            },
            ConditionExpression:
              "attribute_not_exists(free_credit) AND attribute_not_exists(freeCredit)",
          }),
        );
      } catch (e) {
        if (e?.name !== "ConditionalCheckFailedException") throw e;
      }
    }
    const again = await ddb.send(
      new GetCommand({ TableName: tableName, Key: { PK: pk, SK: sk } }),
    );
    return interpretProfileItem(again.Item);
  }

  const now = Date.now();
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: pk,
          SK: sk,
          userId: String(senderId),
          credits: 0,
          free_credit: FREE_CREDIT_INITIAL,
          createdAt: now,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
  }

  const created = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { PK: pk, SK: sk } }),
  );
  return interpretProfileItem(created.Item);
}

/**
 * Kurangi 1 credit berbayar (setelah pekerjaan terkonfirmasi).
 * @param {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} ddb
 * @param {string} tableName
 * @param {string} senderId
 */
export async function decrementPaidCredit(ddb, tableName, senderId) {
  const pk = billingUserPk(senderId);
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { PK: pk, SK: BILLING_PROFILE_SK },
      UpdateExpression: "ADD credits :dec SET updatedAt = :ua",
      ConditionExpression: "credits >= :one",
      ExpressionAttributeValues: {
        ":dec": -1,
        ":one": 1,
        ":ua": Date.now(),
      },
    }),
  );
}

/**
 * Kurangi 1 slot free_credit (profil harus sudah punya atribut free_credit).
 */
export async function decrementFreeCredit(ddb, tableName, senderId) {
  const pk = billingUserPk(senderId);
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { PK: pk, SK: BILLING_PROFILE_SK },
      UpdateExpression: "ADD free_credit :dec SET updatedAt = :ua",
      ConditionExpression: "free_credit >= :one",
      ExpressionAttributeValues: {
        ":dec": -1,
        ":one": 1,
        ":ua": Date.now(),
      },
    }),
  );
}

/**
 * Satu permintaan gambar/video: potong 1 dari `credits` berbayar bila cukup,
 * kalau tidak coba `free_credit`.
 *
 * @returns {Promise<{ kind: "ok", source: "paid" | "free" } | { kind: "insufficient" }>}
 */
export async function consumeOneMediaCredit(ddb, tableName, senderId) {
  try {
    await decrementPaidCredit(ddb, tableName, senderId);
    return { kind: "ok", source: "paid" };
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
  }
  try {
    await decrementFreeCredit(ddb, tableName, senderId);
    return { kind: "ok", source: "free" };
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
  }
  return { kind: "insufficient" };
}

/**
 * Kembalikan 1 credit media bila langkah setelah `consumeOneMediaCredit` gagal.
 * @param {"paid"|"free"} source
 */
export async function refundOneMediaCredit(ddb, tableName, senderId, source) {
  const pk = billingUserPk(senderId);
  const now = Date.now();
  if (source === "paid") {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: pk, SK: BILLING_PROFILE_SK },
        UpdateExpression: "ADD credits :inc SET updatedAt = :ua",
        ExpressionAttributeValues: {
          ":inc": 1,
          ":ua": now,
        },
      }),
    );
    return;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { PK: pk, SK: BILLING_PROFILE_SK },
      UpdateExpression: "ADD free_credit :inc SET updatedAt = :ua",
      ExpressionAttributeValues: {
        ":inc": 1,
        ":ua": now,
      },
    }),
  );
}
