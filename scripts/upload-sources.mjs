import fs from "node:fs";
import path from "node:path";

const apiKey = process.env.GEMINI_API_KEY;
const store = process.env.GEMINI_FILE_SEARCH_STORE;
if (!apiKey) throw new Error("Set GEMINI_API_KEY first");
if (!store) throw new Error("Set GEMINI_FILE_SEARCH_STORE first");

const inputs = process.argv.slice(2);
if (!inputs.length) {
  throw new Error("Usage: npm run upload -- path/to/file-or-directory [...]");
}

const files = [];
for (const input of inputs) collectFiles(path.resolve(input), files);
files.sort();
if (!files.length) throw new Error("No files found to upload");
console.log(`Found ${files.length} file(s) to upload.`);

const existingDocs = await listDocuments();
console.log(`Store currently contains ${existingDocs.size} document(s).`);

for (const absolute of files) {
  const stat = fs.statSync(absolute);
  const displayName = path.basename(absolute);
  const mime = guessMime(displayName);

  const existing = existingDocs.get(displayName);
  if (existing) {
    const state = await waitForExistingDocument(existing, displayName);
    if (state === "STATE_ACTIVE") {
      console.log(`Skipping ${displayName} (already indexed).`);
      continue;
    }
    if (state === "STATE_FAILED") {
      console.log(`Removing failed prior document for ${displayName} before retrying...`);
      await deleteDocument(existing.name);
      existingDocs.delete(displayName);
    }
  }

  console.log(`Uploading ${displayName}...`);

  const start = await fetch(
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
    }
  );

  if (!start.ok) throw new Error(`Start upload failed ${start.status}: ${await start.text()}`);
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Google did not return x-goog-upload-url");

  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(stat.size),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize"
    },
    body: fs.readFileSync(absolute)
  });

  if (!upload.ok) throw new Error(`Upload failed ${upload.status}: ${await upload.text()}`);
  let result = await upload.json();

  // Gemini File Search indexing is a long-running operation. Some files can take
  // several minutes, especially on the free tier, so allow up to 30 minutes.
  if (result?.name && result.done !== true && String(result.name).includes("/operations/")) {
    process.stdout.write("  indexing");
    const maxAttempts = 360; // 360 * 5s = 30 minutes
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(5000);
      const status = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${result.name}?key=${encodeURIComponent(apiKey)}`
      );
      if (!status.ok) throw new Error(`Operation poll failed ${status.status}: ${await status.text()}`);
      result = await status.json();
      if (result.done) break;
      if (attempt % 6 === 5) process.stdout.write("."); // one dot every ~30 seconds
    }
    process.stdout.write("\n");
    if (!result.done) throw new Error(`Indexing still not complete after 30 minutes for ${displayName}`);
    if (result.error) throw new Error(`Indexing failed for ${displayName}: ${JSON.stringify(result.error)}`);
  }

  console.log(`Indexed ${displayName}`);
  await refreshDocument(displayName, existingDocs);
}

async function listDocuments() {
  const byDisplayName = new Map();
  let pageToken = "";
  do {
    const params = new URLSearchParams({ pageSize: "20", key: apiKey });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${store}/documents?${params}`
    );
    if (!res.ok) throw new Error(`List documents failed ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const doc of data.documents ?? []) {
      if (doc.displayName) byDisplayName.set(doc.displayName, doc);
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return byDisplayName;
}

async function refreshDocument(displayName, map) {
  const docs = await listDocuments();
  const doc = docs.get(displayName);
  if (doc) map.set(displayName, doc);
}

async function waitForExistingDocument(doc, displayName) {
  let current = doc;
  if (current.state === "STATE_ACTIVE" || current.state === "STATE_FAILED") return current.state;

  console.log(`${displayName} already exists in state ${current.state || "UNKNOWN"}; waiting for it instead of uploading a duplicate...`);
  for (let attempt = 0; attempt < 180; attempt++) { // up to 30 minutes
    await sleep(10000);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${current.name}?key=${encodeURIComponent(apiKey)}`
    );
    if (!res.ok) throw new Error(`Document poll failed ${res.status}: ${await res.text()}`);
    current = await res.json();
    if (current.state === "STATE_ACTIVE" || current.state === "STATE_FAILED") return current.state;
  }
  throw new Error(`Existing document is still pending after 30 minutes: ${displayName}`);
}

async function deleteDocument(name) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${name}?force=true&key=${encodeURIComponent(apiKey)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`Delete failed document failed ${res.status}: ${await res.text()}`);
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
  for (const entry of fs.readdirSync(input)) {
    collectFiles(path.join(input, entry), out);
  }
}
