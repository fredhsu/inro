# Inro

A local inbox for agent-generated Documents, with immutable Revisions and browser previews.

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
