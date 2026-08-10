import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const apiKey = process.env.GEMINI_API_KEY;
const input = process.argv[2];

if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Add it as a GitHub Codespaces secret, then restart/recreate the codespace.");
if (!input) throw new Error('Usage: node scripts/bootstrap-archive.mjs "WhatsApp Chat - Q and A with the Dayan.zip"');

const archive = path.resolve(input);
if (!fs.existsSync(archive)) throw new Error(`Archive not found: ${archive}`);

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

console.log("\n1/3 Preparing anonymized monthly archive files...\n");
run("python3", ["scripts/prepare-whatsapp-export.py", archive, "sources"]);

console.log("\n2/3 Creating Gemini File Search store...\n");
const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/fileSearchStores?key=${apiKey}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    displayName: "Q and A with the Dayan",
    embeddingModel: "models/gemini-embedding-2"
  })
});
if (!res.ok) throw new Error(`Create store failed ${res.status}: ${await res.text()}`);
const data = await res.json();
const store = data.name;
if (!store) throw new Error(`Google did not return a File Search store name: ${JSON.stringify(data)}`);
console.log(`Created ${store}`);

console.log("\n3/3 Uploading and indexing archive...\n");
run("node", ["scripts/upload-sources.mjs", "sources"], {
  ...process.env,
  GEMINI_FILE_SEARCH_STORE: store
});

console.log("\nDONE. Copy this exact value into the Cloudflare Worker secret named GEMINI_FILE_SEARCH_STORE:\n");
console.log(store);
console.log("\nThe raw WhatsApp ZIP and generated sources/ are gitignored and do not need to be committed.\n");
