import fs from "node:fs";
import path from "node:path";

const apiKey = process.env.GEMINI_API_KEY;
const store = process.env.GEMINI_FILE_SEARCH_STORE;
if (!apiKey) throw new Error("Set GEMINI_API_KEY first");
if (!store) throw new Error("Set GEMINI_FILE_SEARCH_STORE first");

const inputs = process.argv.slice(2);
if (!inputs.length) throw new Error("Usage: npm run upload -- path/to/file-or-directory [...]");

const files = [];
for (const input of inputs) collectFiles(path.resolve(input), files);
files.sort();
if (!files.length) throw new Error("No files found to upload");
console.log(`Found ${files.length} file(s) to upload.`);

const fileByName = new Map(files.map((absolute) => [path.basename(absolute), absolute]));
const expectedNames = new Set(fileByName.keys());
const retryCounts = new Map();
const permanentlyFailed = new Set();
const maxDocumentRetries = 3;
let existingDocs = await listDocuments();
console.log(`Store currently contains ${existingDocs.size} document(s).`);

let queued = 0;
for (const [displayName, absolute] of fileByName) {
  const existing = existingDocs.get(displayName);
  if (existing?.state === "STATE_ACTIVE") {
    console.log(`Skipping ${displayName} (already indexed).`);
    continue;
  }
  if (existing && existing.state !== "STATE_FAILED") {
    console.log(`Leaving ${displayName} in ${existing.state || "STATE_PENDING"}; it will be monitored with the rest.`);
    continue;
  }
  if (existing?.state === "STATE_FAILED") {
    console.log(`Removing failed prior document for ${displayName} before retrying...`);
    await deleteDocument(existing.name);
    retryCounts.set(displayName, 1);
    await sleep(3000);
  }

  await uploadFile(absolute, displayName);
  queued++;
  await sleep(existing?.state === "STATE_FAILED" ? 5000 : 1500);
}

console.log(`Queued ${queued} new upload(s). Now waiting for the retrieval-v3 archive to finish indexing in parallel...`);

const started = Date.now();
const maxWaitMs = 2 * 60 * 60 * 1000;
let lastSummary = "";

while (true) {
  existingDocs = await listDocuments();
  const active = [];
  const pending = [];
  const failed = [];
  const missing = [];

  for (const name of expectedNames) {
    const doc = existingDocs.get(name);
    if (!doc) missing.push(name);
    else if (doc.state === "STATE_ACTIVE") active.push(name);
    else if (doc.state === "STATE_FAILED") failed.push(name);
    else pending.push(name);
  }

  const summary = `${active.length}/${expectedNames.size} retrieval-v3 active, ${pending.length} pending, ${failed.length} failed, ${missing.length} not visible yet`;
  if (summary !== lastSummary) {
    console.log(summary);
    if (pending.length && pending.length <= 10) console.log(`  pending: ${pending.join(", ")}`);
    if (failed.length) console.log(`  failed: ${failed.join(", ")}`);
    lastSummary = summary;
  }

  const retryableFailed = failed.filter((name) => !permanentlyFailed.has(name));
  if (retryableFailed.length) {
    console.log(`Retrying ${retryableFailed.length} failed document(s) one at a time with slower pacing...`);
    for (const displayName of retryableFailed) {
      const attempts = retryCounts.get(displayName) || 0;
      if (attempts >= maxDocumentRetries) {
        permanentlyFailed.add(displayName);
        console.warn(`${displayName} failed indexing ${attempts} time(s); leaving it failed so the rest of the archive and regression tests can complete.`);
        continue;
      }

      const doc = existingDocs.get(displayName);
      const absolute = fileByName.get(displayName);
      if (!doc || !absolute) continue;

      const nextAttempt = attempts + 1;
      console.log(`Retry ${nextAttempt}/${maxDocumentRetries} for ${displayName}...`);
      await deleteDocument(doc.name);
      await sleep(5000);
      await uploadFile(absolute, displayName);
      retryCounts.set(displayName, nextAttempt);
      await sleep(7000);
    }
    lastSummary = "";
    await sleep(15000);
    continue;
  }

  if (!pending.length && !missing.length) {
    if (failed.length) {
      console.warn(`Retrieval-v3 indexing completed with ${failed.length} persistently failed document(s): ${failed.join(", ")}`);
    } else {
      console.log("All retrieval-v3 archive documents are ACTIVE and searchable.");
    }
    console.log(`Usable retrieval-v3 coverage: ${active.length}/${expectedNames.size} documents active.`);
    break;
  }

  if (Date.now() - started > maxWaitMs) {
    console.warn(`Retrieval-v3 indexing timed out with ${active.length}/${expectedNames.size} active, ${pending.length} pending, ${failed.length} failed, and ${missing.length} missing. Continuing so regression tests can measure the searchable coverage already available.`);
    break;
  }

  await sleep(15000);
}

async function uploadFile(absolute, displayName) {
  const stat = fs.statSync(absolute);
  const mime = guessMime(displayName);
  const period = displayName.match(/^retrieval-v3-(\d{4}-W\d{2})\.md$/)?.[1] || "unknown";
  console.log(`Uploading ${displayName} with retrieval-v3 chunking...`);

  const start = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/upload/v1beta/${store}:uploadToFileSearchStore?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(stat.size),
        "X-Goog-Upload-Header-Content-Type": mime,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        displayName,
        mimeType: mime,
        customMetadata: [
          { key: "archive", stringValue: "dayan-whatsapp" },
          { key: "representation", stringValue: "retrieval-v3" },
          { key: "period", stringValue: period }
        ],
        chunkingConfig: {
          whiteSpaceConfig: {
            maxTokensPerChunk: 450,
            maxOverlapTokens: 180
          }
        }
      })
    },
    `start upload for ${displayName}`
  );

  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Google did not return x-goog-upload-url");

  await fetchWithRetry(
    uploadUrl,
    {
      method: "POST",
      headers: {
        "Content-Length": String(stat.size),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"
      },
      body: fs.readFileSync(absolute)
    },
    `finalize upload for ${displayName}`
  );
  console.log(`Queued ${displayName} for indexing.`);
}

async function fetchWithRetry(url, options, label) {
  let delayMs = 2000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res;
    const body = await res.text();
    if (![429, 500, 502, 503, 504].includes(res.status) || attempt === 6) {
      throw new Error(`${label} failed ${res.status}: ${body}`);
    }
    console.log(`${label} got ${res.status}; retrying in ${delayMs / 1000}s...`);
    await sleep(delayMs);
    delayMs *= 2;
  }
  throw new Error(`${label} failed after retries`);
}

async function listDocuments() {
  const byDisplayName = new Map();
  let pageToken = "";
  do {
    const params = new URLSearchParams({ pageSize: "20", key: apiKey });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/${store}/documents?${params}`,
      {},
      "list documents"
    );
    const data = await res.json();
    for (const doc of data.documents ?? []) {
      if (doc.displayName) byDisplayName.set(doc.displayName, doc);
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return byDisplayName;
}

async function deleteDocument(name) {
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/${name}?force=true&key=${encodeURIComponent(apiKey)}`,
    { method: "DELETE" },
    `delete failed document ${name}`
  );
  await res.text();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function guessMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ({
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".html": "text/html",
    ".htm": "text/html",
    ".csv": "text/csv",
    ".json": "application/json",
    ".xml": "text/xml",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  })[ext] || "application/octet-stream";
}

function collectFiles(input, out) {
  const stat = fs.statSync(input);
  if (stat.isFile()) {
    out.push(input);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(input)) collectFiles(path.join(input, entry), out);
}
