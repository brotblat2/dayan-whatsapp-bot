interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; }
interface QueueBinding<T = unknown> { send(body: T): Promise<void>; }
interface QueueMessage<T = unknown> { body: T; ack(): void; retry(): void; }
interface MessageBatch<T = unknown> { queue: string; messages: QueueMessage<T>[]; }
interface Env {
  META_VERIFY_TOKEN: string;
  META_APP_SECRET: string;
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  GEMINI_API_KEY: string;
  GEMINI_FILE_SEARCH_STORE: string;
  ALLOWED_PHONE_NUMBERS?: string;
  CHAT_HISTORY: KVNamespace;
  WEBHOOK_QUEUE?: QueueBinding<any>;
}
type WhatsAppMessage = { from: string; id: string; type: string; text?: { body?: string } };
type ChatTurn = { role: "user" | "assistant"; text: string };
type RetrievalPlan = {
  core_issue: string;
  factual_dimensions: string[];
  concepts: string[];
  alternate_terms: string[];
  search_queries: string[];
};

const GRAPH_VERSION = "v26.0";
const GEMINI_MODEL = "gemini-3.6-flash";
const MAX_HISTORY_TURNS = 8;
const WHATSAPP_TEXT_LIMIT = 3900;
const CLOSING_SENTENCE = "Make sure the quoted source applies to your circumstances.";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname !== "/webhook") return new Response("Not found", { status: 404 });
    if (request.method === "GET") return verifyWebhook(url, env);
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const rawBody = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    if (!(await isValidMetaSignature(rawBody, signature, env.META_APP_SECRET))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let body: any;
    try { body = JSON.parse(rawBody); }
    catch { return new Response("Bad JSON", { status: 400 }); }

    if (env.WEBHOOK_QUEUE) await env.WEBHOOK_QUEUE.send(body);
    else ctx.waitUntil(processWebhook(body, env).catch((error) => console.error("webhook error", error)));
    return new Response("EVENT_RECEIVED", { status: 200 });
  },

  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        console.log(`Processing queued WhatsApp webhook from ${batch.queue}`);
        await processWebhook(message.body, env);
        message.ack();
      } catch (error) {
        console.error("queue processing error", error);
        message.retry();
      }
    }
  }
};

function verifyWebhook(url: URL, env: Env): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === env.META_VERIFY_TOKEN && challenge) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

async function processWebhook(body: any, env: Env): Promise<void> {
  const messages: WhatsAppMessage[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const message of change?.value?.messages ?? []) messages.push(message);
    }
  }

  for (const message of messages) {
    if (message.type !== "text" || !message.text?.body?.trim()) continue;
    const from = normalizePhone(message.from);
    if (!isAllowed(from, env.ALLOWED_PHONE_NUMBERS)) {
      console.warn(`Ignoring message from non-allowed number ${from}`);
      continue;
    }

    const question = message.text.body.trim();
    try {
      await markAsRead(message.id, env);
      if (/^\/?help$/i.test(question)) {
        await sendWhatsAppText(from, "Ask me a halacha question and I’ll analyze it, search the archived Q and A with the Dayan from several angles, and answer only from Rav Rosenfeld's archived responses. I include the most relevant supporting Q&As and say clearly when the archive does not support an answer. Send /clear to reset conversational context.", env);
        continue;
      }
      if (/^\/?clear$/i.test(question)) {
        await env.CHAT_HISTORY.put(`chat:${from}`, "[]", { expirationTtl: 60 * 60 * 24 * 30 });
        await sendWhatsAppText(from, "Conversation context cleared.", env);
        continue;
      }

      const history = await getHistory(from, env);
      const answer = await askGemini(question, history, env);
      await sendLongWhatsAppText(from, answer, env);
      await saveHistory(from, history, question, answer, env);
    } catch (error) {
      console.error(error);
      await sendWhatsAppText(from, "I hit an error answering that. Please try again in a moment.", env);
    }
  }
}

async function askGemini(question: string, history: ChatTurn[], env: Env): Promise<string> {
  console.log("askGemini start", {
    model: GEMINI_MODEL,
    hasApiKey: Boolean(env.GEMINI_API_KEY),
    hasFileSearchStore: Boolean(env.GEMINI_FILE_SEARCH_STORE)
  });

  const historyText = history.length
    ? history.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`).join("\n")
    : "(none)";

  const plan = await buildRetrievalPlan(question, historyText, env);
  const queries = makeQueries(question, plan);
  console.log("retrieval plan", {
    factualDimensions: plan.factual_dimensions.length,
    concepts: plan.concepts.length,
    alternateTerms: plan.alternate_terms.length,
    queryCount: queries.length
  });

  const settled = await Promise.allSettled(
    queries.map((query, i) => retrieveEvidence(query, question, plan, i, env))
  );
  const evidence = settled
    .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
    .map((result) => result.value)
    .filter(Boolean);
  for (const result of settled) {
    if (result.status === "rejected") console.error("retrieval branch error", result.reason);
  }
  console.log("retrieval summary", { attempted: settled.length, succeeded: evidence.length, lengths: evidence.map((x) => x.length) });
  if (!evidence.length) throw new Error("All Gemini retrieval branches failed");

  const answer = await synthesize(question, historyText, plan, evidence, env);
  return ensureClosingSentence(answer || noSourceAnswer());
}

async function buildRetrievalPlan(question: string, historyText: string, env: Env): Promise<RetrievalPlan> {
  const prompt = `You are a SEARCH PLANNER for a closed Orthodox Jewish Halachic WhatsApp Q&A archive. Do NOT answer the question or decide the ruling. Use general Halachic vocabulary only to make archive retrieval better.

Identify the narrow issue, concrete facts that may matter, useful Halachic topic terms, Hebrew/Yeshivish/transliteration variants, synonyms, and at most TWO concise search queries. Preserve the user's concrete facts. The exact user wording must remain useful even if terminology is expanded.

Prior conversation is only for resolving follow-up references:
${historyText}

User question:
${question}`;

  try {
    const data = await gemini({
      model: GEMINI_MODEL,
      input: prompt,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: {
          type: "object",
          properties: {
            core_issue: { type: "string" },
            factual_dimensions: { type: "array", items: { type: "string" } },
            concepts: { type: "array", items: { type: "string" } },
            alternate_terms: { type: "array", items: { type: "string" } },
            search_queries: { type: "array", items: { type: "string" } }
          },
          required: ["core_issue", "factual_dimensions", "concepts", "alternate_terms", "search_queries"]
        }
      }
    }, env, "query-plan");
    const raw = JSON.parse(outputText(data) || "{}");
    return {
      core_issue: cleanString(raw.core_issue) || question,
      factual_dimensions: cleanArray(raw.factual_dimensions, 8),
      concepts: cleanArray(raw.concepts, 10),
      alternate_terms: cleanArray(raw.alternate_terms, 14),
      search_queries: cleanArray(raw.search_queries, 2)
    };
  } catch (error) {
    console.error("query-plan error; falling back to literal query", error);
    return { core_issue: question, factual_dimensions: [], concepts: [], alternate_terms: [], search_queries: [] };
  }
}

function makeQueries(question: string, plan: RetrievalPlan): string[] {
  const candidates = [question, ...plan.search_queries];
  if (candidates.length < 3) {
    const expanded = [plan.core_issue, ...plan.factual_dimensions, ...plan.concepts, ...plan.alternate_terms]
      .filter(Boolean).join("; ");
    if (expanded) candidates.push(expanded);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of candidates) {
    const text = cleanString(value);
    const key = text.toLowerCase().replace(/\s+/g, " ");
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === 3) break;
  }
  return out.length ? out : [question];
}

async function retrieveEvidence(query: string, originalQuestion: string, plan: RetrievalPlan, index: number, env: Env): Promise<string> {
  const hints = [...plan.concepts, ...plan.alternate_terms].slice(0, 14).join(", ");
  const basePrompt = `You are the SOURCE RETRIEVAL stage for the historical WhatsApp archive "Q and A with the Dayan". DO NOT answer the Halachic question.

Use File Search EXACTLY ONCE, then report the best archive evidence from that one search. Prioritize exact or near-exact occurrences of the user's wording, then the same narrow issue. Only messages labeled Rav Rosenfeld are authoritative answers; Participant messages are question/context. Preserve enough chronological context to know what Rav Rosenfeld was answering. Return up to 6 useful matches with timestamps when visible. Do not invent source text. If nothing relevant was retrieved, return exactly NO_RELEVANT_SOURCE.

Original question:
${originalQuestion}

Search query for this branch:
${query}

Search hints only, not evidence:
${hints || "(none)"}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const input = attempt === 1
      ? basePrompt
      : `The previous request exceeded the tool-call limit. Make EXACTLY ONE File Search call and then stop.\n\n${basePrompt}`;
    try {
      const data = await gemini({
        model: GEMINI_MODEL,
        input,
        tools: [{ type: "file_search", file_search_store_names: [env.GEMINI_FILE_SEARCH_STORE], top_k: 25 }]
      }, env, `retrieval-${index + 1}-${attempt}`);
      const text = outputText(data).trim() || "NO_RELEVANT_SOURCE";
      console.log("retrieval output", { branch: index + 1, attempt, textLength: text.length });
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 1 && /too many tool calls|Model generated function call\(s\)/i.test(message)) {
        console.warn("retrieval tool-call limit; retrying once", { branch: index + 1 });
        continue;
      }
      throw error;
    }
  }
  return "NO_RELEVANT_SOURCE";
}

async function synthesize(question: string, historyText: string, plan: RetrievalPlan, evidence: string[], env: Env): Promise<string> {
  const packet = evidence.map((text, i) => `===== RETRIEVAL ${i + 1} =====\n${text}`).join("\n\n");
  const prompt = `Role:
You are an expert Halachic assistant. Answer ONLY from the retrieved archive evidence below from "Q and A with the Dayan".

Core Guideline:
Do not use outside knowledge, assumptions, or general Halachic reasoning beyond what the retrieved Rav Rosenfeld messages support. Only Rav Rosenfeld messages are authoritative. Participant messages are questions/context. Search-plan terms are not evidence. Deduplicate repeated retrievals. Prefer a direct exact/near-exact Q&A over loose analogies. Use an analogy only when the retrieved Rav material itself supports the relevant distinction. Never invent a ruling, quote, pairing, date, or factual detail. If the evidence does not support an answer, say "I cannot find this in the provided sources."

Use exactly this structure:

Answer:

[State the final ruling or conclusion clearly and directly in bold.]

Reasoning:

Explain briefly how the sources lead to the conclusion. Bold important concepts and names of authorities where useful.

Sources:

Question: [The question as it appears, or a faithful paraphrase]

Answer: [Rav Rosenfeld's answer, quoted or accurately summarized]

Additional Notes:

Present important conditions, distinctions, or multiple opinions. If none, write "None."

End every response exactly with:
"${CLOSING_SENTENCE}"

Prior conversation is context only, never source evidence:
${historyText}

User question:
${question}

Retrieval-planner summary is a search aid only, not evidence:
${plan.core_issue}; ${plan.factual_dimensions.join("; ")}

ARCHIVE EVIDENCE:
${packet}`;

  const data = await gemini({ model: GEMINI_MODEL, input: prompt }, env, "final-synthesis");
  return outputText(data).trim() || noSourceAnswer();
}

async function gemini(payload: any, env: Env, label: string): Promise<any> {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(payload)
  });
  console.log(`Gemini ${label} status`, response.status);
  if (!response.ok) {
    const body = await response.text();
    console.error(`Gemini ${label} API error`, { status: response.status, body, model: GEMINI_MODEL, hasApiKey: Boolean(env.GEMINI_API_KEY), hasFileSearchStore: Boolean(env.GEMINI_FILE_SEARCH_STORE) });
    throw new Error(`Gemini ${label} ${response.status}: ${body}`);
  }
  const data = await response.json();
  console.log(`Gemini ${label} response shape`, { stepTypes: Array.isArray(data?.steps) ? data.steps.map((step: any) => step?.type) : [] });
  return data;
}

function outputText(data: any): string {
  const parts: string[] = [];
  for (const step of data?.steps ?? []) {
    if (step?.type !== "model_output") continue;
    for (const block of step?.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

function cleanString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function cleanArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = cleanString(item);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === max) break;
  }
  return out;
}

function noSourceAnswer(): string {
  return `Answer:\n\n**I cannot find this in the provided sources.**\n\nReasoning:\n\nThe archive search did not return enough relevant Rav Rosenfeld source material to support an answer.\n\nSources:\n\nNo sufficiently relevant source found.\n\nAdditional Notes:\n\nNone.\n\n${CLOSING_SENTENCE}`;
}
function ensureClosingSentence(answer: string): string {
  const text = answer.trim();
  if (!text) return noSourceAnswer();
  return text.endsWith(CLOSING_SENTENCE) ? text : `${text}\n\n${CLOSING_SENTENCE}`;
}

async function getHistory(phone: string, env: Env): Promise<ChatTurn[]> {
  try {
    const raw = await env.CHAT_HISTORY.get(`chat:${phone}`);
    return raw ? JSON.parse(raw) as ChatTurn[] : [];
  } catch { return []; }
}
async function saveHistory(phone: string, existing: ChatTurn[], question: string, answer: string, env: Env): Promise<void> {
  const updated: ChatTurn[] = [...existing, { role: "user" as const, text: question }, { role: "assistant" as const, text: answer }].slice(-MAX_HISTORY_TURNS * 2);
  await env.CHAT_HISTORY.put(`chat:${phone}`, JSON.stringify(updated), { expirationTtl: 60 * 60 * 24 * 30 });
}

async function markAsRead(messageId: string, env: Env): Promise<void> {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId })
  });
  if (!response.ok) console.error("WhatsApp mark-read error", { status: response.status, body: await response.text(), phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || "(missing)", hasAccessToken: Boolean(env.WHATSAPP_ACCESS_TOKEN) });
}
async function sendLongWhatsAppText(to: string, text: string, env: Env): Promise<void> {
  for (const chunk of chunkText(text, WHATSAPP_TEXT_LIMIT)) await sendWhatsAppText(to, chunk, env);
}
async function sendWhatsAppText(to: string, text: string, env: Env): Promise<void> {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: text } })
  });
  if (!response.ok) {
    const body = await response.text();
    console.error("WhatsApp API error", { status: response.status, body, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || "(missing)", to, hasAccessToken: Boolean(env.WHATSAPP_ACCESS_TOKEN) });
    throw new Error(`WhatsApp ${response.status}: ${body}`);
  }
}

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n", max);
    if (cut < max * 0.6) cut = remaining.lastIndexOf(" ", max);
    if (cut < max * 0.6) cut = max;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
function isAllowed(phone: string, configured?: string): boolean {
  if (!configured?.trim()) return true;
  return configured.split(",").map(normalizePhone).filter(Boolean).includes(phone);
}
function normalizePhone(phone: string): string { return (phone || "").replace(/\D/g, ""); }

async function isValidMetaSignature(rawBody: string, signatureHeader: string | null, appSecret: string): Promise<boolean> {
  if (!appSecret || !signatureHeader?.startsWith("sha256=")) return false;
  const expectedHex = signatureHeader.slice("sha256=".length).toLowerCase();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const actualHex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return timingSafeEqualHex(actualHex, expectedHex);
}
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
