#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = parseArgs(process.argv.slice(2));
const jsonOutput = Boolean(args.json);

class InroDoctorError extends Error {
  constructor(message, { code = "error", status, details } = {}) {
    super(message);
    this.name = "InroDoctorError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

try {
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const checks = [];
  const configInfo = readClientConfig(args.config, checks);
  const serverUrl = resolveServerUrl(args, configInfo.config, checks);
  const sourceAgent = String(args["source-agent"] ?? process.env.INRO_SOURCE_AGENT ?? configInfo.config?.sourceAgent ?? "llm-agent");
  const localTokenInfo = inspectLocalToken(serverUrl, args["data-dir"], checks);
  const configPermissionInfo = inspectConfigPermissions(configInfo, checks);
  const tokenResolution = resolveToken({ args, config: configInfo.config, serverUrl, localTokenInfo, checks });
  const api = await checkApiEndpoint(serverUrl, tokenResolution, checks);

  const ok = checks.every((check) => check.level !== "error");
  const report = {
    ok,
    serverUrl,
    endpoint: "/api/documents",
    requestUrl: joinServerPath(serverUrl, "/api/documents"),
    sourceAgent,
    config: {
      path: configInfo.path,
      exists: configInfo.exists,
      serverUrl: configInfo.config?.serverUrl ? normalizeServerUrl(configInfo.config.serverUrl) : undefined,
      hasToken: Boolean(configInfo.config?.token),
      permissions: configPermissionInfo,
    },
    token: {
      found: Boolean(tokenResolution.token),
      source: tokenResolution.source,
    },
    localToken: localTokenInfo,
    api,
    checks,
  };

  if (jsonOutput) printJson(report);
  else printTextReport(report);
  process.exit(ok ? 0 : 1);
} catch (error) {
  handleError(error, jsonOutput);
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`, { code: "unexpected_argument" });
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

function readClientConfig(configPath, checks) {
  const path = String(configPath ?? defaultConfigPath());
  if (!existsSync(path)) {
    checks.push({ name: "config", level: "info", message: `No client config found at ${path}.` });
    return { path, exists: false, config: undefined };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") fail(`Invalid Inro client config at ${path}`, { code: "invalid_config" });
    checks.push({ name: "config", level: "ok", message: `Client config found at ${path}.` });
    return { path, exists: true, config: parsed };
  } catch (error) {
    if (error instanceof InroDoctorError) throw error;
    fail(`Could not read Inro client config at ${path}: ${formatErrorMessage(error)}`, { code: "config_read_failed" });
  }
}

function resolveServerUrl(args, config, checks) {
  const source = args.server ? "cli" : process.env.INRO_SERVER_URL ? "env" : config?.serverUrl ? "config" : "default";
  const raw = args.server ?? process.env.INRO_SERVER_URL ?? config?.serverUrl ?? "http://127.0.0.1:4317";
  const serverUrl = normalizeServerUrl(raw);
  checks.push({ name: "server-url", level: "ok", message: `Resolved server URL from ${source}: ${serverUrl}.` });
  if (config?.serverUrl && normalizeServerUrl(config.serverUrl) !== serverUrl) {
    checks.push({ name: "config-server-match", level: "warn", message: `Config server ${normalizeServerUrl(config.serverUrl)} does not match resolved server ${serverUrl}; config token will be ignored.` });
  }
  return serverUrl;
}

function normalizeServerUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") fail("Server must be an http or https URL.", { code: "invalid_server_url" });
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    if (error instanceof InroDoctorError) throw error;
    fail(`Invalid Inro server URL: ${formatErrorMessage(error)}`, { code: "invalid_server_url" });
  }
}

function inspectConfigPermissions(configInfo, checks) {
  if (!configInfo.exists) return undefined;
  try {
    const mode = statSync(configInfo.path).mode & 0o777;
    const secure = (mode & 0o077) === 0;
    checks.push({
      name: "config-permissions",
      level: secure ? "ok" : "warn",
      message: secure
        ? `Client config permissions are restrictive (${formatMode(mode)}).`
        : `Client config is group/world-readable (${formatMode(mode)}). Run: chmod 600 ${configInfo.path}`,
    });
    return { mode: formatMode(mode), secure };
  } catch (error) {
    checks.push({ name: "config-permissions", level: "warn", message: `Could not inspect config permissions: ${formatErrorMessage(error)}` });
    return { error: formatErrorMessage(error) };
  }
}

function inspectLocalToken(serverUrl, dataDir, checks) {
  const applicable = isLocalServer(serverUrl);
  const path = join(dataDir ? String(dataDir) : join(homedir(), ".inro"), "token");
  if (!applicable) {
    const exists = existsSync(path);
    checks.push({
      name: "local-token",
      level: "ok",
      message: exists
        ? `Local token file exists at ${path} but will be ignored because ${serverUrl} is not localhost.`
        : `Local token fallback skipped because ${serverUrl} is not localhost.`,
    });
    return { path, applicable: false, exists, used: false };
  }
  if (!existsSync(path)) {
    checks.push({ name: "local-token", level: "warn", message: `Local server token file not found at ${path}. Start Inro once or pass --token / set INRO_TOKEN.` });
    return { path, applicable: true, exists: false, used: false };
  }
  try {
    const mode = statSync(path).mode & 0o777;
    const secure = (mode & 0o077) === 0;
    checks.push({
      name: "local-token-permissions",
      level: secure ? "ok" : "warn",
      message: secure
        ? `Local token permissions are restrictive (${formatMode(mode)}).`
        : `Local token is group/world-readable (${formatMode(mode)}). Run: chmod 600 ${path}`,
    });
    return { path, applicable: true, exists: true, used: false, mode: formatMode(mode), secure };
  } catch (error) {
    checks.push({ name: "local-token-permissions", level: "warn", message: `Could not inspect local token permissions: ${formatErrorMessage(error)}` });
    return { path, applicable: true, exists: true, used: false, error: formatErrorMessage(error) };
  }
}

function resolveToken({ args, config, serverUrl, localTokenInfo, checks }) {
  let token;
  let source = "none";
  if (args.token) {
    token = String(args.token);
    source = "cli";
  } else if (process.env.INRO_TOKEN) {
    token = process.env.INRO_TOKEN;
    source = "env";
  } else if (config?.token && config?.serverUrl && normalizeServerUrl(config.serverUrl) === serverUrl) {
    token = String(config.token);
    source = "config";
  } else if (localTokenInfo.applicable && localTokenInfo.exists) {
    token = readFileSync(localTokenInfo.path, "utf8").trim();
    source = "local-token";
    localTokenInfo.used = true;
  }

  if (token) {
    checks.push({ name: "token", level: "ok", message: `Token found from ${source}; token value was not printed.` });
  } else {
    const mismatch = config?.token && config?.serverUrl && normalizeServerUrl(config.serverUrl) !== serverUrl;
    checks.push({
      name: "token",
      level: "error",
      message: mismatch
        ? `No token found for ${serverUrl}. Config contains a token for ${normalizeServerUrl(config.serverUrl)}, so it was ignored. Run setup-inro-skill.mjs with the resolved server URL, set INRO_TOKEN, or pass --token.`
        : isLocalServer(serverUrl)
          ? "No token found. Set INRO_TOKEN, pass --token, run setup-inro-skill.mjs, or start Inro once so ~/.inro/token exists."
          : "No hosted-server token found. Set INRO_TOKEN, pass --token, or run setup-inro-skill.mjs --server URL --token TOKEN.",
    });
  }
  return { token, source };
}

async function checkApiEndpoint(serverUrl, tokenResolution, checks) {
  const requestUrl = joinServerPath(serverUrl, "/api/documents");
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (tokenResolution.token) headers.authorization = `Bearer ${tokenResolution.token}`;

  let response;
  try {
    response = await fetch(requestUrl, { method: "POST", headers, body: "{}" });
  } catch (error) {
    const message = networkDiagnostic(error, serverUrl);
    checks.push({ name: "api-reachability", level: "error", message });
    return { reachable: false, requestUrl, error: sanitize(message) };
  }

  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const html = contentType.includes("text/html") || looksLikeHtml(text);
  const diagnostic = apiStatusDiagnostic(response.status, text, contentType, tokenResolution, requestUrl);
  checks.push({ name: "api-reachability", level: diagnostic.level, message: diagnostic.message });
  return {
    reachable: response.status !== 0,
    requestUrl,
    status: response.status,
    contentType,
    expectedInroApi: diagnostic.expectedInroApi,
    htmlResponse: html,
  };
}

function apiStatusDiagnostic(status, text, contentType, tokenResolution, requestUrl) {
  if (status === 400 && contentType.includes("application/json")) {
    return { level: "ok", expectedInroApi: true, message: "Inro API endpoint is reachable and the token was accepted." };
  }
  if ((status === 401 || status === 403) && tokenResolution.token) {
    return { level: "error", expectedInroApi: true, message: `Inro API rejected the token (${status}). Check that token source (${tokenResolution.source}) matches this server.` };
  }
  if ((status === 401 || status === 403) && !tokenResolution.token) {
    return { level: "warn", expectedInroApi: true, message: `Inro API is reachable but requires a token (${status}). Configure a token and retry.` };
  }
  if (status === 404) {
    return { level: "error", expectedInroApi: false, message: `API endpoint not found at ${requestUrl}. Check the server URL, reverse-proxy base path, and that this is an Inro server.` };
  }
  if (status >= 500) {
    return { level: "error", expectedInroApi: true, message: `Server returned ${status}. Check Inro server logs or reverse-proxy upstream health.` };
  }
  if (contentType.includes("text/html") || looksLikeHtml(text)) {
    return { level: "error", expectedInroApi: false, message: `Expected JSON from Inro API but received HTML (${status}). This often indicates a proxy login page, wrong base path, or non-Inro service.` };
  }
  return { level: "warn", expectedInroApi: false, message: `Unexpected response from API endpoint (${status}, ${contentType || "unknown content type"}). Check server URL and proxy configuration.` };
}

function isLocalServer(serverUrl) {
  const host = new URL(serverUrl).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function joinServerPath(serverUrl, path) {
  return `${serverUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

function networkDiagnostic(error, serverUrl) {
  const message = formatErrorMessage(error);
  const code = error?.cause?.code ?? error?.code;
  if (code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || /self.?signed|certificate/i.test(message)) {
    return `TLS certificate verification failed for ${serverUrl}. Use a trusted certificate, fix the proxy certificate chain, or connect through a trusted tunnel. (${message})`;
  }
  if (code === "ECONNREFUSED" || /ECONNREFUSED/i.test(message)) {
    return `Could not connect to Inro server at ${serverUrl}. Check that Inro is running, host/port are reachable, and any tunnel or reverse proxy is up. (${message})`;
  }
  return `Could not reach Inro server at ${serverUrl}: ${message}`;
}

function looksLikeHtml(text) {
  return /^\s*<!doctype html|^\s*<html[\s>]/i.test(text);
}

function formatMode(mode) {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

function printTextReport(report) {
  console.log("Inro doctor diagnostics");
  console.log(`Server: ${report.serverUrl}`);
  console.log(`Endpoint: ${report.requestUrl}`);
  console.log(`Source Agent: ${report.sourceAgent}`);
  console.log(`Token found: ${report.token.found ? "yes" : "no"}${report.token.source !== "none" ? ` (${report.token.source})` : ""}`);
  console.log("");
  for (const check of report.checks) {
    const prefix = check.level === "ok" ? "OK" : check.level === "warn" ? "WARN" : check.level === "error" ? "ERROR" : "INFO";
    console.log(`${prefix}: ${check.message}`);
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function fail(message, options = {}) {
  throw new InroDoctorError(sanitize(message), options);
}

function handleError(error, asJson) {
  const message = sanitize(formatErrorMessage(error));
  if (asJson) {
    const payload = error instanceof InroDoctorError
      ? { ok: false, error: { code: error.code, message, status: error.status, details: error.details } }
      : { ok: false, error: { code: "unexpected_error", message } };
    console.error(JSON.stringify(payload, null, 2));
  } else {
    console.error(message);
  }
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

function printHelp() {
  console.log(`Diagnose Inro agent skill HTTP setup without printing tokens.

Usage:
  node scripts/inro-doctor.mjs [options]

Options:
  --server URL                 Inro server URL; otherwise INRO_SERVER_URL, config, or localhost
  --token TOKEN                Bearer token; otherwise INRO_TOKEN, matching config, or local ~/.inro/token
  --config FILE                Client config from setup-inro-skill.mjs, default ~/.inro/client-config.json
  --data-dir DIR               Directory containing local server token file
  --source-agent NAME          Source Agent identity used for diagnostics metadata
  --json                       Emit stable machine-readable JSON without prose
`);
}
