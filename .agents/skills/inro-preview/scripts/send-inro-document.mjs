#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";

const args = parseArgs(process.argv.slice(2));

if (args.help || args._.length !== 1) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

const filePath = args._[0];
const serverUrl = String(args.server ?? process.env.INRO_SERVER_URL ?? "http://127.0.0.1:4317").replace(/\/$/, "");
const token = String(args.token ?? process.env.INRO_TOKEN ?? readToken(args["data-dir"]));

if (!token || token === "undefined") {
  fail("No Inro token found. Set INRO_TOKEN, pass --token, or start Inro once so ~/.inro/token exists.");
}

const content = readFileSync(filePath, "utf8");
const format = String(args.format ?? inferFormat(filePath));
if (format !== "markdown" && format !== "html") fail("--format must be markdown or html");

const title = String(args.title ?? inferTitle(filePath));
const sourceAgent = String(args["source-agent"] ?? process.env.INRO_SOURCE_AGENT ?? "llm-agent");
const documentId = args["document-id"] ? String(args["document-id"]) : undefined;

const payload = documentId
  ? {
      format,
      content,
      sourceAgent,
      revisionSummary: args["revision-summary"],
      idempotencyKey: args["idempotency-key"],
    }
  : {
      title,
      format,
      content,
      sourceAgent,
      documentKey: args["document-key"],
      revisionSummary: args["revision-summary"],
      idempotencyKey: args["idempotency-key"],
    };

const endpoint = documentId ? `/api/documents/${encodeURIComponent(documentId)}/revisions` : "/api/documents";
const response = await fetch(`${serverUrl}${endpoint}`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(payload),
});

const text = await response.text();
if (!response.ok) fail(`Inro API returned ${response.status}: ${text}`);

const body = JSON.parse(text);
const latestUrl = absolutize(serverUrl, body.latestUrl ?? body.absoluteLatestUrl);
const revisionUrl = absolutize(serverUrl, body.revisionUrl ?? body.absoluteRevisionUrl);

console.log(`Document: ${latestUrl}`);
console.log(`Revision: ${revisionUrl}`);
console.log(JSON.stringify({ ...body, latestUrl, revisionUrl }, null, 2));

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function readToken(dataDir) {
  const tokenPath = join(dataDir ? String(dataDir) : join(homedir(), ".inro"), "token");
  return existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : undefined;
}

function inferFormat(path) {
  const ext = extname(path).toLowerCase();
  return ext === ".html" || ext === ".htm" ? "html" : "markdown";
}

function inferTitle(path) {
  const name = basename(path);
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

function absolutize(serverUrl, pathOrUrl) {
  if (!pathOrUrl) return undefined;
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${serverUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printHelp() {
  console.log(`Send a Markdown or HTML file to Inro.

Usage:
  node scripts/send-inro-document.mjs FILE [options]

Options:
  --server URL                 Inro server URL, default http://127.0.0.1:4317
  --token TOKEN                Bearer token; otherwise INRO_TOKEN or ~/.inro/token
  --data-dir DIR               Directory containing token file
  --title TITLE                Title for a new Document
  --format markdown|html       Override format inference
  --source-agent NAME          Source Agent identity, default llm-agent
  --document-key KEY           Optional stable Document Key for create
  --document-id ID             Append a Revision to this existing Document
  --revision-summary TEXT      Human-readable Revision Summary
  --idempotency-key KEY        Retry-safe key
`);
}
