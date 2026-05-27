# Inro

An inbox for agent-generated Documents, with immutable Revisions and browser previews. It can run locally or as a hosted server on another trusted machine.

## Development

```bash
npm install
npm test
npm run build
npm run dev -- --port 4317
```

## CLI

Start the local server:

```bash
npm run dev -- serve
# or after build
node dist/cli/inro.js serve --host 127.0.0.1 --port 4317
```

The server creates a data directory at `~/.inro`, generates a persistent bearer token in `~/.inro/token`, and stores Documents/Revisions in SQLite.

Send a Markdown file:

```bash
node dist/cli/inro.js send ./note.md --server http://127.0.0.1:4317
```

Useful options:

- `serve --data-dir DIR --token TOKEN --host HOST --port PORT`
- `send --token TOKEN --title TITLE --document-key KEY --source-agent NAME --revision-summary TEXT`

Binding to a non-localhost host prints a warning because the browser UI and API are token-protected but exposed to the chosen network.

## Hosted server / agent skill setup

On the server machine, bind Inro to a reachable interface only on a trusted LAN, Tailscale network, SSH tunnel, or behind HTTPS:

```bash
inro serve --host 0.0.0.0 --port 4317 --token "$INRO_TOKEN"
```

On the machine where the AI agent runs, configure the bundled skill helper once:

```bash
node .agents/skills/inro-preview/scripts/setup-inro-skill.mjs \
  --server https://inro.example.com \
  --token "$INRO_TOKEN" \
  --source-agent pi-coding-agent
```

The helper writes `~/.inro/client-config.json` with restrictive permissions, verifies the server/token by default, and never prints the token. The send helper then reads that config automatically:

```bash
node .agents/skills/inro-preview/scripts/send-inro-document.mjs ./note.md
```

Environment variables are also supported: `INRO_SERVER_URL`, `INRO_TOKEN`, and `INRO_SOURCE_AGENT`.
