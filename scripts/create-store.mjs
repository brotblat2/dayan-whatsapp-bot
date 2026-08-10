const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("Set GEMINI_API_KEY first");

const displayName = process.argv[2] || "notebooklm-whatsapp";
const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/fileSearchStores?key=${apiKey}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    displayName,
    embeddingModel: "models/gemini-embedding-2"
  })
});

if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
const data = await res.json();
console.log("Created File Search store:");
console.log(data.name);
console.log("\nSet this as GEMINI_FILE_SEARCH_STORE in your Worker secrets.");
