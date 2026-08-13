interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface QueueBinding<T = unknown> {
  send(body: T): Promise<void>;
}

interface QueueMessage<T = unknown> {
  body: T;
  ack(): void;
  retry(): void;
}

interface MessageBatch<T = unknown> {
  queue: string;
  messages: QueueMessage<T>[];
}

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

type WhatsAppMessage = {
  from: string;
  id: string;
  type: string;
  text?: { body?: string };
};

type ChatTurn = { role: "user" | "assistant"; text: string };

const GRAPH_VERSION = "v26.0";
const GEMINI_MODEL = "gemini-3.6-flash";
const MAX_HISTORY_TURNS = 8;
const WHATSAPP_TEXT_LIMIT = 3900;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "GET") {
      return verifyWebhook(url, env);
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-hub-signature-256");

    if (!(await isValidMetaSignature(rawBody, signature, env.META_APP_SECRET))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    if (env.WEBHOOK_QUEUE) {
      await env.WEBHOOK_QUEUE.send(body);
    } else {
      const task = processWebhook(body, env).catch((error) => console.error("webhook error", error));
      ctx.waitUntil(task);
    }

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
      for (const message of change?.value?.messages ?? []) {
        messages.push(message);
      }
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
        await sendWhatsAppText(
          from,
          "Ask me a halacha question and I’ll answer only from the archived Q and A with the Dayan, with a clear conclusion, brief reasoning, and the most relevant supporting source Q&As. If I can’t find support in the archive, I’ll say so. Send /clear to reset conversational context.",
          env
        );
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
      await sendWhatsAppText(
        from,
        "I hit an error answering that. Please try again in a moment.",
        env
      );
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
    ? history.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n")
    : "(none)";

  const prompt = `Role:
You are an expert Halachic assistant answering questions from the historical WhatsApp archive "Q and A with the Dayan".

Core Guideline:
Rely exclusively on material retrieved from the provided archive. Do not use outside knowledge, assumptions, general Halachic reasoning, or prior model knowledge beyond what is explicitly supported by the sources.

Archive Authority Rules:
- Messages labeled Rav Rosenfeld are the Dayan's answers and may be used as authoritative source material.
- Messages labeled Participant are questions or conversational context only. Never treat a Participant statement as the Halachic ruling or authority, even if it sounds confident.
- You may synthesize multiple relevant Rav Rosenfeld answers when they directly address the user's issue, but every conclusion must be supported by retrieved source material.
- The user's exact wording does NOT need to appear in the archive. A source may support the answer when it addresses the same issue, a clearly analogous case, or the relevant distinction or condition. Stay close to the source and make clear any condition or limitation.
- Do not invent a source, a ruling, a question-answer pairing, a citation, or a factual detail that is not supported by the retrieved archive.
- The Rav Rosenfeld/Participant labels are internal source-validation labels. Do not turn them into visible narration such as "Rav Rosenfeld says," "Rav Rosenfeld ruled," "Rav Rosenfeld explained," or similar phrasing. Present the source exchange itself instead.

If the answer cannot be supported from the provided material, say clearly:
"I cannot find this in the provided sources."

Retrieval Guidance:
- Search by the underlying Halachic issue and useful synonyms, not only the user's exact wording.
- Use File Search efficiently. Avoid repeated near-duplicate searches or minor reformulations of the same query.
- Prefer one or a few targeted searches that retrieve enough context to answer. If the evidence remains insufficient after a few searches, stop searching and use the no-source response instead of repeatedly calling the tool.

How to Answer:
Write a clear, readable response, but base every conclusion directly on the retrieved sources.
Use exactly the following structure and order:

Sources:

Include only the most relevant supporting material. For each source exchange use:

*Question (YYYY-MM-DD)*: [If the participant question's exact date is explicitly visible in the retrieved archive, put that date in ISO format in parentheses immediately after the word Question, bold the entire Question-and-date label with WhatsApp single-asterisk formatting, then reproduce the question from the chat as it appears in the archive. Example: *Question (2023-02-19)*: Does lip-balm/chapstick require a kosher certification?]

*Question*: [If the participant question's exact date is not explicitly visible, use this form with no date. Do not infer or guess a date from a filename, week label, or nearby messages.]

*Answer*: [Reproduce the answer from the chat as it appears in the archive, as close to verbatim as the retrieved text allows. Do not rewrite it as "Rav Rosenfeld ruled/says/explained that..." and do not add narrator attribution. If the answer itself names another authority, such as Rav Schachter or Rav Belsky, preserve that normally.]

Do not print a separate Date line. The date, when available, belongs only inside the bold Question label. The Sources section should feel like reading the actual Q&A chat, not a summary written by a narrator.

*Reasoning*:

Begin with the final ruling or conclusion clearly and directly, using WhatsApp bold formatting with exactly one asterisk on each side, for example: *This is the conclusion.* Then explain briefly how the quoted source material leads to that conclusion. Keep the conclusion and explanation together in this single Reasoning section; do not create a separate Answer section. Write the reasoning directly and impersonally: explain the relevant rule, distinction, condition, or comparison itself. Do not frame the reasoning as "Rav Rosenfeld says," "Rav Rosenfeld explains," "Rav Rosenfeld ruled," or similar narrator language. When bolding important concepts or names of authorities that actually appear in the sources, use WhatsApp bold formatting with exactly one asterisk on each side.

Do not include an Additional Notes, Additional Information, or similar section. Any truly necessary qualification should be incorporated briefly into the Reasoning section; otherwise omit it.

Formatting Requirement:
- This response will be sent through WhatsApp.
- Use a single asterisk on each side for bold, like *bold text*.
- Never use double asterisks anywhere in the response.
- Bold each Question label and each Answer label in Sources.
- Bold the Reasoning header as *Reasoning*:.
- Do not include an Answer section.
- Do not include an Additional Notes or Additional Information section.
- Keep the section order exactly: Sources, Reasoning.

Closing Requirement:
End every response with this exact sentence:
"Make sure the quoted source applies to your circumstances."

Conversation Context:
Use prior turns only to understand follow-up questions and references. Prior assistant answers are not source evidence and must not substitute for retrieved archive material.

Prior conversation:
${historyText}

New user question:
${question}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/interactions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input: prompt,
        tools: [
          {
            type: "file_search",
            file_search_store_names: [env.GEMINI_FILE_SEARCH_STORE],
            top_k: 20
          }
        ]
      })
    }
  );

  console.log("Gemini response status", response.status);

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("Gemini API error", {
      status: response.status,
      body: errorBody,
      model: GEMINI_MODEL,
      fileSearchStore: env.GEMINI_FILE_SEARCH_STORE || "(missing)",
      hasApiKey: Boolean(env.GEMINI_API_KEY)
    });
    throw new Error(`Gemini ${response.status}: ${errorBody}`);
  }

  const data: any = await response.json();
  console.log("Gemini response shape", {
    keys: Object.keys(data ?? {}),
    stepTypes: Array.isArray(data?.steps) ? data.steps.map((step: any) => step?.type ?? "(missing)") : []
  });

  const modelOutputs = Array.isArray(data?.steps)
    ? data.steps.filter((step: any) => step?.type === "model_output")
    : [];
  console.log("Gemini model output shape", modelOutputs.map((step: any) => ({
    contentTypes: Array.isArray(step?.content) ? step.content.map((block: any) => block?.type ?? "(missing)") : [],
    hasText: Array.isArray(step?.content) ? step.content.map((block: any) => typeof block?.text === "string") : [],
    textLengths: Array.isArray(step?.content) ? step.content.map((block: any) => typeof block?.text === "string" ? block.text.length : 0) : [],
    annotationTypes: Array.isArray(step?.content)
      ? step.content.map((block: any) => Array.isArray(block?.annotations) ? block.annotations.map((annotation: any) => annotation?.type ?? "(missing)") : [])
      : []
  })));

  const textParts: string[] = [];
  const citations = new Map<string, { file: string; page?: number }>();

  for (const step of data?.steps ?? []) {
    if (step?.type !== "model_output") continue;
    for (const block of step?.content ?? []) {
      if (block?.type !== "text") continue;
      if (block.text) textParts.push(block.text);

      for (const annotation of block?.annotations ?? []) {
        if (annotation?.type !== "file_citation") continue;
        const file = annotation.file_name || "Source";
        const page = annotation.page_number ?? annotation.page_numbers?.[0];
        citations.set(`${file}:${page ?? ""}`, { file, page });
      }
    }
  }

  let answer = textParts.join("\n").trim();
  if (!answer) {
    answer = `Sources:

No sufficiently relevant source found.

*Reasoning*:

*I cannot find this in the provided sources.* The archive search did not return enough relevant source material to support an answer.

Make sure the quoted source applies to your circumstances.`;
  }

  if (citations.size > 0 && !/\bSources?:/i.test(answer)) {
    const citationLines = [...citations.values()]
      .slice(0, 6)
      .map((c) => `• ${c.file}${c.page ? `, p. ${c.page}` : ""}`);
    answer += `\n\nSources:\n${citationLines.join("\n")}`;
  }

  return answer;
}

async function getHistory(phone: string, env: Env): Promise<ChatTurn[]> {
  try {
    const raw = await env.CHAT_HISTORY.get(`chat:${phone}`);
    return raw ? (JSON.parse(raw) as ChatTurn[]) : [];
  } catch {
    return [];
  }
}

async function saveHistory(
  phone: string,
  existing: ChatTurn[],
  question: string,
  answer: string,
  env: Env
): Promise<void> {
  const updated: ChatTurn[] = [
    ...existing,
    { role: "user" as const, text: question },
    { role: "assistant" as const, text: answer }
  ].slice(-MAX_HISTORY_TURNS * 2);

  await env.CHAT_HISTORY.put(`chat:${phone}`, JSON.stringify(updated), {
    expirationTtl: 60 * 60 * 24 * 30
  });
}

async function markAsRead(messageId: string, env: Env): Promise<void> {
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId
      })
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("WhatsApp mark-read error", {
      status: response.status,
      body: errorBody,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || "(missing)",
      hasAccessToken: Boolean(env.WHATSAPP_ACCESS_TOKEN)
    });
  }
}

async function sendLongWhatsAppText(to: string, text: string, env: Env): Promise<void> {
  const chunks = chunkText(text, WHATSAPP_TEXT_LIMIT);
  for (const chunk of chunks) {
    await sendWhatsAppText(to, chunk, env);
  }
}

async function sendWhatsAppText(to: string, text: string, env: Env): Promise<void> {
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: text }
      })
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("WhatsApp API error", {
      status: response.status,
      body: errorBody,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || "(missing)",
      to,
      hasAccessToken: Boolean(env.WHATSAPP_ACCESS_TOKEN)
    });
    throw new Error(`WhatsApp ${response.status}: ${errorBody}`);
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
  const allowed = configured
    .split(",")
    .map(normalizePhone)
    .filter(Boolean);
  return allowed.includes(phone);
}

function normalizePhone(phone: string): string {
  return (phone || "").replace(/\D/g, "");
}

async function isValidMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string
): Promise<boolean> {
  if (!appSecret || !signatureHeader?.startsWith("sha256=")) return false;
  const expectedHex = signatureHeader.slice("sha256=".length).toLowerCase();

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody)
  );
  const actualHex = [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqualHex(actualHex, expectedHex);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
