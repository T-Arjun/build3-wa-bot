# build3-wa-bot

WhatsApp bot for the build3 founders community — **founder search, profile view, and constraint-aware cofounder matching** over WhatsApp. A clean-room rebuild of the *core functions* of [build-3/founders-directory-platform](https://github.com/build-3/founders-directory-platform).

> **Read-only on the source.** Founders are synced *from* the platform's public API into our own Supabase DB every 6 hours. We never write back. New WhatsApp signups (a later phase) become native Supabase rows.

## What it does (MVP)

- **Search & discovery** — "find fintech founders in Bangalore" → filtered list.
- **Profile view** — "show me Varun" → profile card with photo; asks which one if the name is ambiguous.
- **Cofounder matching** — "find me a cofounder in fintech who can do sales" → AI extracts filters → Postgres pre-filters the pool → OpenAI scores it (the source platform's 7-factor prompt, reused) → top matches with scores + reasons.

The conversational engine is OpenAI tool-calling. It does **AI filter extraction** (not regex) and **clarifies before acting** when input is vague or ambiguous.

## Architecture

```
source platform  ──(GET /api/v1/getListedUsers, every 6h)──▶  sync worker ──▶  Supabase (Postgres + Storage)
                                                                                      ▲
WhatsApp user ◀──▶ Meta Cloud API ◀──▶ bot service (webhook → engine → tools) ───────┘
                                              │
                                              └──▶ OpenAI (engine + match scorer)
```

| Area | Files |
|------|-------|
| Config | `src/config/{env,supabase,openai}.js` |
| Sync (6h) | `src/sync/*` (`sourceClient`, `mapFounder`, `syncWorker`, `schedule`) |
| WhatsApp | `src/whatsapp/*` (`cloudApi`, `verifySignature`, `parseInbound`) |
| Engine | `src/bot/*` (`engine`, `tools`, `prompts`, `handler`, `conversation`, `format`) |
| Domain | `src/domain/*` (`founders`, `matching`, `matchingPrompt`, `enums`) |
| DB | `supabase/migrations/*.sql` |

## Setup

```bash
npm install
cp .env.example .env   # fill in the values
# apply supabase/migrations/*.sql to your Supabase project
npm run sync:dry        # verify source API access without writing
npm run sync            # one full sync
npm start               # start the webhook server
```

## Deploy

Dockerized for **Coolify** (`https://dash.build3.online`). Deploy to the *Experimental* project first, then *Build3 Projects*. Set all secrets from `.env.example` in Coolify. The 6-hour sync runs in-process via `node-cron`.

## Environment

See `.env.example`. Required: source API base + key, Supabase URL + service key, OpenAI key, and the Meta WhatsApp Cloud API credentials.
