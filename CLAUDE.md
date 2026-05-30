# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Inro is

Inro is a local (or trusted-LAN-hosted) inbox for agent-generated **Documents**. Agents submit content over an HTTP API; users browse rendered previews in a token-protected web UI. It runs as a single Fastify process backed by SQLite, with no build step for the frontend — all HTML/CSS is generated server-side as template strings in `src/server/app.ts`.

## Commands

```bash
npm install
npm test                       # run all tests (node --test + tsx)
npm run typecheck              # tsc --noEmit, no emit
npm run build                  # compile src/ to dist/ via tsconfig.build.json
npm run dev -- serve [--port 4317] [--host 127.0.0.1]   # run from source with tsx
npm start                      # run compiled dist/cli/inro.js serve
```

Run a single test file:

```bash
node --import tsx --test test/api.test.ts
```

There is no linter configured; `npm run typecheck` (strict mode) is the static check.

## Domain language (authoritative: CONTEXT.md)

The vocabulary in `CONTEXT.md` is deliberate and enforced throughout code, UI copy, and the CLI. Use these exact terms; avoid the listed synonyms.

- **Document** — stable user-visible container for related content over time (not "artifact"/"preview").
- **Revision** — an immutable submission of content belonging to one Document (not "version"/"update").
- **Document Key** — agent-supplied stable identifier to intentionally route submissions to the same Document. Titles are display-only and never identity.
- **Source Agent** — the client identity recorded on each Revision.
- **Submission** — an external request that creates a Document or appends a Revision (the CLI verb is `send`).
- **Idempotency Key** — retry identifier scoped per Source Agent *and* per submission target (new-document vs. a specific document). See `idempotencyScope()` in `submission-service.ts`.

A Document's `latestRevisionId` is what the index/preview shows; appending a Revision advances it. Read state is derived: a Document `isRead` when `lastReadRevisionId === latestRevisionId`, so a new Revision automatically makes it unread again.

## Architecture

Layered, with dependencies pointing inward via interfaces:

- `src/cli/inro.ts` — arg parsing and the `serve` / `send` commands. `runtime.ts` resolves the data dir (`~/.inro` by default, or `INRO_DATA_DIR`), creates/reads the persistent bearer token (`~/.inro/token`, mode 0600), and computes db path. `send.ts` is a standalone HTTP client that POSTs to `/api/documents`.
- `src/server/app.ts` — `buildInroServer(...)` wires everything and defines every route. Auth is a single `preHandler` hook accepting a `Bearer` header, an `inro_session` cookie, or a `?token=` query param; `/api/*` returns 401, browser routes redirect to `/login`. **The entire web UI (page shell, CSS, inline SVG icons, live-reload script) lives here as template strings** — there is no separate frontend project, framework, or asset pipeline.
- `src/services/` — `submission-service.ts` owns idempotency replay + live-event publishing and delegates persistence to `document-service.ts`, which enforces Document Key uniqueness and `DocumentNotFound`/`DocumentKeyConflict` errors and builds the enriched `DocumentView`.
- `src/persistence/sqlite.ts` — `InroStore` interface + `better-sqlite3` implementation. Schema is created/migrated inline in `migrate()` on open (WAL, foreign keys on, cascade delete of revisions). Add schema changes there; use `ensureColumn()` for additive column migrations on existing databases.
- `src/rendering/rendering.ts` — Markdown via `markdown-it` (with a custom `$...$` / `$$...$$` KaTeX plugin); `escapeHtml` lives here.
- `src/live-events/live-events.ts` — in-process pub/sub. The server exposes `/events` (global) and `/d/:id/events` (per-document) as SSE; the browser's inline script reloads the page on any event.

### Security model (preserve these invariants)

- **HTML Revisions are rendered in a fully sandboxed iframe** (`sandbox=""`, `srcdoc` escaped) — never inline. Markdown is rendered inline with `markdown-it` `html: false`. Do not relax either.
- Data dir, token file, and SQLite file are written with restrictive POSIX modes (0700/0600).
- Binding to a non-localhost host is allowed but prints a warning; the UI/API are only token-protected, not otherwise hardened.

## Tests

`test/*.test.ts` use the built-in `node:test` runner via `tsx`. They exercise real layers against a temp SQLite file (`mkdtempSync`) and use Fastify's `app.inject(...)` for HTTP — no network. Note imports use `.js` extensions (NodeNext ESM) even though sources are `.ts`.

## Agent skill (`.agents/skills/inro-preview/`)

Bundled helpers agents use to submit Documents to a hosted Inro: `setup-inro-skill.mjs` (writes `~/.inro/client-config.json`), `send-inro-document.mjs` (portable send), and `inro-doctor.mjs` (diagnostics). These are the documented preferred path over the global `inro` CLI for remote use. Recurring reports should reuse a stable Document Key / saved `documentId` so submissions append Revisions instead of creating duplicate Documents.
