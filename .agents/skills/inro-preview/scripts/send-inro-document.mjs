#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";

const args = parseArgs(process.argv.slice(2));
const jsonOutput = Boolean(args.json);

class InroHelperError extends Error {
  constructor(message, { code = "error", status, details } = {}) {
    super(message);
    this.name = "InroHelperError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

try {
  if (args.help || args._.length !== 1) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const filePath = args._[0];
  const configInfo = readClientConfig(args.config);
  const serverUrl = normalizeServerUrl(args.server ?? process.env.INRO_SERVER_URL ?? configInfo.config?.serverUrl ?? "http://127.0.0.1:4317");
  const tokenResolution = resolveToken({ args, config: configInfo.config, serverUrl });

  const content = readFileSync(filePath, "utf8");
  const format = String(args.format ?? inferFormat(filePath));
  if (format !== "markdown" && format !== "html") fail("--format must be markdown or html", { code: "invalid_format" });

  const title = String(args.title ?? inferTitle(filePath));
  const sourceAgent = String(args["source-agent"] ?? process.env.INRO_SOURCE_AGENT ?? configInfo.config?.sourceAgent ?? "llm-agent");
  const documentId = args["document-id"] ? String(args["document-id"]) : undefined;
  const endpoint = documentId ? `/api/documents/${encodeURIComponent(documentId)}/revisions` : "/api/documents";
  const requestUrl = joinServerPath(serverUrl, endpoint);

  if (args["dry-run"]) {
    const dryRun = {
      ok: true,
      dryRun: true,
      serverUrl,
      endpoint,
      requestUrl,
      format,
      title,
      sourceAgent,
      tokenFound: Boolean(tokenResolution.token),
      tokenSource: tokenResolution.source,
    };
    if (jsonOutput) printJson(dryRun);
    else {
      console.log("Inro send dry run (no HTTP request sent)");
      console.log(`Server: ${serverUrl}`);
      console.log(`Endpoint: ${requestUrl}`);
      console.log(`Format: ${format}`);
      console.log(`Title: ${title}`);
      console.log(`Source Agent: ${sourceAgent}`);
      console.log(`Token found: ${dryRun.tokenFound ? "yes" : "no"}${dryRun.tokenSource !== "none" ? ` (${dryRun.tokenSource})` : ""}`);
    }
    process.exit(0);
  }

  if (!tokenResolution.token) {
    const mismatch = configMismatchMessage(configInfo.config, serverUrl);
    fail(isLocalServer(serverUrl)
      ? `No Inro token found. Set INRO_TOKEN, pass --token, run setup-inro-skill.mjs, or start Inro once so ~/.inro/token exists.${mismatch}`
      : `No token configured for hosted Inro server. Run setup-inro-skill.mjs --server URL --token TOKEN, set INRO_TOKEN, or pass --token.${mismatch}`,
      { code: "missing_token", details: { serverUrl, tokenFound: false, tokenSource: "none" } });
  }

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

  const response = await postJson(requestUrl, tokenResolution.token, payload, { serverUrl, endpoint, tokenSource: tokenResolution.source });
  const body = response.body;
  const latestUrl = absolutize(serverUrl, body.latestUrl ?? body.absoluteLatestUrl);
  const revisionUrl = absolutize(serverUrl, body.revisionUrl ?? body.absoluteRevisionUrl);
  const output = { ...body, latestUrl, revisionUrl };

  if (jsonOutput) printJson({ ok: true, ...output });
  else {
    console.log(`Document: ${latestUrl}`);
    console.log(`Revision: ${revisionUrl}`);
    console.log(JSON.stringify(output, null, 2));
  }
} catch (error) {
  handleError(error, jsonOutput);
}

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

function defaultConfigPath() {
  return join(homedir(), ".inro", "client-config.json");
}

function readClientConfig(configPath) {
  const path = String(configPath ?? defaultConfigPath());
  if (!existsSync(path)) return { path, exists: false, config: undefined };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") fail(`Invalid Inro client config at ${path}`, { code: "invalid_config" });
    return { path, exists: true, config: parsed };
  } catch (error) {
    if (error instanceof InroHelperError) throw error;
    fail(`Could not read Inro client config at ${path}: ${formatErrorMessage(error)}`, { code: "config_read_failed" });
  }
}

function normalizeServerUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") fail("--server must be an http or https URL", { code: "invalid_server_url" });
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    if (error instanceof InroHelperError) throw error;
    fail(`Invalid Inro server URL: ${formatErrorMessage(error)}`, { code: "invalid_server_url" });
  }
}

function resolveToken({ args, config, serverUrl }) {
  if (args.token) return { token: String(args.token), source: "cli" };
  if (process.env.INRO_TOKEN) return { token: process.env.INRO_TOKEN, source: "env" };
  const configToken = tokenFromConfig(config, serverUrl);
  if (configToken) return { token: configToken, source: "config" };
  const localToken = readLocalTokenIfLocal(serverUrl, args["data-dir"]);
  if (localToken) return { token: localToken, source: "local-token" };
  return { token: undefined, source: "none" };
}

function tokenFromConfig(config, serverUrl) {
  if (!config?.token || !config?.serverUrl) return undefined;
  return normalizeServerUrl(config.serverUrl) === serverUrl ? String(config.token) : undefined;
}

function configMismatchMessage(config, serverUrl) {
  if (!config?.token || !config?.serverUrl) return "";
  const configServer = normalizeServerUrl(config.serverUrl);
  if (configServer === serverUrl) return "";
  return ` Config token was ignored because config server ${configServer} does not match resolved server ${serverUrl}.`;
}

function readLocalTokenIfLocal(serverUrl, dataDir) {
  if (!isLocalServer(serverUrl)) return undefined;
  const tokenPath = join(dataDir ? String(dataDir) : join(homedir(), ".inro"), "token");
  return existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : undefined;
}

function isLocalServer(serverUrl) {
  const host = new URL(serverUrl).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
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

function joinServerPath(serverUrl, path) {
  return `${serverUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

function absolutize(serverUrl, pathOrUrl) {
  if (!pathOrUrl) return undefined;
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return joinServerPath(serverUrl, pathOrUrl);
}

async function postJson(requestUrl, token, payload, context) {
  let response;
  try {
    response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    fail(networkDiagnostic(error, context.serverUrl), { code: "network_error", details: { serverUrl: context.serverUrl, endpoint: context.endpoint } });
  }

  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  let body;
  if (text.length > 0 && contentType.includes("application/json")) {
    try {
      body = JSON.parse(text);
    } catch {
      fail(`Inro API returned invalid JSON from ${requestUrl}. Check for a broken proxy or server logs.`, { code: "invalid_json_response", status: response.status, details: { contentType } });
    }
  }

  if (!response.ok) {
    fail(httpDiagnostic(response.status, body, text, contentType, context), { code: `http_${response.status}`, status: response.status, details: { serverUrl: context.serverUrl, endpoint: context.endpoint, contentType } });
  }

  if (!contentType.includes("application/json") || !body) {
    fail(nonJsonDiagnostic(response.status, text, contentType, requestUrl), { code: "non_json_response", status: response.status, details: { contentType } });
  }

  return { response, body };
}

function httpDiagnostic(status, body, text, contentType, context) {
  const apiMessage = typeof body?.error === "string" ? ` Server said: ${body.error}.` : "";
  if (status === 401 || status === 403) {
    return `Inro API rejected the bearer token (${status}).${apiMessage} Check that the token source (${context.tokenSource}) matches ${context.serverUrl}; for hosted servers, configure a hosted token instead of relying on the local ~/.inro/token file.`;
  }
  if (status === 404) {
    return `Inro API endpoint was not found (404) at ${joinServerPath(context.serverUrl, context.endpoint)}. Check the server URL, reverse-proxy base path, and that this is an Inro server.`;
  }
  if (status >= 500) {
    return `Inro server returned ${status}.${apiMessage} Check the Inro server logs and retry when the server is healthy.`;
  }
  if (contentType.includes("text/html") || looksLikeHtml(text)) {
    return `Inro API returned HTML with status ${status}. This usually means a reverse proxy, SSO/login page, or wrong base path intercepted the API request.`;
  }
  return `Inro API returned ${status}.${apiMessage || " Check the request options and server logs."}`;
}

function nonJsonDiagnostic(status, text, contentType, requestUrl) {
  if (contentType.includes("text/html") || looksLikeHtml(text)) {
    return `Expected JSON from Inro API but received HTML from ${requestUrl} (status ${status}). Check for a proxy login page, wrong server URL/base path, or non-Inro service.`;
  }
  return `Expected JSON from Inro API but received ${contentType || "an unknown content type"} from ${requestUrl} (status ${status}).`;
}

function networkDiagnostic(error, serverUrl) {
  const message = formatErrorMessage(error);
  const code = error?.cause?.code ?? error?.code;
  if (code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || /self.?signed|certificate/i.test(message)) {
    return `TLS certificate verification failed for ${serverUrl}. Use a trusted certificate, fix the proxy certificate chain, or connect through a trusted tunnel. (${message})`;
  }
  if (code === "ECONNREFUSED" || /ECONNREFUSED/i.test(message)) {
    return `Could not connect to Inro server at ${serverUrl}. Check that Inro is running, the host/port are reachable, and any tunnel or reverse proxy is up. (${message})`;
  }
  return `Could not reach Inro server at ${serverUrl}: ${message}`;
}

function looksLikeHtml(text) {
  return /^\s*<!doctype html|^\s*<html[\s>]/i.test(text);
}

function fail(message, options = {}) {
  throw new InroHelperError(sanitize(message), options);
}

function handleError(error, asJson) {
  if (error instanceof InroHelperError) {
    if (asJson) printJson({ ok: false, error: { code: error.code, message: error.message, status: error.status, details: error.details } }, console.error);
    else console.error(error.message);
    process.exit(1);
  }
  const message = sanitize(formatErrorMessage(error));
  if (asJson) printJson({ ok: false, error: { code: "unexpected_error", message } }, console.error);
  else console.error(message);
  process.exit(1);
}

function sanitize(message) {
  let sanitized = String(message);
  for (const secret of [args.token, process.env.INRO_TOKEN].filter(Boolean)) {
    sanitized = sanitized.split(String(secret)).join("[redacted]");
  }
  return sanitized;
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printJson(value, write = console.log) {
  write(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`Send a Markdown or HTML file to Inro.

Usage:
  node scripts/send-inro-document.mjs FILE [options]

Options:
  --server URL                 Inro server URL; otherwise INRO_SERVER_URL, config, or localhost
  --token TOKEN                Bearer token; otherwise INRO_TOKEN, matching config, or local ~/.inro/token
  --config FILE                Client config from setup-inro-skill.mjs, default ~/.inro/client-config.json
  --data-dir DIR               Directory containing local server token file
  --title TITLE                Title for a new Document
  --format markdown|html       Override format inference
  --source-agent NAME          Source Agent identity, default llm-agent
  --document-key KEY           Optional stable Document Key for create
  --document-id ID             Append a Revision to this existing Document
  --revision-summary TEXT      Human-readable Revision Summary
  --idempotency-key KEY        Retry-safe key
  --dry-run                    Resolve options and token source without sending HTTP
  --json                       Emit stable machine-readable JSON without prose
`);
}
