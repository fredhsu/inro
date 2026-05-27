#!/usr/bin/env node
import { buildInroServer } from "../server/app.js";
import { openInroDatabase } from "../persistence/sqlite.js";
import { prepareRuntime } from "./runtime.js";
import { sendFile } from "./send.js";

interface ParsedArgs {
  command: string;
  positional: string[];
  options: Record<string, string | boolean>;
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") return printHelp();
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.options.help) return printHelp();
  if (parsed.command === "serve") return serve(parsed);
  if (parsed.command === "send") return send(parsed);
  throw new Error(`Unknown command: ${parsed.command}`);
}

async function serve(parsed: ParsedArgs): Promise<void> {
  const host = String(parsed.options.host ?? "127.0.0.1");
  const port = Number(parsed.options.port ?? 4317);
  const runtime = prepareRuntime({ dataDir: stringOption(parsed, "data-dir"), tokenOverride: stringOption(parsed, "token") });
  const store = openInroDatabase(runtime.dbPath);
  const baseHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const app = buildInroServer({ store, token: runtime.token, publicBaseUrl: `http://${baseHost}:${port}` });

  if (!isLocalhost(host)) {
    console.warn("WARNING: Inro is binding to a non-localhost address. Only use this on a trusted LAN/Tailscale network; anyone who has the token can access submitted Documents.");
  }

  await app.listen({ host, port });
  console.log(`Inro listening on http://${baseHost}:${port}`);
  console.log(`Data directory: ${runtime.dataDir}`);
  console.log(`Bearer token file: ${runtime.tokenPath}`);

  const shutdown = async () => {
    await app.close();
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function send(parsed: ParsedArgs): Promise<void> {
  const filePath = parsed.positional[0];
  if (!filePath) throw new Error("inro send requires a file path");
  const result = await sendFile({
    filePath,
    serverUrl: stringOption(parsed, "server"),
    token: stringOption(parsed, "token"),
    dataDir: stringOption(parsed, "data-dir"),
    title: stringOption(parsed, "title"),
    format: stringOption(parsed, "format") as "markdown" | "html" | undefined,
    documentKey: stringOption(parsed, "document-key"),
    sourceAgent: stringOption(parsed, "source-agent"),
    revisionSummary: stringOption(parsed, "revision-summary"),
  });
  console.log(result.message);
  console.log(`Revision URL: ${result.revisionUrl}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, positional, options };
}

function stringOption(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  return typeof value === "string" ? value : undefined;
}

function isLocalhost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function printHelp(): void {
  console.log(`Inro

Usage:
  inro serve [--host 127.0.0.1] [--port 4317] [--data-dir DIR] [--token TOKEN]
  inro send FILE [--server URL] [--token TOKEN] [--title TITLE] [--format markdown|html] [--document-key KEY] [--source-agent NAME] [--revision-summary TEXT]
`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
