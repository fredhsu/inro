import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { buildInroServer } from "../src/server/app.js";
import { openInroDatabase } from "../src/persistence/sqlite.js";

const execFile = promisify(execFileCallback);

const setupHelper = ".agents/skills/inro-preview/scripts/setup-inro-skill.mjs";
const sendHelper = ".agents/skills/inro-preview/scripts/send-inro-document.mjs";
const doctorHelper = ".agents/skills/inro-preview/scripts/inro-doctor.mjs";
const { INRO_TOKEN: _inroToken, INRO_SERVER_URL: _inroServerUrl, INRO_SOURCE_AGENT: _inroSourceAgent, ...helperEnv } = process.env;

describe("Inro agent skill helpers", () => {
  it("configures and uses a hosted server without printing the bearer token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-skill-helper-"));
    const token = "hosted-token";
    const store = openInroDatabase(join(dir, "inro.sqlite"));
    const app = buildInroServer({ store, token, publicBaseUrl: "http://127.0.0.1:0" });

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      assert.equal(typeof address, "object");
      const port = (address as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;
      const configPath = join(dir, "client-config.json");

      const setup = await execFile(process.execPath, [
        setupHelper,
        "--server", baseUrl,
        "--token", token,
        "--source-agent", "skill-test-agent",
        "--config", configPath,
      ], { env: helperEnv });
      assert.match(setup.stdout, /Inro skill configured/);
      assert.match(setup.stdout, new RegExp(baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(setup.stdout, new RegExp(token));
      assert.equal(statSync(configPath).mode & 0o777, 0o600);

      const filePath = join(dir, "hosted-note.md");
      writeFileSync(filePath, "# Hosted Note\n\nSent through skill config.", "utf8");

      const sent = await execFile(process.execPath, [sendHelper, filePath, "--config", configPath], { env: helperEnv });
      assert.match(sent.stdout, /Document: /);
      assert.doesNotMatch(sent.stdout, new RegExp(token));
      const latestUrl = sent.stdout.match(/^Document: (.+)$/m)?.[1];
      assert.ok(latestUrl);
      const detail = await fetch(latestUrl, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(detail.status, 200);
      const html = await detail.text();
      assert.match(html, /Hosted Note/);
      assert.match(html, /skill-test-agent/);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-runs without sending HTTP or leaking a remote local token fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-skill-helper-"));
    const token = "local-only-token";
    try {
      writeFileSync(join(dir, "token"), token, "utf8");
      const filePath = join(dir, "dry-run.md");
      writeFileSync(filePath, "# Dry run", "utf8");

      const result = await execFile(process.execPath, [
        sendHelper,
        filePath,
        "--server", "http://example.com:4317",
        "--config", join(dir, "missing-config.json"),
        "--data-dir", dir,
        "--dry-run",
        "--json",
      ], { env: helperEnv });

      const body = JSON.parse(result.stdout) as { dryRun: boolean; tokenFound: boolean; tokenSource: string; requestUrl: string };
      assert.equal(body.dryRun, true);
      assert.equal(body.tokenFound, false);
      assert.equal(body.tokenSource, "none");
      assert.equal(body.requestUrl, "http://example.com:4317/api/documents");
      assert.doesNotMatch(result.stdout, new RegExp(token));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits JSON only for successful sends when --json is used", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-skill-helper-"));
    const token = "json-token";
    const store = openInroDatabase(join(dir, "inro.sqlite"));
    const app = buildInroServer({ store, token, publicBaseUrl: "http://127.0.0.1:0" });

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      assert.equal(typeof address, "object");
      const baseUrl = `http://127.0.0.1:${(address as { port: number }).port}`;
      const filePath = join(dir, "json-note.md");
      writeFileSync(filePath, "# JSON Note", "utf8");

      const sent = await execFile(process.execPath, [sendHelper, filePath, "--server", baseUrl, "--token", token, "--json"], { env: helperEnv });
      assert.doesNotMatch(sent.stdout, /^Document: /m);
      assert.doesNotMatch(sent.stdout, new RegExp(token));
      const body = JSON.parse(sent.stdout) as { ok: boolean; documentId: string; latestUrl: string };
      assert.equal(body.ok, true);
      assert.ok(body.documentId);
      assert.match(body.latestUrl, new RegExp(`^${escapeRegExp(baseUrl)}/d/`));
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves reverse-proxy base paths in API and returned relative URLs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-skill-helper-"));
    const token = "base-path-token";
    const filePath = join(dir, "base-path.html");
    writeFileSync(filePath, "<h1>Base path</h1>", "utf8");
    let requestPath = "";

    const server = await startMockServer((request, response) => {
      requestPath = request.url ?? "";
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ documentId: "doc1", revisionId: "rev1", latestUrl: "/d/doc1", revisionUrl: "/d/doc1/r/rev1" }));
    });

    try {
      const sent = await execFile(process.execPath, [sendHelper, filePath, "--server", `${server.url}/inro`, "--token", token, "--json"], { env: helperEnv });
      const body = JSON.parse(sent.stdout) as { latestUrl: string; revisionUrl: string };
      assert.equal(requestPath, "/inro/api/documents");
      assert.equal(body.latestUrl, `${server.url}/inro/d/doc1`);
      assert.equal(body.revisionUrl, `${server.url}/inro/d/doc1/r/rev1`);
      assert.doesNotMatch(sent.stdout, new RegExp(token));
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diagnoses config/server mismatches without printing tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-skill-helper-"));
    const token = "mismatch-token";
    try {
      const configPath = join(dir, "client-config.json");
      writeFileSync(configPath, JSON.stringify({ serverUrl: "http://127.0.0.1:1", token }, null, 2), "utf8");

      const failure = await rejectsExecFile(process.execPath, [
        doctorHelper,
        "--config", configPath,
        "--server", "http://127.0.0.1:2",
        "--data-dir", join(dir, "empty-data"),
        "--json",
      ]);
      const body = JSON.parse(failure.stdout) as { ok: boolean; token: { found: boolean; source: string }; checks: { message: string }[] };
      assert.equal(body.ok, false);
      assert.equal(body.token.found, false);
      assert.equal(body.token.source, "none");
      assert.ok(body.checks.some((check) => check.message.includes("does not match resolved server")));
      assert.doesNotMatch(failure.stdout, new RegExp(token));
      assert.doesNotMatch(failure.stderr, new RegExp(token));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints actionable HTTP diagnostics without leaking tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-skill-helper-"));
    const token = "bad-token-value";
    const filePath = join(dir, "error-note.md");
    writeFileSync(filePath, "# Error", "utf8");

    const server = await startMockServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
    });

    try {
      const failure = await rejectsExecFile(process.execPath, [sendHelper, filePath, "--server", server.url, "--token", token]);
      assert.match(failure.stderr, /rejected the bearer token/);
      assert.match(failure.stderr, /token source \(cli\)/);
      assert.doesNotMatch(failure.stderr, new RegExp(token));
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diagnoses HTML proxy responses as non-JSON API failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-skill-helper-"));
    const token = "html-proxy-token";
    const filePath = join(dir, "proxy-note.md");
    writeFileSync(filePath, "# Proxy", "utf8");

    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><html><body>proxy login</body></html>");
    });

    try {
      const failure = await rejectsExecFile(process.execPath, [sendHelper, filePath, "--server", server.url, "--token", token]);
      assert.match(failure.stderr, /Expected JSON from Inro API but received HTML/);
      assert.doesNotMatch(failure.stderr, new RegExp(token));
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function rejectsExecFile(command: string, args: string[]) {
  try {
    await execFile(command, args, { env: helperEnv });
  } catch (error) {
    return error as { stdout: string; stderr: string; code: number };
  }
  assert.fail("Expected command to fail");
}

async function startMockServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const url = `http://127.0.0.1:${(address as { port: number }).port}`;
  return {
    url,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
