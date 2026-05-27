import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildInroServer } from "../src/server/app.js";
import { openInroDatabase } from "../src/persistence/sqlite.js";

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("HTTP API and browser UI", () => {
  it("exchanges the browser token for a session cookie", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-api-"));
    const store = openInroDatabase(join(dir, "inro.sqlite"));
    const app = buildInroServer({ store, token: "browser-token", publicBaseUrl: "http://127.0.0.1:0" });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/login",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "token=browser-token",
      });
      assert.equal(login.statusCode, 302);
      const cookie = login.headers["set-cookie"];
      assert.match(String(cookie), /inro_session=/);

      const index = await app.inject({ method: "GET", url: "/", headers: { cookie: String(cookie) } });
      assert.equal(index.statusCode, 200);
      assert.match(index.body, /Documents/);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires authentication, creates a Markdown Document, renders it in the UI, and persists after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-api-"));
    const dbPath = join(dir, "inro.sqlite");
    const token = "test-token";
    try {
      let store = openInroDatabase(dbPath);
      let app = buildInroServer({ store, token, publicBaseUrl: "http://127.0.0.1:0" });

      const rejected = await app.inject({ method: "POST", url: "/api/documents", payload: {} });
      assert.equal(rejected.statusCode, 401);

      const created = await app.inject({
        method: "POST",
        url: "/api/documents",
        headers: auth(token),
        payload: {
          title: "Calculus note",
          documentKey: "calc/main",
          format: "markdown",
          content: "# Calculus\n\nInline $x^2$.",
          sourceAgent: "test-agent",
          revisionSummary: "initial",
        },
      });
      assert.equal(created.statusCode, 201);
      const body = created.json() as { documentId: string; revisionId: string; latestUrl: string; revisionUrl: string };
      assert.ok(body.documentId);
      assert.ok(body.revisionId);
      assert.equal(body.latestUrl, `/d/${body.documentId}`);
      assert.equal(body.revisionUrl, `/d/${body.documentId}/r/${body.revisionId}`);

      const index = await app.inject({ method: "GET", url: "/", headers: auth(token) });
      assert.equal(index.statusCode, 200);
      assert.match(index.body, /Calculus note/);
      assert.match(index.body, /test-agent/);

      const detail = await app.inject({ method: "GET", url: body.latestUrl, headers: auth(token) });
      assert.equal(detail.statusCode, 200);
      assert.match(detail.body, /Latest Revision/);
      assert.match(detail.body, /<h1>Calculus<\/h1>/);
      assert.match(detail.body, /katex/);
      assert.match(detail.body, /initial/);

      await app.close();
      store.close();

      store = openInroDatabase(dbPath);
      app = buildInroServer({ store, token, publicBaseUrl: "http://127.0.0.1:0" });
      const afterRestart = await app.inject({ method: "GET", url: body.latestUrl, headers: auth(token) });
      assert.equal(afterRestart.statusCode, 200);
      assert.match(afterRestart.body, /Calculus note/);
      assert.match(afterRestart.body, /<h1>Calculus<\/h1>/);
      await app.close();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects oversized submissions with 413 without preserving partial content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-api-"));
    const store = openInroDatabase(join(dir, "inro.sqlite"));
    const app = buildInroServer({ store, token: "token", publicBaseUrl: "http://127.0.0.1:0", bodyLimit: 128 });
    try {
      const oversized = await app.inject({
        method: "POST",
        url: "/api/documents",
        headers: auth("token"),
        payload: { title: "Too large", format: "markdown", content: "x".repeat(500), sourceAgent: "agent" },
      });
      assert.equal(oversized.statusCode, 413);

      const index = await app.inject({ method: "GET", url: "/", headers: auth("token") });
      assert.doesNotMatch(index.body, /Too large/);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates retry-safe submissions by Source Agent, endpoint, and Idempotency Key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-api-"));
    const store = openInroDatabase(join(dir, "inro.sqlite"));
    const app = buildInroServer({ store, token: "token", publicBaseUrl: "http://127.0.0.1:0" });
    try {
      const payload = { title: "Retry", format: "markdown", content: "one", sourceAgent: "agent", idempotencyKey: "retry-1" };
      const first = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload });
      const second = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload: { ...payload, content: "would duplicate" } });
      assert.equal(first.statusCode, 201);
      assert.equal(second.statusCode, 200);
      assert.deepEqual(second.json(), first.json());

      const index = await app.inject({ method: "GET", url: "/", headers: auth("token") });
      assert.match(index.body, /<td>1<\/td>/);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 409 for duplicate Document Key and appends immutable Revisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-api-"));
    const store = openInroDatabase(join(dir, "inro.sqlite"));
    const app = buildInroServer({ store, token: "token", publicBaseUrl: "http://127.0.0.1:0" });
    try {
      const first = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload: { title: "Plan", documentKey: "plan", format: "markdown", content: "one", sourceAgent: "a" } });
      assert.equal(first.statusCode, 201);
      const firstBody = first.json() as { documentId: string; revisionId: string };

      const duplicate = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload: { title: "Plan 2", documentKey: "plan", format: "markdown", content: "dup", sourceAgent: "a" } });
      assert.equal(duplicate.statusCode, 409);

      const appended = await app.inject({ method: "POST", url: `/api/documents/${firstBody.documentId}/revisions`, headers: auth("token"), payload: { format: "markdown", content: "two", sourceAgent: "b", revisionSummary: "second" } });
      assert.equal(appended.statusCode, 201);
      const appendedBody = appended.json() as { revisionId: string };
      assert.notEqual(appendedBody.revisionId, firstBody.revisionId);

      const historical = await app.inject({ method: "GET", url: `/d/${firstBody.documentId}/r/${firstBody.revisionId}`, headers: auth("token") });
      assert.match(historical.body, /Historical Revision/);
      assert.match(historical.body, /one/);

      const latest = await app.inject({ method: "GET", url: `/d/${firstBody.documentId}`, headers: auth("token") });
      assert.match(latest.body, /Latest Revision/);
      assert.match(latest.body, /two/);
      assert.match(latest.body, /multiple Source Agents/);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
