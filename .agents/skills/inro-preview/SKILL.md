---
name: inro-preview
description: Sends generated Markdown or HTML Documents to a local Inro preview inbox through its CLI or authenticated HTTP API. Use when the user asks to create, preview, publish, send, open, or preserve an agent-generated document in Inro, especially Markdown or HTML docs.
---

# Inro Preview

Use Inro as the user's local inbox for generated Documents. Inro preserves immutable Revisions and returns browser URLs for previewing the result.

## Defaults

- Server URL: `http://127.0.0.1:4317` unless `INRO_SERVER_URL` is set or the user specifies another URL.
- Token: use `INRO_TOKEN`; otherwise read `~/.inro/token` when available.
- Source Agent: identify yourself/tooling, e.g. `pi-coding-agent`, `claude-code`, `codex-cli`, or another stable client name.
- Formats: `markdown` and `html`.

Never print or reveal the bearer token. If no token is available, ask the user to provide one or start Inro once so it creates `~/.inro/token`.

## Workflow

1. Create the requested document as a real file (`.md` or `.html`).
2. For HTML, produce a complete standalone document (`<!doctype html>...`) when practical. MathML is okay. Do not assume LaTeX delimiters in HTML will be rendered.
3. For Markdown, KaTeX delimiters like `$x^2$` and `$$...$$` are supported.
4. Send the file to Inro.
5. Report the returned latest Document URL and Revision URL.

## Preferred send command

If an `inro` CLI is available:

```bash
inro send ./document.html \
  --server http://127.0.0.1:4317 \
  --source-agent YOUR_AGENT_NAME \
  --title "Human-readable title"
```

For Markdown, use a `.md` file. For HTML, use `.html`; the CLI infers the format.

## Portable helper script

If the `inro` CLI is unavailable, use this skill's helper from the skill directory:

```bash
node scripts/send-inro-document.mjs ./document.html \
  --server http://127.0.0.1:4317 \
  --source-agent YOUR_AGENT_NAME \
  --title "Human-readable title"
```

Useful options:

- `--format markdown|html` override format inference
- `--document-key KEY` create a stable keyed Document; duplicate keys conflict instead of merging
- `--document-id ID` append a new Revision to an existing Document
- `--revision-summary TEXT` describe what changed
- `--idempotency-key KEY` make retries safe
- `--token TOKEN` only when env/file token discovery is unavailable

## Direct HTTP contract

Create a Document:

```bash
curl -sS -X POST "$INRO_SERVER_URL/api/documents" \
  -H "Authorization: Bearer $INRO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Example","format":"html","content":"<h1>Hello</h1>","sourceAgent":"YOUR_AGENT_NAME"}'
```

Append a Revision:

```bash
curl -sS -X POST "$INRO_SERVER_URL/api/documents/DOCUMENT_ID/revisions" \
  -H "Authorization: Bearer $INRO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"format":"markdown","content":"Updated content","sourceAgent":"YOUR_AGENT_NAME","revisionSummary":"Updated draft"}'
```

Successful responses include `documentId`, `revisionId`, `latestUrl`, and `revisionUrl`. Convert relative URLs to the server URL before reporting them to the user.
