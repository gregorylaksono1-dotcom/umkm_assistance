import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** Umur link unduh (detik) — 1 hari. */
export const PRESIGNED_GET_EXPIRES_SEC = 86400;

const defaultClient = new S3Client({});

/**
 * @param {string} bucket
 * @param {string[]} keys
 * @param {S3Client} [client]
 * @returns {Promise<string[]>}
 */
export async function presignedGetObjectUrls(bucket, keys, client = defaultClient) {
  const b = String(bucket ?? "").trim();
  const out = [];
  for (const key of keys) {
    const k = String(key ?? "").trim();
    if (!b || !k) continue;
    const cmd = new GetObjectCommand({ Bucket: b, Key: k });
    const url = await getSignedUrl(client, cmd, {
      expiresIn: PRESIGNED_GET_EXPIRES_SEC,
    });
    out.push(url);
  }
  return out;
}
