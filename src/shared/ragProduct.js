import { INTENTS, normalizeIntentForRouting } from "./constants.js";
import { getJsonSecret } from "./secrets.js";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-large";
const MAX_QUERY_CHARS = 12000;

/**
 * Embedding vektor untuk query RAG.
 */
export async function createOpenAiEmbedding(apiKey, input) {
  const text = String(input ?? "").slice(0, MAX_QUERY_CHARS);
  if (!text.trim()) {
    throw new Error("OpenAI embed: input kosong");
  }
  const res = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: text,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI embeddings HTTP ${res.status}: ${t.slice(0, 800)}`);
  }
  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) {
    throw new Error("OpenAI embeddings: vektor tidak ada");
  }
  return vec;
}

/**
 * Query vektor ke indeks Pinecone (data plane).
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.host — base URL indeks, mis. https://nama-xxx.svc.region.pinecone.io
 * @param {number[]} opts.vector
 * @param {number} opts.topK
 * @param {string} [opts.namespace]
 */
export async function pineconeQueryVectors(opts) {
  const { apiKey, host, vector, topK, namespace } = opts;
  const base = String(host ?? "").replace(/\/$/, "");
  if (!base) throw new Error("Pinecone: host kosong");
  const url = `${base}/query`;
  const body = {
    topK,
    vector,
    includeMetadata: true,
  };
  if (namespace) body.namespace = namespace;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Api-Key": apiKey,
      "Content-Type": "application/json",
      "X-Pinecone-API-Version": "2024-07",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Pinecone query HTTP ${res.status}: ${t.slice(0, 800)}`);
  }
  return res.json();
}

function snippetFromMatchMetadata(m) {
  const meta = m?.metadata;
  if (!meta || typeof meta !== "object") return "";
  return (
    meta.text ??
    meta.content ??
    meta.chunk ??
    meta.body ??
    meta.chunk_text ??
    ""
  );
}

/**
 * Log hasil RAG ke CloudWatch (filter: rag_dbg).
 */
export function logRagRetrieval(queryText, matches) {
  const list = Array.isArray(matches) ? matches : [];
  const rows = list.map((m, i) => {
    const id = m.id != null ? String(m.id) : null;
    const score = m.score;
    const preview = String(snippetFromMatchMetadata(m))
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 280);
    return {
      rank: i + 1,
      id,
      score: typeof score === "number" ? Number(score.toFixed(6)) : null,
      textPreview: preview || null,
    };
  });
  console.log("rag_dbg", "retrieval", {
    queryPreview: String(queryText ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 240),
    queryLen: String(queryText ?? "").length,
    matchCount: list.length,
    matches: rows,
  });
}

export function formatRagContextFromMatches(matches) {
  const list = Array.isArray(matches) ? matches : [];
  if (list.length === 0) {
    return "(Tidak ada kutipan relevan di basis pengetahuan.)";
  }
  return list
    .map((m, i) => {
      const score = typeof m.score === "number" ? ` (skor: ${m.score.toFixed(4)})` : "";
      const text = String(snippetFromMatchMetadata(m)).trim();
      return `### Kutipan ${i + 1}${score}\n${text || "(metadata tanpa teks)"}`;
    })
    .join("\n\n");
}

const sharedRagEnv = () => ({
  openAiArn: process.env.OPENAI_SECRET_ARN,
  openAiKeyField: process.env.OPENAI_SECRET_KEY_NAME ?? "secret_key",
  pineconeKeyField: process.env.PINECONE_API_KEY_NAME ?? "api_key",
  topK: Math.min(20, Math.max(1, Number(process.env.RAG_TOP_K ?? "8"))),
});

/** Pinecone indeks intent (klasifikasi / metadata intent). */
export function ragIntentConfigFromEnv() {
  const pineconeArn =
    process.env.PINECONE_INTENT_SECRET_ARN ??
    process.env.PINECONE_SECRET_ARN ??
    "";
  return {
    ...sharedRagEnv(),
    pineconeArn,
    host: String(
      process.env.PINECONE_INTENT_HOST ?? process.env.PINECONE_HOST ?? "",
    ).replace(/\/$/, ""),
    namespace:
      process.env.PINECONE_INTENT_NAMESPACE ??
      process.env.PINECONE_NAMESPACE ??
      "",
  };
}

/** Pinecone indeks pengetahuan produk (kutipan untuk jawaban tanya_info, dll.). */
export function ragKnowledgeConfigFromEnv() {
  const pineconeArn =
    process.env.PINECONE_KNOWLEDGE_SECRET_ARN ??
    process.env.PINECONE_SECRET_ARN ??
    "";
  return {
    ...sharedRagEnv(),
    pineconeArn,
    host: String(
      process.env.PINECONE_KNOWLEDGE_HOST ?? process.env.PINECONE_HOST ?? "",
    ).replace(/\/$/, ""),
    namespace:
      process.env.PINECONE_KNOWLEDGE_NAMESPACE ??
      process.env.PINECONE_NAMESPACE ??
      "",
  };
}

/** @deprecated Gunakan ragIntentConfigFromEnv atau ragKnowledgeConfigFromEnv */
export function ragConfigFromEnv() {
  return ragKnowledgeConfigFromEnv();
}

/**
 * Baca kunci dari Secrets Manager (OpenAI + Pinecone JSON).
 * Host bisa dari env PINECONE_HOST atau field host / index_host di secret Pinecone.
 */
export async function loadRagCredentials(config) {
  if (!config.openAiArn || !config.pineconeArn) {
    throw new Error(
      "OPENAI_SECRET_ARN atau ARN secret Pinecone (intent/knowledge) belum diset",
    );
  }
  const [openDoc, pineDoc] = await Promise.all([
    getJsonSecret(config.openAiArn),
    getJsonSecret(config.pineconeArn),
  ]);
  const openAiApiKey = openDoc[config.openAiKeyField];
  const pineconeApiKey = pineDoc[config.pineconeKeyField];
  const host =
    config.host ||
    pineDoc.host ||
    pineDoc.index_host ||
    pineDoc.PINECONE_HOST ||
    "";
  const namespace = config.namespace || pineDoc.namespace || "";
  if (!openAiApiKey || typeof openAiApiKey !== "string") {
    throw new Error(`OpenAI secret: field "${config.openAiKeyField}" tidak ada`);
  }
  if (!pineconeApiKey || typeof pineconeApiKey !== "string") {
    throw new Error(`Pinecone secret: field "${config.pineconeKeyField}" tidak ada`);
  }
  if (!host || typeof host !== "string") {
    throw new Error(
      "Pinecone host kosong — set PINECONE_HOST di Lambda atau field host / index_host di secret",
    );
  }
  return {
    openAiApiKey,
    pineconeApiKey,
    pineconeHost: String(host).replace(/\/$/, ""),
    namespace: String(namespace),
    topK: config.topK,
  };
}

/**
 * @param {Record<string, unknown>|undefined} meta
 */
function rawIntentFromMetadata(meta) {
  if (!meta || typeof meta !== "object") return null;
  const v =
    meta.intent ??
    meta.Intent ??
    meta.intent_label ??
    meta.intentLabel ??
    meta.label ??
    meta.category ??
    meta.type;
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * Petakan nilai metadata ke salah satu key di INTENTS (snake / frasa).
 */
function coerceIntentToKnownLabel(raw) {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (!str) return null;
  const lower = str.toLowerCase();
  const hit = INTENTS.find((i) => i.toLowerCase() === lower);
  if (hit) return hit;
  const under = lower.replace(/\s+/g, "_");
  const hit2 = INTENTS.find((i) => i === under);
  if (hit2) return hit2;
  const hit3 = INTENTS.find((i) => {
    const iu = i.replace(/\s+/g, "_");
    if (i === "salam") return false;
    return under === iu || under.includes(iu) || iu.includes(under);
  });
  return hit3 ?? null;
}

/**
 * Agregasi skor per intent dari metadata match Pinecone.
 * @returns {string} intent untuk router (sudah lewat normalizeIntentForRouting) atau "unknown"
 */
function detectIntentFromMatches(matches) {
  const list = Array.isArray(matches) ? matches : [];
  const scores = {};

  for (const m of list) {
    const canonical = coerceIntentToKnownLabel(rawIntentFromMetadata(m?.metadata));
    if (!canonical) continue;
    const score = typeof m.score === "number" ? m.score : 0;
    scores[canonical] = (scores[canonical] || 0) + score;
  }

  if (Object.keys(scores).length === 0) return "unknown";

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  return normalizeIntentForRouting(best);
}

/**
 * Log ringkasan hasil RAG untuk CloudWatch (filter: rag_result).
 */
function logRagPipelineResult(queryText, vectorIntent, context, matches, phase) {
  const list = Array.isArray(matches) ? matches : [];
  const intentScores = {};
  for (const m of list) {
    const canonical = coerceIntentToKnownLabel(rawIntentFromMetadata(m?.metadata));
    if (!canonical) continue;
    const score = typeof m.score === "number" ? m.score : 0;
    intentScores[canonical] = (intentScores[canonical] || 0) + score;
  }
  console.log("rag_result", {
    ragPhase: phase ?? null,
    queryPreview: String(queryText ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 240),
    queryLen: String(queryText ?? "").length,
    vectorIntent,
    intentScoreByLabel:
      Object.keys(intentScores).length > 0 ? intentScores : null,
    contextCharCount: String(context ?? "").length,
    contextPreview: String(context ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 900),
    matchSummaries: list.map((m, i) => ({
      rank: i + 1,
      id: m.id != null ? String(m.id) : null,
      score: typeof m.score === "number" ? Number(m.score.toFixed(6)) : null,
      metadataIntent: rawIntentFromMetadata(m?.metadata) ?? null,
      textPreview: String(snippetFromMatchMetadata(m))
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 200),
    })),
  });
}

/**
 * Satu alur: embed query → Pinecone topK → konteks teks + sinyal intent dari metadata.
 * @param {{ phase?: "intent" | "knowledge" }} [opts]
 * @returns {{ context: string, vectorIntent: string, matches: unknown[] }}
 */
export async function retrieveProductRagContext(queryText, creds, opts) {
  const phase = opts?.phase;
  const embedding = await createOpenAiEmbedding(creds.openAiApiKey, queryText);
  const json = await pineconeQueryVectors({
    apiKey: creds.pineconeApiKey,
    host: creds.pineconeHost,
    vector: embedding,
    topK: creds.topK,
    namespace: creds.namespace || undefined,
  });
  const matches = json.matches ?? [];
  logRagRetrieval(queryText, matches);
  const context = formatRagContextFromMatches(matches);
  const vectorIntent = detectIntentFromMatches(matches);
  logRagPipelineResult(queryText, vectorIntent, context, matches, phase);
  return {
    context,
    vectorIntent,
    matches,
  };
}
