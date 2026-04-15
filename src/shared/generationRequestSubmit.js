import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { randomUUID } from "node:crypto";
import {
  billingUserPk,
  BILLING_PROFILE_SK,
} from "./creditProfile.js";

const TYPE_IMAGE = "image";
const STATUS_PENDING = "PENDING";

/** Client level rendah — hindari GetCommand/TransactWriteCommand dari lib-dynamodb (rusak saat esbuild bundle). */
const dynamoLowLevel = new DynamoDBClient({});

const marshallOpts = { removeUndefinedValues: true };

/**
 * @param {string} senderId
 * @param {string} triggerMessageId
 */
export function buildGenerationConfirmIdempotencyKey(senderId, triggerMessageId) {
  return `CONFIRM#${String(senderId)}#${String(triggerMessageId)}`;
}

/**
 * @param {unknown} _ddb tidak dipakai (API tetap kompatibel); pakai DynamoDBClient modul.
 * @param {string} tableIdempotency
 * @param {string} idempotencyKey
 * @returns {Promise<{ generationId: string } | null>}
 */
export async function getGenerationConfirmIdempotency(
  _ddb,
  tableIdempotency,
  idempotencyKey,
) {
  if (!tableIdempotency || !idempotencyKey) return null;
  const out = await dynamoLowLevel.send(
    new GetItemCommand({
      TableName: tableIdempotency,
      Key: marshall({ idempotencyKey }, marshallOpts),
    }),
  );
  const item = out.Item ? unmarshall(out.Item) : undefined;
  const gid = item?.generationId;
  return typeof gid === "string" && gid.length > 0 ? { generationId: gid } : null;
}

/**
 * Satu transaksi: idempotency + generation_request + hapus request_resource + kurangi kredit.
 *
 * @param {object} p
 * @param {unknown} p.ddb tidak dipakai
 * @param {string} p.tableGenerationRequest
 * @param {string} p.tableIdempotency
 * @param {string} p.tableRequestResource
 * @param {string} p.tableBilling
 * @param {string} p.senderId
 * @param {string} p.chatId
 * @param {string} p.triggerMessageId
 * @param {string} p.provider
 * @param {string} p.bucket
 * @param {string[]} p.s3Keys
 * @param {unknown} p.theme
 * @param {string} [p.bannerText]
 * @param {boolean} p.usePaidCredit — sama seperti alur lama: jobKind === "banner" || profile.credits > 0
 */
export async function transactSubmitGenerationRequest(p) {
  const {
    ddb: _ddb,
    tableGenerationRequest,
    tableIdempotency,
    tableRequestResource,
    tableBilling,
    senderId,
    chatId,
    triggerMessageId,
    provider,
    bucket,
    s3Keys,
    theme,
    bannerText,
    usePaidCredit,
  } = p;

  if (
    !tableGenerationRequest ||
    !tableIdempotency ||
    !tableRequestResource ||
    !tableBilling
  ) {
    throw new Error("generation_submit_env_tables_missing");
  }

  const uid = String(senderId);
  const cid = String(chatId);
  const tid = String(triggerMessageId);
  const idempotencyKey = buildGenerationConfirmIdempotencyKey(uid, tid);
  const generationId = randomUUID();
  const now = Date.now();
  const pk = billingUserPk(uid);

  const bannerTrim =
    bannerText != null && String(bannerText).trim()
      ? String(bannerText).trim()
      : undefined;

  const genItem = {
    generationId,
    userId: uid,
    s3Keys,
    theme: theme ?? undefined,
    bannerText: bannerTrim,
    type: TYPE_IMAGE,
    status: STATUS_PENDING,
    chatId: cid,
    provider: provider != null ? String(provider) : undefined,
    createdAt: now,
    triggerMessageId: tid,
    bucket,
  };

  const idemItem = {
    idempotencyKey,
    generationId,
    userId: uid,
    createdAt: now,
  };

  const billingKey = marshall({ PK: pk, SK: BILLING_PROFILE_SK }, marshallOpts);
  const billingValuesPaid = marshall(
    { ":dec": -1, ":one": 1, ":ua": now },
    marshallOpts,
  );
  const billingValuesFree = marshall(
    { ":dec": -1, ":one": 1, ":ua": now },
    marshallOpts,
  );

  const billingUpdate = usePaidCredit
    ? {
        Update: {
          TableName: tableBilling,
          Key: billingKey,
          UpdateExpression: "ADD credits :dec SET updatedAt = :ua",
          ConditionExpression: "credits >= :one",
          ExpressionAttributeValues: billingValuesPaid,
        },
      }
    : {
        Update: {
          TableName: tableBilling,
          Key: billingKey,
          UpdateExpression: "ADD free_credit :dec SET updatedAt = :ua",
          ConditionExpression: "free_credit >= :one",
          ExpressionAttributeValues: billingValuesFree,
        },
      };

  await dynamoLowLevel.send(
    new TransactWriteItemsCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableIdempotency,
            Item: marshall(idemItem, marshallOpts),
            ConditionExpression: "attribute_not_exists(idempotencyKey)",
          },
        },
        {
          Put: {
            TableName: tableGenerationRequest,
            Item: marshall(genItem, marshallOpts),
          },
        },
        {
          Delete: {
            TableName: tableRequestResource,
            Key: marshall({ chatId: cid, userId: uid }, marshallOpts),
          },
        },
        billingUpdate,
      ],
    }),
  );

  return { generationId, idempotencyKey };
}
