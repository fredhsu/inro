---
name: inro-preview
description: Sends generated Markdown or HTML Documents to an Inro preview inbox through its CLI or authenticated HTTP API, including hosted Inro servers on another machine. Use when the user asks to create, preview, publish, send, open, or preserve an agent-generated document in Inro, especially Markdown or HTML docs.
---

# Inro Preview

Use Inro as the user's inbox for generated Documents. Inro may run locally or as a hosted server on another trusted machine. It preserves immutable Revisions and returns browser URLs for previewing the result.

## Defaults

For this skill's portable helper:

- Server URL precedence: user-specified `--server`, `INRO_SERVER_URL`, `~/.inro/client-config.json`, then `http://127.0.0.1:4317`.
- Token precedence: user-specified `--token`, `INRO_TOKEN`, matching `~/.inro/client-config.json`; only fall back to `~/.inro/token` for localhost servers.
- Source Agent: identify yourself/tooling, e.g. `pi-coding-agent`, `claude-code`, `codex-cli`, or another stable client name.
- Formats: `markdown` and `html`.

Never print or reveal the bearer token. For hosted Inro, ask the user for the server URL and token, or ask them to run the setup helper. For local Inro, if no token is available, ask the user to provide one or start Inro once so it creates `~/.inro/token`.

## Workflow

1. Create the requested document as a real file (`.md` or `.html`).
2. For HTML, produce a complete standalone document (`<!doctype html>...`) when practical. MathML is okay. Do not assume LaTeX delimiters in HTML will be rendered.
3. For Markdown, KaTeX delimiters like `$x^2$` and `$$...$$` are supported.
4. Send the file to Inro.
5. Report the returned latest Document URL and Revision URL.

## Hosted/remote setup

When the user's Inro server runs on another machine, configure the skill once on the agent machine:

```bash
node scripts/setup-inro-skill.mjs \
  --server https://inro.example.com \
  --token "$INRO_TOKEN" \
  --source-agent YOUR_AGENT_NAME
```

This writes `~/.inro/client-config.json` with mode `0600`, verifies the server/token by default, and does not print the token. Use a trusted network, Tailscale, SSH tunnel, or HTTPS reverse proxy for hosted access.

If the server is temporarily unreachable but the URL/token are known, add `--skip-verify`.

On the hosted server machine, Inro must bind to a reachable interface, for example:

```bash
inro serve --host 0.0.0.0 --port 4317 --token "$INRO_TOKEN"
```

Binding beyond localhost exposes token-protected Documents to that network. Prefer HTTPS or a private overlay network.

Environment-only setup is also valid:

```bash
export INRO_SERVER_URL=https://inro.example.com
export INRO_TOKEN=...
```

## Preferred send command

If an `inro` CLI is available, use explicit hosted credentials via options or environment variables:

```bash
inro send ./document.html \
  --server https://inro.example.com \
  --token "$INRO_TOKEN" \
  --source-agent YOUR_AGENT_NAME \
  --title "Human-readable title"
```

For Markdown, use a `.md` file. For HTML, use `.html`; the CLI infers the format.

## Portable helper script

If the `inro` CLI is unavailable, use this skill's helper from the skill directory. It reads the hosted setup config automatically:

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
- `--config FILE` use a non-default setup config
- `--token TOKEN` only when env/config/file token discovery is unavailable
- `--dry-run` show resolved server/endpoint/options/token source without sending HTTP or printing the token
- `--json` emit machine-readable JSON without prose

## Diagnostics

If sending fails or hosted setup is uncertain, run the doctor from the skill directory:

```bash
node scripts/inro-doctor.mjs --server https://inro.example.com --json
```

It checks config/env/token resolution, local token permissions for localhost, API reachability, and common HTTP/proxy/TLS failures without printing bearer tokens.

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
