const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const indexName = process.env.CLOUDFLARE_VECTORIZE_INDEX || "dayan-archive-v1";
const embeddingModel = process.env.CLOUDFLARE_EMBEDDING_MODEL || "@cf/qwen/qwen3-embedding-0.6b";
const topK = Number.parseInt(process.env.CLOUDFLARE_RAG_TOP_K || "8", 10) || 8;

if (!accountId) throw new Error("Set CLOUDFLARE_ACCOUNT_ID first");
if (!apiToken) throw new Error("Set CLOUDFLARE_API_TOKEN first");

const regressions = [
  {
    question: "This is a donut with chicken and cole slaw inside What bracha would this be?",
    needles: ["donut", "cole slaw", "chicken"]
  },
  {
    question: "Does chapstick need to be kosher?",
    needles: ["chapstick", "lip balm", "lip-balm"]
  }
];

console.log(`Running ${regressions.length} Vectorize retrieval checks against ${indexName} (topK=${topK})...`);

let passed = 0;
for (let index = 0; index < regressions.length; index++) {
  const regression = regressions[index];
  console.log(`\n--- Vectorize regression ${index + 1}/${regressions.length} ---`);
  console.log(`Question: ${regression.question}`);

  const vector = await embed(regression.question);
  const matches = await waitForMatches(vector);
  const texts = matches.map((match) => String(match?.metadata?.source_text || ""));
  const normalized = texts.join("\n").toLowerCase();
  const foundNeedle = regression.needles.find((needle) => normalized.includes(needle.toLowerCase()));

  for (const [rank, match] of matches.slice(0, 5).entries()) {
    const source = String(match?.metadata?.source_text || "").replace(/\s+/g, " ").slice(0, 280);
    console.log(`#${rank + 1} score=${Number(match?.score || 0).toFixed(4)} id=${match?.id || "?"} ${source}`);
  }

  if (foundNeedle) {
    passed++;
    console.log(`MATCH_FOUND: retrieved source contains '${foundNeedle}'.`);
  } else {
    console.warn(`NOT_FOUND: none of the top ${topK} results contained expected archive terms: ${regression.needles.join(", ")}`);
  }
}

console.log(`\nVectorize retrieval regression summary: ${passed}/${regressions.length} known questions reported MATCH_FOUND.`);
if (passed < regressions.length) process.exitCode = 2;

async function waitForMatches(vector) {
  let latest = [];
  for (let attempt = 1; attempt <= 12; attempt++) {
    latest = await query(vector);
    if (latest.length > 0) return latest;
    if (attempt < 12) {
      console.log(`No visible vectors yet; waiting 10s for asynchronous Vectorize indexing (${attempt}/12)...`);
      await sleep(10000);
    }
  }
  return latest;
}

async function embed(text) {
  const encodedModel = embeddingModel.split("/").map(encodeURIComponent).join("/");
  const response = await apiFetch(
    `${apiBase()}/ai/run/${encodedModel}`,
    {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ text: [text] })
    },
    "embed regression question"
  );
  const body = await response.json();
  const data = body?.result?.data ?? body?.result?.result?.data;
  if (!body?.success || !Array.isArray(data)) throw new Error(`Unexpected Workers AI response: ${JSON.stringify(body).slice(0, 1000)}`);
  return Array.isArray(data[0]) ? data[0] : data;
}

async function query(vector) {
  const response = await apiFetch(
    `${apiBase()}/vectorize/v2/indexes/${encodeURIComponent(indexName)}/query`,
    {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        vector,
        topK: Math.max(1, Math.min(20, topK)),
        returnValues: false,
        returnMetadata: "all"
      })
    },
    "query Vectorize regression"
  );
  const body = await response.json();
  if (!body?.success) throw new Error(`Unexpected Vectorize query response: ${JSON.stringify(body).slice(0, 1000)}`);
  return body?.result?.matches ?? [];
}

function apiBase() {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`;
}

function authHeaders() {
  return { authorization: `Bearer ${apiToken}` };
}

async function apiFetch(url, options, label) {
  let delayMs = 1500;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const response = await fetch(url, options);
    if (response.ok) return response;
    const body = await response.text();
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 6) {
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
