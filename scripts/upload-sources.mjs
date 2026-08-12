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
  // Gentle pacing avoids bursting upload requests even on lower API tiers.
  await sleep(existing?.state === "STATE_FAILED" ? 5000 : 1500);
}

console.log(`Queued ${queued} new upload(s). Now waiting for the whole archive to finish indexing in parallel...`);

const started = Date.now();
const maxWaitMs = 2 * 60 * 60 * 1000; // two hours overall
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

  const summary = `${active.length}/${expectedNames.size} active, ${pending.length} pending, ${failed.length} failed, ${missing.length} not visible yet`;
  if (summary !== lastSummary) {
    console.log(summary);
    if (pending.length && pending.length <= 10) console.log(`  pending: ${pending.join(", ")}`);
    if (failed.length) console.log(`  failed: ${failed.join(", ")}`);
    lastSummary = summary;
  }

  if (active.length === expectedNames.size) {
    console.log("All archive documents are ACTIVE and searchable.");
    break;
  }

  if (failed.length) {
    console.log(`Retrying ${failed.length} failed document(s) one at a time with slower pacing...`);
    for (const displayName of failed) {
      const attempts = retryCounts.get(displayName) || 0;
      if (attempts >= maxDocumentRetries) {
        throw new Error(`${displayName} has failed indexing ${attempts} time(s) in this run. Stop and inspect that document before retrying again.`);
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
      // Deliberately slow retries to avoid another burst of indexing failures.
      await sleep(7000);
    }
    lastSummary = "";
    await sleep(15000);
    continue;
  }

  if (Date.now() - started > maxWaitMs) {
    throw new Error(`Archive still has ${pending.length} pending and ${missing.length} missing document(s) after two hours. Re-run safely; active files will be skipped and pending files will continue to be monitored.`);
  }

  await sleep(15000);
}

async function uploadFile(absolute, displayName) {
  const stat = fs.statSync(absolute);
  const mime = guessMime(displayName);
  console.log(`Uploading ${displayName}...`);

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
      body: JSON.stringify({ displayName })
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
  // Consume the body so keep-alive connections can be cleanly reused.
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
