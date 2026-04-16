import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});

const jsonSecretCache = new Map();

export async function getJsonSecret(secretArn) {
  const now = Date.now();
  const hit = jsonSecretCache.get(secretArn);
  if (hit && now < hit.expires) return hit.value;

  const out = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  const raw =
    out.SecretString ??
    (out.SecretBinary ? Buffer.from(out.SecretBinary).toString("utf8") : "");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SecretString must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Secret JSON must be an object");
  }
  jsonSecretCache.set(secretArn, { value: parsed, expires: now + 5 * 60 * 1000 });
  return parsed;
}

let geminiKeyCache = { key: null, arn: "", name: "", expires: 0 };

/**
 * Ambil API key Gemini dari Secret JSON (field `secretKeyName`, default gemini_api_key).
 * @param {string} secretArn
 * @param {string} [secretKeyName]
 */
export async function getGeminiApiKey(secretArn, secretKeyName = "gemini_api_key") {
  const now = Date.now();
  if (
    geminiKeyCache.key &&
    geminiKeyCache.arn === secretArn &&
    geminiKeyCache.name === secretKeyName &&
    now < geminiKeyCache.expires
  ) {
    return geminiKeyCache.key;
  }

  const parsed = await getJsonSecret(secretArn);
  const key = parsed[secretKeyName];
  if (!key || typeof key !== "string") {
    throw new Error(`Missing ${secretKeyName} in secret JSON`);
  }
  geminiKeyCache = {
    key,
    arn: secretArn,
    name: secretKeyName,
    expires: now + 5 * 60 * 1000,
  };
  return key;
}
