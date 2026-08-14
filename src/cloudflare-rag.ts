type ChatTurn = { role: "user" | "assistant"; text: string };

type WorkersAIResult = {
  data?: unknown;
  result?: { data?: unknown };
};

type WorkersAI = {
  run(model: string, input: Record<string, unknown>): Promise<WorkersAIResult>;
};

type VectorizeMatch = {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
};

type VectorizeIndex = {
  query(
    vector: number[],
    options?: {
      topK?: number;
      returnValues?: boolean;
      returnMetadata?: "none" | "indexed" | "all";
    }
  ): Promise<{ matches?: VectorizeMatch[] }>;
};

export interface CloudflareRagEnv {
  AI?: WorkersAI;
  DAYAN_VECTORIZE?: VectorizeIndex;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_ZDR?: string;
  CLOUDFLARE_EMBEDDING_MODEL?: string;
  CLOUDFLARE_RAG_TOP_K?: string;
}

const DEFAULT_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
const DEFAULT_OPENROUTER_MODEL = "deepseek/deepseek-v4-flash";
const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 20;

const NO_SOURCE_RESPONSE = `*Sources:*

No sufficiently relevant source found.

*Reasoning*:

*I cannot find this in the provided sources.*

Make sure the quoted source applies to your circumstances.`;

export async function askCloudflareRag(
  question: string,
  history: ChatTurn[],
  env: CloudflareRagEnv
): Promise<string> {
  if (!env.AI) throw new Error("Cloudflare RAG requires the AI binding");
  if (!env.DAYAN_VECTORIZE) throw new Error("Cloudflare RAG requires the DAYAN_VECTORIZE binding");
  if (!env.OPENROUTER_API_KEY?.trim()) throw new Error("Cloudflare RAG requires OPENROUTER_API_KEY");

  const embeddingModel = env.CLOUDFLARE_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  const openRouterModel = env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  const topK = parseTopK(env.CLOUDFLARE_RAG_TOP_K);

  console.log("askCloudflareRag start", {
    embeddingModel,
    openRouterModel,
    topK,
    zdr: env.OPENROUTER_ZDR?.trim().toLowerCase() !== "false"
  });

  const embeddingResult = await env.AI.run(embeddingModel, { text: [question] });
  const queryVector = extractFirstEmbedding(embeddingResult);

  const vectorResults = await env.DAYAN_VECTORIZE.query(queryVector, {
    topK,
    returnValues: false,
    returnMetadata: "all"
  });

  const candidates = (vectorResults.matches ?? [])
    .map((match) => {
      const sourceText = typeof match.metadata?.source_text === "string"
        ? match.metadata.source_text.trim()
        : "";
      const date = typeof match.metadata?.date === "string" ? match.metadata.date : "unknown";
      return { id: match.id, score: match.score, date, sourceText };
    })
    .filter((candidate) => candidate.sourceText.length > 0);

  console.log("Cloudflare Vectorize retrieval", {
    returned: vectorResults.matches?.length ?? 0,
    usable: candidates.length,
    scores: candidates.map((candidate) => Number(candidate.score.toFixed(4)))
  });

  if (!candidates.length) return NO_SOURCE_RESPONSE;

  const historyText = history.length
    ? history.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`).join("\n")
    : "(none)";

  const retrievedText = candidates
    .map(
      (candidate, index) =>
        `--- Retrieved archive candidate ${index + 1} | ${candidate.date} | similarity ${candidate.score.toFixed(4)} ---\n${candidate.sourceText}`
    )
    .join("\n\n");

  const prompt = buildPrompt(question, historyText, retrievedText);
  const answer = await callOpenRouter(prompt, openRouterModel, env);
  return normalizeAnswer(answer);
}

function buildPrompt(question: string, historyText: string, retrievedText: string): string {
  return `Role:
You are an expert Halachic assistant answering questions from the historical WhatsApp archive "Q and A with the Dayan".

Core Guideline:
Rely exclusively on the retrieved archive candidates supplied below. Do not use outside knowledge, assumptions, general Halachic reasoning, or prior model knowledge beyond what is explicitly supported by those candidates.

Archive Authority Rules:
- Messages labeled Rav Rosenfeld are the Dayan's answers and may be used as authoritative source material.
- Messages labeled Participant are questions or conversational context only. Never treat a Participant statement as the Halachic ruling or authority, even if it sounds confident.
- Retrieved candidates are search results, not automatically valid sources. Ignore candidates that do not actually support the user's question.
- You may synthesize multiple relevant Rav Rosenfeld answers when they directly address the user's issue, but every conclusion must be supported by the supplied archive material.
- The user's exact wording does NOT need to appear in the archive. A source may support the answer when it addresses the same issue, a clearly analogous case, or the relevant distinction or condition. Stay close to the source and make clear any condition or limitation.
- Do not invent a source, a ruling, a question-answer pairing, a citation, a date, or a factual detail that is not supported by the supplied archive material.
- The Rav Rosenfeld/Participant labels are internal source-validation labels. Do not turn them into visible narration such as "Rav Rosenfeld says," "Rav Rosenfeld ruled," "Rav Rosenfeld explained," or similar phrasing. Present the source exchange itself instead.

If the answer cannot be supported from the supplied material, do NOT create, paraphrase, or restate a Question/Answer source exchange just to say that no answer was found. Use exactly this no-source format:

*Sources:*
No sufficiently relevant source found.

*Reasoning*:
*I cannot find this in the provided sources.*

Make sure the quoted source applies to your circumstances.

How to Answer When Supporting Material Exists:
Use exactly the following structure and order:

*Sources:*

For each source exchange use:

*Question (YYYY-MM-DD)*: [Use the date only if that exact date is explicitly visible for the participant question in the supplied archive text. Otherwise use *Question*: with no date. Reproduce the question from the archive as it appears, or as close to verbatim as the supplied text permits.]

*Answer*: [Reproduce the Rav Rosenfeld answer from the archive as it appears, as close to verbatim as the supplied text permits. Do not rewrite it as narrator attribution.]

Include only the most relevant supporting material. Do not print a separate Date line.

*Reasoning*:

Begin with the final ruling or conclusion clearly and directly, using WhatsApp bold formatting with exactly one asterisk on each side. Then explain briefly how the quoted source material leads to that conclusion. Keep the conclusion and explanation together in this single Reasoning section. Do not create a separate Answer section.

Formatting Requirements:
- This response will be sent through WhatsApp.
- Use a single asterisk on each side for bold, like *bold text*.
- Never use double asterisks anywhere in the response.
- The Sources header must appear exactly once and must be written exactly as *Sources:*.
- Bold each Question label and each Answer label in Sources.
- Bold the Reasoning header as *Reasoning*:.
- Do not include an Answer section.
- Do not include an Additional Notes or Additional Information section.
- Keep the section order exactly: Sources, Reasoning.
- If no supporting source answer exists, do not display a Question or Answer entry at all; use only the no-source format above.

Closing Requirement:
End every response with this exact sentence:
"Make sure the quoted source applies to your circumstances."

Conversation Context:
Use prior turns only to understand follow-up questions and references. Prior assistant answers are not source evidence and must not substitute for the supplied archive material.

Prior conversation:
${historyText}

New user question:
${question}

Retrieved archive candidates:
${retrievedText}`;
}

async function callOpenRouter(
  prompt: string,
  model: string,
  env: CloudflareRagEnv
): Promise<string> {
  const enforceZdr = env.OPENROUTER_ZDR?.trim().toLowerCase() !== "false";
  const provider: Record<string, unknown> = { data_collection: "deny" };
  if (enforceZdr) provider.zdr = true;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "HTTP-Referer": "https://dayan-whatsapp-archive-bot.rotblatbz.workers.dev",
      "X-Title": "Dayan AI"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 1800,
      provider
    })
  });

  if (!response.ok) {
    const body = await response.text();
    console.error("OpenRouter API error", { status: response.status, body, model, enforceZdr });
    throw new Error(`OpenRouter ${response.status}: ${body}`);
  }

  const data: any = await response.json();
  console.log("OpenRouter usage", {
    model: data?.model ?? model,
    promptTokens: data?.usage?.prompt_tokens,
    completionTokens: data?.usage?.completion_tokens,
    totalTokens: data?.usage?.total_tokens,
    cost: data?.usage?.cost
  });

  return typeof data?.choices?.[0]?.message?.content === "string"
    ? data.choices[0].message.content.trim()
    : "";
}

function extractFirstEmbedding(result: WorkersAIResult): number[] {
  const raw = result?.data ?? result?.result?.data;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Workers AI embedding response did not contain data");
  }

  if (Array.isArray(raw[0])) {
    const vector = raw[0];
    if (!vector.every((value) => typeof value === "number")) {
      throw new Error("Workers AI embedding vector contained non-numeric values");
    }
    return vector as number[];
  }

  if (raw.every((value) => typeof value === "number")) return raw as number[];
  throw new Error("Workers AI embedding response had an unexpected shape");
}

function parseTopK(value?: string): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TOP_K;
  return Math.max(1, Math.min(MAX_TOP_K, parsed));
}

function normalizeAnswer(raw: string): string {
  let answer = raw.trim();
  if (!answer || /(?:^|\n)\*?Answer\*?:\s*I cannot find this in the provided sources\./i.test(answer)) {
    return NO_SOURCE_RESPONSE;
  }

  answer = answer.replace(/^(?:\*?Sources:\*?\s*\n*)+/i, "*Sources:*\n\n");
  if (!/^\*Sources:\*/i.test(answer)) {
    console.warn("OpenRouter answer did not start with Sources; normalizing to no-source response");
    return NO_SOURCE_RESPONSE;
  }

  return answer;
}
