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

for (const absolute of files) {
  const stat = fs.statSync(absolute);
  const displayName = path.basename(absolute);
  const mime = guessMime(displayName);
  console.log(`Uploading ${displayName}...`);

  const start = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/${store}:uploadToFileSearchStore?key=${apiKey}`,
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

  // uploadToFileSearchStore returns a long-running operation. Poll until indexing is complete.
  if (result?.name && result.done !== true && String(result.name).includes("/operations/")) {
    process.stdout.write("  indexing");
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const status = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${result.name}?key=${apiKey}`
      );
      if (!status.ok) throw new Error(`Operation poll failed ${status.status}: ${await status.text()}`);
      result = await status.json();
      if (result.done) break;
      process.stdout.write(".");
    }
    process.stdout.write("\n");
    if (!result.done) throw new Error(`Indexing timed out for ${displayName}`);
    if (result.error) throw new Error(`Indexing failed for ${displayName}: ${JSON.stringify(result.error)}`);
  }

  console.log(`Indexed ${displayName}`);
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
