import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});

let cachedKey = null;
let cacheExpires = 0;

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

export async function getGeminiApiKey(secretArn, secretKeyName) {
  const now = Date.now();
  if (cachedKey && now < cacheExpires) return cachedKey;

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
    throw new Error("SecretString must be JSON with gemini_api_key");
  }
  const key = parsed[secretKeyName];
  if (!key || typeof key !== "string") {
    throw new Error(`Missing ${secretKeyName} in secret JSON`);
  }
  cachedKey = key;
  cacheExpires = now + 5 * 60 * 1000;
  return key;
}
