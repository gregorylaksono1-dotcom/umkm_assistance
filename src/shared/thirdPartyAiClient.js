import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getJsonSecret } from "./secrets.js";
import { markRequestResourceSuccess } from "./requestResourceWrite.js";

const s3 = new S3Client({});

/**
 * Secret JSON (thirdparty_ai): setidaknya `host` (URL lengkap POST) dan `api_key`.
 * Alias: url / endpoint untuk host; freepik_api_key untuk api_key.
 *
 * @param {string} secretArn
 * @returns {Promise<{ postUrl: string, apiKey: string }>}
 */
export async function loadThirdPartyAiConfig(secretArn) {
  const j = await getJsonSecret(secretArn);
  const rawHost =
    j.host ?? j.url ?? j.endpoint ?? j.base_url ?? j.api_url ?? "";
  const postUrl = String(rawHost).trim().replace(/\/$/, "");
  const apiKey = String(
    j.api_key ?? j.freepik_api_key ?? j.x_freepik_api_key ?? "",
  ).trim();
  if (!postUrl || !apiKey) {
    throw new Error("third_party_ai_secret_missing_host_or_api_key");
  }
  if (!/^https?:\/\//i.test(postUrl)) {
    throw new Error("third_party_ai_host_must_be_absolute_url");
  }
  return { postUrl, apiKey };
}

/**
 * @param {string} bucket
 * @param {string} key
 * @returns {Promise<string>} base64 (raw, tanpa data: prefix)
 */
export async function readS3ObjectAsBase64(bucket, key) {
  const out = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const body = out.Body;
  if (!body) {
    throw new Error("s3_empty_body");
  }
  const bytes = await body.transformToByteArray();
  return Buffer.from(bytes).toString("base64");
}

/**
 * @param {string} url
 * @returns {string}
 */
function extFromUrl(url) {
  const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(url);
  return m ? m[1].toLowerCase() : "jpg";
}

/**
 * POST ke API AI pihak ketiga, unduh `data.generated`, unggah ke S3, update Dynamo SUCCESS + result.
 *
 * @param {{
 *   secretArn: string,
 *   bucket: string,
 *   sourceS3Key: string,
 *   prompt: string,
 *   imagination?: string,
 *   ddb: import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient,
 *   tableRequestResource: string,
 *   messageId: string,
 *   userId: string,
 * }} p
 */
export async function postThirdPartyAiJob(p) {
  const {
    secretArn,
    bucket,
    sourceS3Key,
    prompt,
    imagination = "subtle",
    ddb,
    tableRequestResource,
    messageId,
    userId,
  } = p;

  const { postUrl, apiKey } = await loadThirdPartyAiConfig(secretArn);
  const imageB64 = await readS3ObjectAsBase64(bucket, sourceS3Key);

  const payload = {
    image: imageB64,
    prompt: String(prompt ?? "").slice(0, 8000),
    imagination,
    aspect_ratio: "square_1_1",
  };

  const res = await fetch(
    `${postUrl}/v1/ai/beta/text-to-image/reimagine-flux`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-freepik-api-key": apiKey,
      },
      body: JSON.stringify(payload),
    },
  );

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `third_party_ai_http_${res.status}: ${text.slice(0, 800)}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`third_party_ai_invalid_json: ${text.slice(0, 200)}`);
  }

  const data = parsed?.data;
  const urls = Array.isArray(data?.generated)
    ? data.generated.filter((u) => typeof u === "string" && u.length > 0)
    : [];
  const st = data?.status;
  if (st && st !== "COMPLETED") {
    throw new Error(`third_party_ai_status_${st}`);
  }
  if (!urls.length) {
    throw new Error(`third_party_ai_no_generated: ${text.slice(0, 400)}`);
  }

  const taskId = String(data?.task_id ?? "task").replace(/[^\w-]/g, "").slice(0, 80) || "task";
  const resultKeys = [];

  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    const imgRes = await fetch(url);
    if (!imgRes.ok) {
      throw new Error(
        `third_party_ai_download_${imgRes.status}: ${url.slice(0, 120)}`,
      );
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const ext = extFromUrl(url);
    const suffix = urls.length > 1 ? `-${i}` : "";
    const resultKey = `generated/${userId}/${taskId}${suffix}.${ext}`;
    const ct =
      imgRes.headers.get("content-type")?.split(";")[0]?.trim() ||
      "image/jpeg";

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: resultKey,
        Body: buf,
        ContentType: ct,
      }),
    );
    resultKeys.push(resultKey);
  }

  const resultField = resultKeys.join(",");

  await markRequestResourceSuccess(ddb, tableRequestResource, {
    messageId,
    userId,
    resultS3Key: resultField,
  });

  return {
    status: res.status,
    taskId: data?.task_id,
    resultKeys: resultKeys,
  };
}
