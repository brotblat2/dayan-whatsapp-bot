const apiKey = process.env.GEMINI_API_KEY;
const store = process.env.GEMINI_FILE_SEARCH_STORE;
if (!apiKey) throw new Error("Set GEMINI_API_KEY first");
if (!store) throw new Error("Set GEMINI_FILE_SEARCH_STORE first");

const regressionQuestions = [
  "This is a donut with chicken and cole slaw inside What bracha would this be?",
  "Does chapstick need to be kosher?"
];

console.log(`\nRunning ${regressionQuestions.length} known-question retrieval checks against retrieval-v3 in ${store}...\n`);

let foundCount = 0;
for (let i = 0; i < regressionQuestions.length; i++) {
  const question = regressionQuestions[i];
  console.log(`--- Retrieval regression ${i + 1}/${regressionQuestions.length} ---`);
  const result = await findKnownQuestion(question, i + 1);
  console.log(result);
  if (/^MATCH_FOUND\b/m.test(result)) foundCount++;
  console.log();
}

console.log(`Retrieval regression summary: ${foundCount}/${regressionQuestions.length} known questions reported MATCH_FOUND.`);
if (foundCount < regressionQuestions.length) {
  console.warn("One or more known questions were not directly surfaced. The retrieval-v3 index is searchable, but retrieval still needs tuning before claiming the regression is fixed.");
}

async function findKnownQuestion(question, testNumber) {
  const basePrompt = `This is a retrieval regression test for a closed WhatsApp archive.\n\nUse File Search EXACTLY ONCE. Search for the following known archive question, prioritizing its literal wording and distinctive phrases. Do not answer the Halachic question.\n\nKNOWN QUESTION:\n${question}\n\nIf the retrieved archive contains this exact question or a clearly near-exact occurrence, begin your response with MATCH_FOUND and then reproduce the participant question plus the nearby Rav Rosenfeld response/context with timestamps when visible.\n\nIf the single search does not surface the known question, respond exactly NOT_FOUND. Do not infer from general knowledge.`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1
      ? basePrompt
      : `The previous request exceeded the tool-call limit. You MUST make exactly one File Search call and then stop.\n\n${basePrompt}`;

    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        input: prompt,
        tools: [{
          type: "file_search",
          file_search_store_names: [store],
          metadata_filter: 'representation="retrieval-v3"',
          top_k: 30
        }]
      })
    });

    if (!response.ok) {
      const body = await response.text();
      const tooMany = /too many tool calls|Model generated function call\(s\)/i.test(body);
      if (attempt === 1 && tooMany) {
        console.warn(`Regression ${testNumber}: tool-call limit hit; retrying once.`);
        continue;
      }
      throw new Error(`Regression ${testNumber} Gemini ${response.status}: ${body}`);
    }

    const data = await response.json();
    const text = extractText(data).trim();
    return text || "NOT_FOUND";
  }
  return "NOT_FOUND";
}

function extractText(data) {
  const parts = [];
  for (const step of data?.steps ?? []) {
    if (step?.type !== "model_output") continue;
    for (const block of step?.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}
