import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const apiKey = process.env.GEMINI_API_KEY;
const displayName = "Q and A with the Dayan";

if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Add it as a GitHub Actions secret.");

function findArchive() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const preferred = path.resolve("private-input/dayan-chat.zip");
  if (fs.existsSync(preferred)) return preferred;
  const dir = path.resolve("private-input");
  if (fs.existsSync(dir)) {
    const zips = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".zip")).sort();
    if (zips.length) return path.join(dir, zips[0]);
  }
  return preferred;
}

const archive = findArchive();
if (!fs.existsSync(archive)) {
  throw new Error("No archive found. Upload the WhatsApp export ZIP into private-input/ first.");
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

console.log(`\nUsing archive: ${archive}\n`);
console.log("1/3 Preparing anonymized monthly archive files...\n");
run("python3", ["scripts/prepare-whatsapp-export.py", archive, "sources"]);

console.log("\n2/3 Finding or creating Gemini File Search store...\n");
const store = process.env.GEMINI_FILE_SEARCH_STORE || await findLatestMatchingStore() || await createStore();
console.log(`Using ${store}`);

console.log("\n3/3 Uploading and indexing archive...\n");
run("node", ["scripts/upload-sources.mjs", "sources"], {
  ...process.env,
  GEMINI_FILE_SEARCH_STORE: store
});

console.log("\nDONE. Copy this exact value into the Cloudflare Worker secret named GEMINI_FILE_SEARCH_STORE:\n");
console.log(store);
console.log("\nThe generated sources/ directory remains gitignored. Keep this GitHub repository private because private-input/ contains the source chat archive.\n");

async function createStore() {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/fileSearchStores?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName,
      embeddingModel: "models/gemini-embedding-2"
    })
  });
  if (!res.ok) throw new Error(`Create store failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.name) throw new Error(`Google did not return a File Search store name: ${JSON.stringify(data)}`);
  console.log(`Created ${data.name}`);
  return data.name;
}

async function findLatestMatchingStore() {
  let pageToken = "";
  const matches = [];
  do {
    const params = new URLSearchParams({ pageSize: "20", key: apiKey });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/fileSearchStores?${params}`);
    if (!res.ok) throw new Error(`List stores failed ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const store of data.fileSearchStores ?? []) {
      if (store.displayName === displayName) matches.push(store);
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);

  if (!matches.length) return null;
  const latest = matches[matches.length - 1];
  console.log(`Found existing store ${latest.name} with ${latest.activeDocumentsCount || 0} active, ${latest.pendingDocumentsCount || 0} pending, ${latest.failedDocumentsCount || 0} failed document(s). Resuming it.`);
  return latest.name;
}
