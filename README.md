# Maverick LED knowledge base (test)

A prototype that turns the public content of maverickled.com into a knowledge base and puts a chat window on top of it. Anyone on the team can ask product questions and get answers that link to the product page or spec sheet they came from.

## Run it

You need Node.js 24 or later.

1. `npm install`
2. Optional: copy `.env.example` to `.env` and put an Anthropic API key after `ANTHROPIC_API_KEY=`. Without a key, answers come from Claude Code on your Claude plan (see below).
3. `npm run crawl` reads the website into `data/kb.json`. It takes a few minutes. The knowledge base from 20 Oct 2026 is already in `data/`, so you can skip this step until the site changes.
4. `npm start`, then open http://localhost:3000. The header shows what is answering.

## Three ways to answer

The server picks one at startup. Set `BACKEND` in `.env` to choose; `auto` is the default.

| Mode | When `auto` picks it | How it answers | Cost |
| --- | --- | --- | --- |
| `api` | An API key is set | Claude reads the whole knowledge base for every question | API charges (see Cost) |
| `claude-code` | No API key, and Claude Code is signed in | Claude reads a list of every product, plus the 5 pages that best match each message | Uses your Claude plan's usage limits; no API charges |
| `search` | Neither | Lists the best-matching pages; no written answer | Free |

### Using your Claude plan (`claude-code`)

The server runs Claude Code's command-line tool signed in as you. It finds the copy that comes with the VS Code extension, or set `CLAUDE_CLI` to its path. It strips any API key from that process so the plan is used. Claude Code runs with no tools, MCP servers, settings or skills.

- Each chat keeps one Claude Code process running and remembers the whole conversation. Follow-ups skip Claude Code's start-up and reuse the conversation from the cache. A spare process waits for the next new chat. A chat's process closes after 10 idle minutes, and the chat picks up where it left off.
- Each message carries only the 5 best-matching pages not already sent in that chat. The fixed instructions hold a short list of every product name (about 6,000 tokens, cached).
- In testing with Opus 5.5 on a Pro plan:
    - first question in a chat: about 9,000 new tokens, 5–6 seconds
    - follow-ups: 2,000–5,000 new tokens, 2.5–4.5 seconds
- `MODEL=sonnet` or `MODEL=haiku` in `.env` start answering in about half the time. They also use less of the plan.
- The keyword search can miss pages on broad questions. The `api` mode reads everything.
- This mode is for your own testing. Everything runs as you, so don't open it to others (`HOST=0.0.0.0`). For the team, use an API key.

## What's in the knowledge base

`npm run crawl` reads only paths that robots.txt allows, one request at a time:

- every product: the product feed (brand, options, tags) and the product page (specs, warranty, features)
- every collection, with its list of products
- the information pages, policies and blog articles
- the PDFs those pages link to: spec sheets and installation manuals

It writes `data/kb.json` for the server, and `data/kb.md` with the same content as one readable document. Downloaded PDFs are cached in `data/cache/`. Run the crawl again whenever the website changes.

The run on 20 Oct 2026 collected 302 documents (138 products, 54 collections, 16 pages, 39 articles and 55 PDFs), about 260,000 tokens.

**Gap:** 108 products link their spec sheets, and the site links the 2026 catalog, from the company SharePoint (`energyxperts.sharepoint.com`). Those links open SharePoint's viewer but refuse downloads (HTTP 403), so those PDFs aren't in the knowledge base yet. The crawler lists each one as a warning.

## How answers work

The instructions tell Claude to:

- reply like a colleague in a chat: about 60 words or fewer unless asked for detail, offering more instead of dumping it
- follow the conversation, so "which of those…" refers to what was just discussed
- link its sources
- ask a follow-up question when a request is vague
- point out when sources disagree
- never quote prices, since the site lists none

In `api` mode the whole knowledge base is cached in the system prompt between questions. Requests opt into server-side fallback (`fallbacks: "default"`): if a safety classifier declines a question, the API retries it on the model Anthropic recommends instead of returning a refusal.

## Cost (`api` mode)

Rough figures at current Claude Opus 5.5 list prices, for a knowledge base of about 260,000 tokens:

- **First question, or the first after 5 idle minutes:** about $1.35. That covers writing the knowledge base to the cache.
- **Each later question:** about $0.10, for reading the cache plus the answer.

`EFFORT=low` in `.env` makes answers faster and cheaper.

## Settings (`.env`)

| Setting | Default | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | Turns on `api` mode |
| `BACKEND` | `auto` | `auto`, `api`, `claude-code` or `search` |
| `MODEL` | `claude-opus-5-5` (API); your plan's default (Claude Code) | Model that answers. Claude Code also takes `opus`, `sonnet` or `haiku`. |
| `EFFORT` | `low` | `low` to `max`: how much the model thinks before answering |
| `CLAUDE_CLI` | found automatically | Path to the Claude Code program |
| `PORT` | `3000` | Port for the chat page |
| `HOST` | `127.0.0.1` | `0.0.0.0` lets others on the network open the chat. It has no login, so anyone who can reach it uses your key or plan. |

## Files

- `src/crawl.ts` builds the knowledge base
- `src/server.ts` serves the chat page and answers with the API, Claude Code or search
- `src/kb.ts` loads the knowledge base, renders it for prompts and runs the keyword search
- `public/` holds the chat page
