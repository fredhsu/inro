#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const serverInput = args.server ?? process.env.INRO_SERVER_URL;
if (!serverInput) fail("Missing --server URL. For hosted Inro, use the reachable HTTPS/Tailscale/LAN URL.");

const token = args.token ?? process.env.INRO_TOKEN;
if (!token) fail("Missing Inro token. Pass --token or set INRO_TOKEN. The token will not be printed.");

const serverUrl = normalizeServerUrl(String(serverInput));
const sourceAgent = args["source-agent"] ?? process.env.INRO_SOURCE_AGENT;
const configPath = String(args.config ?? defaultConfigPath());

if (!args["skip-verify"]) {
  await verifyServer(serverUrl, String(token));
}

writeClientConfig(configPath, {
  serverUrl,
  token: String(token),
  ...(sourceAgent ? { sourceAgent: String(sourceAgent) } : {}),
});

console.log(`Inro skill configured for ${serverUrl}`);
console.log(`Config written to ${configPath}`);
console.log("Token stored locally with restrictive file permissions; it was not printed.");

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
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

function defaultConfigPath() {
  return join(homedir(), ".inro", "client-config.json");
}

function normalizeServerUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") fail("--server must be an http or https URL");
  return url.toString().replace(/\/$/, "");
}

async function verifyServer(serverUrl, token) {
  let response;
  try {
    response = await fetch(`${serverUrl}/`, { headers: { authorization: `Bearer ${token}` } });
  } catch (error) {
    fail(`Could not reach Inro server at ${serverUrl}: ${error instanceof Error ? error.message : error}`);
  }
  if (response.status === 401 || response.status === 403) fail("Inro server rejected the token.");
  if (!response.ok) fail(`Inro server verification failed (${response.status}). Use --skip-verify to write config anyway.`);
}

function writeClientConfig(path, config) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(path), 0o700); } catch {}
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printHelp() {
  console.log(`Configure the Inro agent skill for a local or hosted server.

Usage:
  node scripts/setup-inro-skill.mjs --server URL --token TOKEN [options]

Options:
  --server URL                 Reachable Inro server URL, e.g. https://inro.example.com
  --token TOKEN                Bearer token; otherwise INRO_TOKEN
  --source-agent NAME          Default Source Agent identity for helper sends
  --config FILE                Config path, default ~/.inro/client-config.json
  --skip-verify                Write config without checking server/token

The token is stored in the config file with mode 0600 and is never printed.
`);
}
