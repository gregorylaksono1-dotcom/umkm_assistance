import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

/**
 * Unduh file dari Telegram lalu unggah ke S3.
 *
 * @param {{
 *   botToken: string,
 *   fileId: string,
 *   bucket: string,
 *   userId: string,
 *   messageId: string,
 * }} p
 * @returns {Promise<string>} S3 object key
 */
export async function uploadTelegramFileToS3(p) {
  const { botToken, fileId, bucket, userId, messageId } = p;
  const getUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const gr = await fetch(getUrl);
  const gj = /** @type {{ ok?: boolean, result?: { file_path?: string } }} */ (
    await gr.json()
  );
  if (!gj?.ok || !gj.result?.file_path) {
    throw new Error("telegram_getfile_failed");
  }
  const filePath = gj.result.file_path;
  const parts = filePath.split(".");
  const extRaw = parts.length > 1 ? parts.pop() : "jpg";
  const safeExt = /^[a-z0-9]+$/i.test(String(extRaw))
    ? String(extRaw).toLowerCase().slice(0, 6)
    : "jpg";

  const dlUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const fileRes = await fetch(dlUrl);
  if (!fileRes.ok) {
    throw new Error("telegram_download_failed");
  }
  const buf = Buffer.from(await fileRes.arrayBuffer());
  const ct =
    fileRes.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";

  const safeFid = String(fileId).replace(/[^a-zA-Z0-9_-]/g, "").slice(-32);
  const key = `uploads/${String(userId)}/${String(messageId)}_${safeFid}.${safeExt}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buf,
      ContentType: ct,
    }),
  );
  return key;
}
