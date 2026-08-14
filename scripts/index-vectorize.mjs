import fs from "node:fs";
import path from "node:path";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const indexName = process.env.CLOUDFLARE_VECTORIZE_INDEX || "dayan-archive-v1";
const embeddingModel = process.env.CLOUDFLARE_EMBEDDING_MODEL || "@cf/qwen/qwen3-embedding-0.6b";
const inputPath = path.resolve(process.argv[2] || "build/vector-windows.jsonl");

const DIMENSIONS = 1024;
const METRIC = "cosine";
const EMBED_BATCH_SIZE = 32;
const UPSERT_BATCH_SIZE = 256;

if (!accountId) throw new Error("Set CLOUDFLARE_ACCOUNT_ID first");
if (!apiToken) throw new Error("Set CLOUDFLARE_API_TOKEN first");
if (!fs.existsSync(inputPath)) throw new Error(`Vector window file not found: ${inputPath}`);

const rows = fs.readFileSync(inputPath, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSON on ${inputPath} line ${index + 1}: ${error.message}`);
    }
  });

if (!rows.length) throw new Error("No vector windows found to index");
console.log(`Loaded ${rows.length} Rav-centered retrieval windows.`);
console.log(`Target Vectorize index: ${indexName}`);
console.log(`Embedding model: ${embeddingModel}`);

await ensureIndex();

let pendingVectors = [];
let completed = 0;
for (let start = 0; start < rows.length; start += EMBED_BATCH_SIZE) {
  const batch = rows.slice(start, start + EMBED_BATCH_SIZE);
  const embeddings = await embedTexts(batch.map((row) => row.embedding_text));

  if (embeddings.length !== batch.length) {
    throw new Error(`Workers AI returned ${embeddings.length} embeddings for a batch of ${batch.length}`);
  }

  for (let i = 0; i < batch.length; i++) {
    const values = embeddings[i];
    if (!Array.isArray(values) || values.length !== DIMENSIONS || !values.every((value) => typeof value === "number")) {
      throw new Error(`Unexpected embedding shape for ${batch[i].id}: expected ${DIMENSIONS} numeric dimensions`);
    }

    pendingVectors.push({
      id: batch[i].id,
      values,
      metadata: {
        date: batch[i].date,
        source_text: batch[i].source_text
      }
    });
  }

  completed += batch.length;
  if (pendingVectors.length >= UPSERT_BATCH_SIZE || completed === rows.length) {
    await upsertVectors(pendingVectors);
    console.log(`Indexed ${completed}/${rows.length} windows.`);
    pendingVectors = [];
  }
}

console.log(`Cloudflare Vectorize indexing complete: ${rows.length}/${rows.length} windows upserted into ${indexName}.`);
console.log(`CLOUDFLARE_VECTORIZE_INDEX=${indexName}`);

async function ensureIndex() {
  const getUrl = `${apiBase()}/vectorize/v2/indexes/${encodeURIComponent(indexName)}`;
  const existing = await fetchWithRetry(getUrl, { headers: authHeaders() }, `get Vectorize index ${indexName}`, [404]);

  if (existing.status === 404) {
    console.log(`Vectorize index ${indexName} does not exist; creating it...`);
    const create = await fetchWithRetry(
      `${apiBase()}/vectorize/v2/indexes`,
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          name: indexName,
          description: "Rav-centered retrieval index for Q and A with the Dayan",
          config: { dimensions: DIMENSIONS, metric: METRIC }
        })
      },
      `create Vectorize index ${indexName}`
    );
    const created = await create.json();
    if (!created?.success) throw new Error(`Cloudflare did not report success creating ${indexName}: ${JSON.stringify(created)}`);
    console.log(`Created ${indexName} with ${DIMENSIONS} dimensions and ${METRIC} distance.`);
    return;
  }

  const body = await existing.json();
  if (!body?.success) throw new Error(`Cloudflare did not report success reading ${indexName}: ${JSON.stringify(body)}`);
  const config = body?.result?.config;
  if (config?.dimensions && Number(config.dimensions) !== DIMENSIONS) {
    throw new Error(`${indexName} has ${config.dimensions} dimensions; expected ${DIMENSIONS}`);
  }
  if (config?.metric && config.metric !== METRIC) {
    throw new Error(`${indexName} uses ${config.metric}; expected ${METRIC}`);
  }
  console.log(`Using existing Vectorize index ${indexName}.`);
}

async function embedTexts(texts) {
  const encodedModel = embeddingModel.split("/").map(encodeURIComponent).join("/");
  const response = await fetchWithRetry(
    `${apiBase()}/ai/run/${encodedModel}`,
    {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ text: texts })
    },
    `embed ${texts.length} archive windows`
  );
  const body = await response.json();
  if (!body?.success) throw new Error(`Workers AI embedding request failed: ${JSON.stringify(body)}`);

  const data = body?.result?.data ?? body?.result?.result?.data;
  if (!Array.isArray(data)) {
    throw new Error(`Workers AI embedding response did not contain result.data: ${JSON.stringify(body).slice(0, 1000)}`);
  }
  return Array.isArray(data[0]) ? data : [data];
}

async function upsertVectors(vectors) {
  const ndjson = vectors.map((vector) => JSON.stringify(vector)).join("\n") + "\n";
  const url = `${apiBase()}/vectorize/v2/indexes/${encodeURIComponent(indexName)}/upsert?unparsable-behavior=error`;

  let response = await postNdjsonFile(url, ndjson, "body");
  if (!response.ok && response.status === 400) {
    const firstBody = await response.text();
    console.warn(`Vectorize rejected multipart field 'body'; retrying documented legacy field 'vectors'. First response: ${firstBody.slice(0, 500)}`);
    response = await postNdjsonFile(url, ndjson, "vectors");
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`upsert ${vectors.length} vectors failed ${response.status}: ${body}`);
  }
  const body = await response.json();
  if (!body?.success) throw new Error(`Cloudflare did not report success upserting vectors: ${JSON.stringify(body)}`);
}

async function postNdjsonFile(url, ndjson, fieldName) {
  const form = new FormData();
  form.append(fieldName, new Blob([ndjson], { type: "application/x-ndjson" }), "vectors.ndjson");
  return fetchWithRetry(
    url,
    {
      method: "POST",
      headers: authHeaders(),
      body: form
    },
    `upsert Vectorize batch using ${fieldName}`,
    [400]
  );
}

function apiBase() {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`;
}

function authHeaders() {
  return { authorization: `Bearer ${apiToken}` };
}

async function fetchWithRetry(url, options, label, allowedStatuses = []) {
  let delayMs = 1500;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const response = await fetch(url, options);
    if (response.ok || allowedStatuses.includes(response.status)) return response;

    const body = await response.text();
    const retryable = [429, 500, 502, 503, 504].includes(response.status);
    if (!retryable || attempt === 6) {
      throw new Error(`${label} failed ${response.status}: ${body}`);
    }
    console.warn(`${label} got ${response.status}; retrying in ${delayMs / 1000}s...`);
    await sleep(delayMs);
    delayMs *= 2;
  }
  throw new Error(`${label} failed after retries`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
