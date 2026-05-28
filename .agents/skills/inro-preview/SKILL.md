---
name: inro
description: Sends generated Markdown or HTML Documents to an Inro preview inbox through its CLI or authenticated HTTP API, including hosted Inro servers on another machine. Use when the user asks to create, preview, publish, send, open, or preserve an agent-generated document in Inro, especially Markdown or HTML docs.
---

# Inro Preview

Use Inro as the user's inbox for generated **Documents**. Inro may run locally or as a hosted server on another trusted machine. It preserves immutable **Revisions** and returns browser URLs for previewing the result.

## Agent contract

1. Create the requested content as a real `.md` or `.html` file.
2. Add provenance metadata/footer unless the user asks for a pristine document.
3. Send the file to Inro using the preferred path below.
4. Report the returned latest Document URL and immutable Revision URL.
5. Never print, log, or reveal the bearer token.

For HTML, prefer a complete standalone document (`<!doctype html>...`) when practical. MathML is okay. Do not assume LaTeX delimiters in HTML will be rendered. For Markdown, KaTeX delimiters like `$x^2$` and `$$...$$` are supported.

## Preferred path

### 1. Setup helper: configure once per agent machine

For hosted/remote Inro, ask the user for the reachable server URL and token, or ask them to run:

```bash
node .agents/skills/inro-preview/scripts/setup-inro-skill.mjs \
  --server https://inro.example.com \
  --token "$INRO_TOKEN" \
  --source-agent YOUR_AGENT_NAME
```

The setup helper writes `~/.inro/client-config.json` with mode `0600`, verifies the server/token by default, and does not print the token. If the server is temporarily unreachable but the URL/token are known, add `--skip-verify`.

Environment-only setup is also valid:

```bash
export INRO_SERVER_URL=https://inro.example.com
export INRO_TOKEN=...
export INRO_SOURCE_AGENT=YOUR_AGENT_NAME
```

### 2. Reliable portable helper: default send path for agents

Use the bundled helper when available. It works without a globally installed `inro` CLI and reads the setup config automatically:

```bash
node .agents/skills/inro-preview/scripts/send-inro-document.mjs ./document.html \
  --source-agent YOUR_AGENT_NAME \
  --title "Human-readable title"
```

Server URL precedence: `--server`, `INRO_SERVER_URL`, `~/.inro/client-config.json`, then `http://127.0.0.1:4317`.

Token precedence: `--token`, `INRO_TOKEN`, matching `~/.inro/client-config.json`; only fall back to `~/.inro/token` for localhost servers.

Useful options:

- `--format markdown|html` override format inference
- `--document-key KEY` create a stable keyed Document; use for recurring reports at first creation
- `--document-id ID` append a new Revision to an existing Document
- `--revision-summary TEXT` describe what changed
- `--idempotency-key KEY` make retries safe
- `--config FILE` use a non-default setup config
- `--token TOKEN` only when env/config/file token discovery is unavailable
- `--dry-run` show resolved server/endpoint/options/token source without sending HTTP or printing the token
- `--json` emit machine-readable JSON without prose

### 3. CLI fast path: use when `inro` is installed

If a global/built `inro` CLI is available, it is fine for quick local sends or explicit hosted sends:

```bash
inro send ./document.html \
  --server https://inro.example.com \
  --token "$INRO_TOKEN" \
  --source-agent YOUR_AGENT_NAME \
  --title "Human-readable title"
```

For Markdown, use a `.md` file. For HTML, use `.html`; the CLI infers the format.

## Hosted/remote server setup

On the hosted server machine, Inro must bind to a reachable interface, for example:

```bash
inro serve --host 0.0.0.0 --port 4317 --token "$INRO_TOKEN"
```

Binding beyond localhost exposes token-protected Documents to that network. Prefer HTTPS, a private overlay network such as Tailscale, or an SSH tunnel.

For hosted Inro, do not reuse a random local `~/.inro/token` unless that exact token was configured on the hosted server. The token in the agent's local home directory belongs to that local server only.

## Diagnostics

If sending fails or hosted setup is uncertain, run the doctor from the skill directory:

```bash
node .agents/skills/inro-preview/scripts/inro-doctor.mjs --server https://inro.example.com --json
```

It checks config/env/token resolution, local token permissions for localhost, API reachability, and common HTTP/proxy/TLS failures without printing bearer tokens.

Before sending from a new machine or cron job, dry-run the send helper:

```bash
node .agents/skills/inro-preview/scripts/send-inro-document.mjs ./document.md --dry-run --json
```

Use `--json` when another agent/script needs to parse `documentId`, `revisionId`, `latestUrl`, or `revisionUrl`.

## Examples

### HTML report

```bash
cp .agents/skills/inro-preview/templates/report.html .scratch/weekly-report.html
# edit .scratch/weekly-report.html with the generated report
node .agents/skills/inro-preview/scripts/send-inro-document.mjs .scratch/weekly-report.html \
  --title "Weekly Reliability Report" \
  --document-key "weekly-reliability-report" \
  --revision-summary "Initial weekly report"
```

### Markdown notes

```bash
cat > .scratch/math-notes.md <<'EOF'
# Math Notes

- Key result: $a^2 + b^2 = c^2$.
- Open question: prove the boundary case.

---
Generated by pi-coding-agent for Inro. Source Agent: pi-coding-agent. Generated: 2026-05-26T00:00:00Z.
EOF

node .agents/skills/inro-preview/scripts/send-inro-document.mjs .scratch/math-notes.md \
  --source-agent pi-coding-agent \
  --title "Math Notes"
```

### Append a Revision

Use `--document-id` when you already have the Document ID from an earlier response:

```bash
node .agents/skills/inro-preview/scripts/send-inro-document.mjs .scratch/math-notes.md \
  --document-id DOCUMENT_ID \
  --revision-summary "Added boundary-case proof"
```

### Stable Document Key for recurring reports

For a report generated repeatedly by cron or a background agent, choose one stable Document Key. Titles are display text, not identity. Use the key on first creation and save the returned `documentId`; subsequent runs should append with `--document-id`. If/when key-based append/upsert support is available, keep using the same stable key rather than generating date-stamped keys.

```bash
# First creation of the recurring Document. Save documentId from the helper output.
node .agents/skills/inro-preview/scripts/send-inro-document.mjs .scratch/daily-digest.md \
  --title "Daily Digest" \
  --document-key "daily-digest" \
  --revision-summary "Initial daily digest"
```

### Cron/background agent

```cron
# Generate and append to the same Document daily. Keep token in env/config, not in the crontab.
15 7 * * * cd /home/fred/project && ./scripts/generate-digest.sh && node .agents/skills/inro-preview/scripts/send-inro-document.mjs .scratch/daily-digest.md --document-id "$(cat .scratch/daily-digest.document-id)" --source-agent cron-digest-agent --revision-summary "Daily digest $(date -I)" --idempotency-key "daily-digest-$(date -I)" >> .scratch/inro-cron.log 2>&1
```

For background agents, prefer stable identity (`--document-key` at creation, persisted `--document-id` for appends) plus `--idempotency-key` so retries do not create duplicate Revisions.

## Provenance convention

Generated Documents should identify where they came from without leaking secrets. Prefer a short visible footer plus optional machine-readable metadata.

Markdown footer:

```markdown
---
Generated by SOURCE_AGENT for Inro. Generated: ISO_TIMESTAMP. Worktree: PATH_OR_REPO. Inputs: short non-secret summary. Document Key: KEY. Revision Summary: SUMMARY.
```

HTML footer:

```html
<footer data-inro-provenance data-source-agent="SOURCE_AGENT" data-generated-at="ISO_TIMESTAMP" data-document-key="KEY">
  Generated by SOURCE_AGENT for Inro on ISO_TIMESTAMP. Inputs: short non-secret summary.
</footer>
```

Do not include bearer tokens, private prompt text the user did not ask to preserve, hidden chain-of-thought, or unrelated environment dumps.

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

## Troubleshooting HTTP errors

- **Connection refused / `fetch failed` against localhost**: the local Inro server is probably not running. Start it with `inro serve --host 127.0.0.1 --port 4317` or point `--server`/`INRO_SERVER_URL` at the hosted server.
- **Hosted server unreachable (`ENOTFOUND`, timeout, 502/503)**: verify DNS, VPN/Tailscale, SSH tunnel, firewall, and that Inro is bound to a reachable host/port (`--host 0.0.0.0` on trusted networks only).
- **401/403 Unauthorized**: token mismatch. Use the hosted server's token, not an unrelated local `~/.inro/token`; re-run the setup helper or set `INRO_TOKEN` explicitly.
- **401 through reverse proxy but direct server works**: the proxy may be stripping `Authorization` headers. Configure it to forward `Authorization: Bearer ...` to Inro.
- **404 or HTML proxy error on `/api/documents`**: base path mismatch. If Inro is mounted under `/inro`, the server/proxy and client URL must agree; use the externally reachable base URL that actually routes `/api/...` to Inro.
- **CORS errors**: the skill helper and CLI are server-side Node calls, so browser CORS does not apply. CORS only matters if a browser page directly calls the API; debug helper/CLI failures as network/auth/base-path problems instead.
- **Setup helper verifies localhost but sends to remote fail**: you may have configured `http://127.0.0.1:4317` or used a localhost token by mistake. Re-run setup with the remote URL and remote token.
- **Returned URLs use `localhost`/`127.0.0.1` and do not open from a phone/laptop**: send using the externally reachable `--server` URL so relative URLs are reported with that base. If the server itself returns absolute localhost URLs, use/copy the path portion (`/d/...`) onto the hosted base URL, and configure the hosted server/proxy to advertise a public base URL when that option is available.
- **`better-sqlite3` `NODE_MODULE_VERSION` mismatch when starting in the background**: Hermes foreground and background shells may resolve different Node binaries. Check both (`node -p 'process.versions.modules'` in foreground and background), rebuild native deps with the Node you will actually run, and invoke that Node explicitly, e.g. `/usr/bin/node dist/cli/inro.js serve ...`.
