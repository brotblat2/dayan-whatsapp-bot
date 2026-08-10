# Q and A with the Dayan — WhatsApp bot

A private WhatsApp bot that searches the historical **Q and A with the Dayan** chat and answers from **Rav Rosenfeld's archived messages**.

## Archive privacy

The WhatsApp archive itself is intentionally **not committed to GitHub**, even though this repository is private. `sources/`, `private-input/`, and `*.zip` are gitignored.

The supplied export through **August 10, 2026** produced 60 monthly files containing 10,952 substantive text messages, including 5,461 Rav Rosenfeld messages. To regenerate those local source files, run the importer against your WhatsApp export as shown below. Participant sender labels are anonymized; Rav Rosenfeld is preserved by name so the retrieval prompt can distinguish his answers from group discussion.

## Architecture

WhatsApp → Meta WhatsApp Cloud API → Cloudflare Worker → Gemini File Search → WhatsApp reply

The Worker keeps a small rolling conversation history in Cloudflare KV for follow-up questions. The model is instructed to treat only Rav Rosenfeld's messages as archive answers and participant messages as question/context.

## 1. Install

```bash
npm install
npx wrangler login
```

## 2. Create the File Search store

Get a Gemini API key, then:

```bash
export GEMINI_API_KEY="..."
npm run create-store -- "Q and A with the Dayan"
```

Copy the returned value such as `fileSearchStores/...`.

## 3. Prepare and index the archive

Keep the WhatsApp export outside the repository, then generate the local `sources/` directory:

```bash
npm run prepare-chat -- "/path/to/WhatsApp Chat - Q and A with the Dayan.zip"
```

Then upload those generated files to Gemini File Search:

```bash
export GEMINI_FILE_SEARCH_STORE="fileSearchStores/..."
npm run upload -- ./sources
```

The uploader accepts files or directories and waits for each File Search indexing operation to complete. The generated `sources/` directory is gitignored.

## 4. Create Cloudflare KV

```bash
npx wrangler kv namespace create CHAT_HISTORY
```

Put the returned namespace ID into `wrangler.jsonc` where it says `REPLACE_WITH_KV_NAMESPACE_ID`.

## 5. Add Worker secrets

```bash
npx wrangler secret put META_VERIFY_TOKEN
npx wrangler secret put META_APP_SECRET
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GEMINI_FILE_SEARCH_STORE
npx wrangler secret put ALLOWED_PHONE_NUMBERS
```

For `ALLOWED_PHONE_NUMBERS`, use comma-separated international numbers without `+`, for example:

```text
12125551234,19175551234
```

If you omit the allowlist, anyone who can reach the WhatsApp Business number can query the bot.

## 6. Deploy

```bash
npm run deploy
```

The webhook URL will be:

```text
https://<your-worker>.workers.dev/webhook
```

Health check:

```text
https://<your-worker>.workers.dev/health
```

## 7. Configure Meta WhatsApp

In the WhatsApp configuration for your Meta developer app:

- Callback URL: `https://<your-worker>.workers.dev/webhook`
- Verify token: same value as `META_VERIFY_TOKEN`
- Subscribe to the `messages` webhook field

Then WhatsApp the configured number directly.

## Bot behavior

- Normal message: searches the archive and replies from Rav Rosenfeld's material.
- `help` or `/help`: explains the bot.
- `clear` or `/clear`: clears conversational follow-up context.
- If no direct Rav Rosenfeld answer is found, the bot says so rather than treating another participant's answer as authoritative.
- The archive is historical. The prompt explicitly avoids converting an old answer into a new personalized psak when the facts materially differ.

## Updating the archive later

Export the WhatsApp chat again and run:

```bash
npm run prepare-chat -- "/path/to/WhatsApp Chat - Q and A with the Dayan.zip"
```

That recreates `sources/` from the newer export with participant sender labels anonymized. Then upload the regenerated source directory to your File Search store. For a clean replacement rather than duplicate versions, create a fresh store and point `GEMINI_FILE_SEARCH_STORE` at it.

## Notes

- Meta webhook signatures are verified with `META_APP_SECRET`.
- The bot currently handles text messages sent to the WhatsApp Business number.
- Long answers are split into WhatsApp-safe chunks.
- Conversation context expires after 30 days.
- The original NotebookLM URL is no longer required at runtime; this project indexes the actual WhatsApp archive directly.
