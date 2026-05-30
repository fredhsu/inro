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
      store.updateLatestRevision(body.documentId, body.revisionId, "2025-05-10T15:45:00.000Z", "markdown");

      const index = await app.inject({ method: "GET", url: "/", headers: auth(token) });
      assert.equal(index.statusCode, 200);
      assert.match(index.body, /Calculus note/);
      assert.match(index.body, /test-agent/);
      assert.match(index.body, /<time datetime="2025-05-10T15:45:00\.000Z" title="2025-05-10T15:45:00\.000Z">May 10, 2025,/);

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

  it("deduplicates retry-safe Submissions by Source Agent, target, and Idempotency Key", async () => {
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

      const detail = await app.inject({ method: "GET", url: (first.json() as { latestUrl: string }).latestUrl, headers: auth("token") });
      assert.equal((detail.body.match(/<li class="latest">/g) ?? []).length, 1);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows and updates read/unread state with server-rendered controls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-api-"));
    const store = openInroDatabase(join(dir, "inro.sqlite"));
    const app = buildInroServer({ store, token: "token", publicBaseUrl: "http://127.0.0.1:0" });
    try {
      const created = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload: { title: "Read Me", format: "markdown", content: "one", sourceAgent: "a" } });
      const { documentId } = created.json() as { documentId: string };

      const unreadIndex = await app.inject({ method: "GET", url: "/", headers: auth("token") });
      assert.match(unreadIndex.body, /<td class="title-cell unread"><span class="unread-dot" aria-hidden="true"><\/span><a href="\/d\/[^"]+">Read Me<\/a><\/td>/);
      assert.doesNotMatch(unreadIndex.body, /unread-badge/);
      assert.match(unreadIndex.body, new RegExp(`action="/d/${documentId}/read"`));
      assert.match(unreadIndex.body, /aria-label="Mark read" title="Mark read"><svg class="icon"/);
      assert.doesNotMatch(unreadIndex.body, />Mark read<\/button>/);

      const markedRead = await app.inject({ method: "POST", url: `/d/${documentId}/read`, headers: auth("token") });
      assert.equal(markedRead.statusCode, 302);
      assert.equal(markedRead.headers.location, "/");
      const readIndex = await app.inject({ method: "GET", url: "/", headers: auth("token") });
      assert.doesNotMatch(readIndex.body, /<td class="title-cell unread">[\s\S]*Read Me/);
      assert.match(readIndex.body, new RegExp(`action="/d/${documentId}/unread"`));
      assert.match(readIndex.body, /aria-label="Mark unread" title="Mark unread"><svg class="icon"/);
      assert.doesNotMatch(readIndex.body, />Mark unread<\/button>/);

      const markedUnread = await app.inject({ method: "POST", url: `/d/${documentId}/unread`, headers: auth("token") });
      assert.equal(markedUnread.statusCode, 302);
      const unreadAgain = await app.inject({ method: "GET", url: "/", headers: auth("token") });
      assert.match(unreadAgain.body, /<td class="title-cell unread">[\s\S]*Read Me/);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks only the latest Revision as read when it is opened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-api-"));
    const store = openInroDatabase(join(dir, "inro.sqlite"));
    const app = buildInroServer({ store, token: "token", publicBaseUrl: "http://127.0.0.1:0" });
    try {
      const created = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload: { title: "Reader", format: "markdown", content: "one", sourceAgent: "a" } });
      const { documentId, revisionId } = created.json() as { documentId: string; revisionId: string };
      await app.inject({ method: "POST", url: `/d/${documentId}/read`, headers: auth("token") });
      await app.inject({ method: "POST", url: `/api/documents/${documentId}/revisions`, headers: auth("token"), payload: { format: "markdown", content: "two", sourceAgent: "b" } });

      const historical = await app.inject({ method: "GET", url: `/d/${documentId}/r/${revisionId}`, headers: auth("token") });
      assert.equal(historical.statusCode, 200);
      let index = await app.inject({ method: "GET", url: "/", headers: auth("token") });
      assert.match(index.body, /<td class="title-cell unread">[\s\S]*Reader/);

      const latest = await app.inject({ method: "GET", url: `/d/${documentId}`, headers: auth("token") });
      assert.equal(latest.statusCode, 200);
      assert.match(latest.body, /<span class="read-state read">Read<\/span>/);
      index = await app.inject({ method: "GET", url: "/", headers: auth("token") });
      assert.doesNotMatch(index.body, /<td class="title-cell unread">[\s\S]*Reader/);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows minimal Delete Document controls in the listing and reader", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-api-"));
    const store = openInroDatabase(join(dir, "inro.sqlite"));
    const app = buildInroServer({ store, token: "token", publicBaseUrl: "http://127.0.0.1:0" });
    try {
      const created = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload: { title: "Danger & Math", format: "markdown", content: "one", sourceAgent: "a" } });
      const { documentId } = created.json() as { documentId: string };

      const index = await app.inject({ method: "GET", url: "/", headers: auth("token") });
      assert.equal(index.statusCode, 200);
      assert.doesNotMatch(index.body, /htmx\.org/);
      assert.doesNotMatch(index.body, /hx-delete/);
      assert.match(index.body, new RegExp(`action="/d/${documentId}/delete"`));
      assert.match(index.body, /aria-label="Delete Danger &amp; Math" title="Delete"/);
      assert.doesNotMatch(index.body, /Delete<\/button>/);
      assert.match(index.body, /data-confirm="Delete “Danger &amp; Math” and all of its Revisions\? This cannot be undone\."/);
      assert.match(index.body, /onclick="return confirm\(this\.dataset\.confirm\)"/);

      const detail = await app.inject({ method: "GET", url: `/d/${documentId}`, headers: auth("token") });
      assert.equal(detail.statusCode, 200);
      assert.match(detail.body, new RegExp(`action="/d/${documentId}/delete"`));
      assert.match(detail.body, /Delete<\/button>/);
      assert.doesNotMatch(detail.body, /hx-delete/);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hard-deletes a Document from htmx and fallback browser routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-api-"));
    const store = openInroDatabase(join(dir, "inro.sqlite"));
    const app = buildInroServer({ store, token: "token", publicBaseUrl: "http://127.0.0.1:0" });
    try {
      const rowDoc = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload: { title: "Row", format: "markdown", content: "one", sourceAgent: "a" } });
      const rowId = (rowDoc.json() as { documentId: string }).documentId;
      const rowDelete = await app.inject({ method: "DELETE", url: `/d/${rowId}`, headers: { ...auth("token"), "hx-request": "true" } });
      assert.equal(rowDelete.statusCode, 204);
      const rowDetail = await app.inject({ method: "GET", url: `/d/${rowId}`, headers: auth("token") });
      assert.equal(rowDetail.statusCode, 404);

      const pageDoc = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload: { title: "Page", format: "markdown", content: "two", sourceAgent: "a" } });
      const pageId = (pageDoc.json() as { documentId: string }).documentId;
      const pageDelete = await app.inject({ method: "DELETE", url: `/d/${pageId}`, headers: { ...auth("token"), "hx-request": "true", "hx-target": "body" } });
      assert.equal(pageDelete.statusCode, 204);
      assert.equal(pageDelete.headers["hx-redirect"], "/");

      const fallbackDoc = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload: { title: "Fallback", format: "markdown", content: "three", sourceAgent: "a" } });
      const fallbackId = (fallbackDoc.json() as { documentId: string }).documentId;
      const fallbackDelete = await app.inject({ method: "POST", url: `/d/${fallbackId}/delete`, headers: auth("token") });
      assert.equal(fallbackDelete.statusCode, 302);
      assert.equal(fallbackDelete.headers.location, "/");
      const fallbackDetail = await app.inject({ method: "GET", url: `/d/${fallbackId}`, headers: auth("token") });
      assert.equal(fallbackDetail.statusCode, 404);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes live events when a Document is deleted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-api-"));
    const store = openInroDatabase(join(dir, "inro.sqlite"));
    const globalEvents: unknown[] = [];
    const documentEvents: unknown[] = [];
    const liveEvents = {
      publishGlobal: (event: unknown) => { globalEvents.push(event); },
      publishDocument: (_documentId: string, event: unknown) => { documentEvents.push(event); },
      subscribeGlobal: () => () => {},
      subscribeDocument: () => () => {},
    };
    const app = buildInroServer({ store, token: "token", publicBaseUrl: "http://127.0.0.1:0", liveEvents });
    try {
      const created = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload: { title: "Delete event", format: "markdown", content: "one", sourceAgent: "a" } });
      const { documentId } = created.json() as { documentId: string };
      globalEvents.length = 0;

      const deleted = await app.inject({ method: "DELETE", url: `/api/documents/${documentId}`, headers: auth("token") });
      assert.equal(deleted.statusCode, 204);
      assert.deepEqual(globalEvents, [{ type: "document-deleted", documentId }]);
      assert.deepEqual(documentEvents, [{ type: "document-deleted", documentId }]);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears idempotency records that reference a hard-deleted Document", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-api-"));
    const store = openInroDatabase(join(dir, "inro.sqlite"));
    const app = buildInroServer({ store, token: "token", publicBaseUrl: "http://127.0.0.1:0" });
    try {
      const payload = { title: "Retry Delete", format: "markdown", content: "one", sourceAgent: "agent", idempotencyKey: "retry-delete" };
      const first = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload });
      assert.equal(first.statusCode, 201);
      const firstBody = first.json() as { documentId: string };

      const deleted = await app.inject({ method: "DELETE", url: `/api/documents/${firstBody.documentId}`, headers: auth("token") });
      assert.equal(deleted.statusCode, 204);

      const retried = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload: { ...payload, title: "Retry Delete Recreated" } });
      assert.equal(retried.statusCode, 201);
      const retriedBody = retried.json() as { documentId: string };
      assert.notEqual(retriedBody.documentId, firstBody.documentId);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hard-deletes a Document and all Revisions through the API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-api-"));
    const store = openInroDatabase(join(dir, "inro.sqlite"));
    const app = buildInroServer({ store, token: "token", publicBaseUrl: "http://127.0.0.1:0" });
    try {
      const created = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload: { title: "Delete me", documentKey: "delete-me", format: "markdown", content: "one", sourceAgent: "a" } });
      assert.equal(created.statusCode, 201);
      const createdBody = created.json() as { documentId: string; revisionId: string };
      const appended = await app.inject({ method: "POST", url: `/api/documents/${createdBody.documentId}/revisions`, headers: auth("token"), payload: { format: "markdown", content: "two", sourceAgent: "b" } });
      assert.equal(appended.statusCode, 201);

      const deleted = await app.inject({ method: "DELETE", url: `/api/documents/${createdBody.documentId}`, headers: auth("token") });
      assert.equal(deleted.statusCode, 204);
      assert.equal(deleted.body, "");

      const detail = await app.inject({ method: "GET", url: `/d/${createdBody.documentId}`, headers: auth("token") });
      assert.equal(detail.statusCode, 404);
      const historical = await app.inject({ method: "GET", url: `/d/${createdBody.documentId}/r/${createdBody.revisionId}`, headers: auth("token") });
      assert.equal(historical.statusCode, 404);
      const recreated = await app.inject({ method: "POST", url: "/api/documents", headers: auth("token"), payload: { title: "Recreated", documentKey: "delete-me", format: "markdown", content: "new", sourceAgent: "a" } });
      assert.equal(recreated.statusCode, 201);
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
