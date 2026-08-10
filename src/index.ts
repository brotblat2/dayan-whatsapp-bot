interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
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

    // Acknowledge webhook events quickly. Work is completed in waitUntil.
    const task = processWebhook(body, env).catch((error) => console.error("webhook error", error));
    ctx.waitUntil(task);

    return new Response("EVENT_RECEIVED", { status: 200 });
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
          "Ask me a halacha question and I’ll search the archived Q and A with the Dayan. I answer from Rav Rosenfeld’s archived messages and will say when I don’t find a direct answer. Send /clear to reset conversational context.",
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
  const historyText = history.length
    ? history.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n")
    : "(none)";

  const prompt = `You are a retrieval assistant for the historical WhatsApp archive "Q and A with the Dayan". The indexed files are cleaned chronological exports of that group.\n\nRules:\n- Rav Rosenfeld messages are the Dayan/archive answers. Participant messages are questions or conversational context only; NEVER treat a participant message as the halachic authority just because it sounds confident.\n- Answer what Rav Rosenfeld said in the archive, not what you independently think the halacha is. Prefer wording such as "Rav Rosenfeld wrote..." or "In the archive...".\n- If there is no directly relevant Rav Rosenfeld answer in the retrieved sources, say that clearly. You may mention closely related archive material, but label it as related rather than a direct ruling.\n- Do not turn an old archive answer into a new individualized psak when the facts materially differ. If the archive does not directly cover the practical case, say so.\n- Preserve Hebrew/Aramaic text and cited sefarim/siman references when relevant.\n- Include the date of the archived answer when it is visible in the retrieved context.\n- Be concise and natural for WhatsApp.\n- When citations are available, add a short Sources section using the file names. These monthly file names identify the archive month.\n- Treat prior chat turns only as conversational context; factual claims about the archive must still be grounded in File Search.\n\nPrior conversation:\n${historyText}\n\nNew user message:\n${question}`;

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
            file_search_store_names: [env.GEMINI_FILE_SEARCH_STORE]
          }
        ]
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini ${response.status}: ${await response.text()}`);
  }

  const data: any = await response.json();
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
  if (!answer) answer = "I couldn't find enough in the sources to answer that.";

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
  await fetch(
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
    throw new Error(`WhatsApp ${response.status}: ${await response.text()}`);
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
