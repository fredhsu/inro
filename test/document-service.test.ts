import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openInroDatabase } from "../src/persistence/sqlite.js";
import { DocumentKeyConflictError, createDocumentService } from "../src/services/document-service.js";

function withStore<T>(fn: (dbPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "inro-service-"));
  try {
    return fn(join(dir, "inro.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Document Service", () => {
  it("creates a Document with an immutable first Revision and display-only title", () => withStore((dbPath) => {
    const store = openInroDatabase(dbPath);
    const service = createDocumentService(store);

    const created = service.createDocument({
      title: "Math notes",
      documentKey: "notes/main",
      format: "markdown",
      content: "# Hello",
      sourceAgent: "agent-a",
      revisionSummary: "first draft",
    });

    const document = service.getDocument(created.documentId);
    assert.equal(document?.title, "Math notes");
    assert.equal(document?.documentKey, "notes/main");
    assert.equal(document?.latestRevisionId, created.revisionId);
    assert.equal(document?.revisionCount, 1);

    const revision = service.getRevision(created.revisionId);
    assert.equal(revision?.documentId, created.documentId);
    assert.equal(revision?.content, "# Hello");
    assert.equal(revision?.sourceAgent, "agent-a");
    assert.equal(revision?.revisionSummary, "first draft");
    store.close();
  }));

  it("rejects duplicate Document Keys on create but does not treat matching titles as identity", () => withStore((dbPath) => {
    const store = openInroDatabase(dbPath);
    const service = createDocumentService(store);

    service.createDocument({ title: "Same", documentKey: "stable", format: "markdown", content: "A", sourceAgent: "agent-a" });
    assert.throws(
      () => service.createDocument({ title: "Different", documentKey: "stable", format: "markdown", content: "B", sourceAgent: "agent-a" }),
      DocumentKeyConflictError,
    );

    const second = service.createDocument({ title: "Same", format: "markdown", content: "C", sourceAgent: "agent-a" });
    assert.ok(second.documentId);
    assert.equal(service.listDocuments().length, 2);
    store.close();
  }));

  it("appends Revisions, advances latest Revision, and preserves older Revisions", () => withStore((dbPath) => {
    const store = openInroDatabase(dbPath);
    const service = createDocumentService(store);

    const first = service.createDocument({ title: "Plan", format: "markdown", content: "one", sourceAgent: "agent-a" });
    const second = service.appendRevision(first.documentId, {
      format: "markdown",
      content: "two",
      sourceAgent: "agent-b",
      revisionSummary: "expanded",
    });

    const document = service.getDocument(first.documentId);
    assert.equal(document?.latestRevisionId, second.revisionId);
    assert.equal(document?.revisionCount, 2);
    assert.equal(document?.latestSourceAgent, "agent-b");
    assert.deepEqual(document?.sourceAgents.sort(), ["agent-a", "agent-b"]);
    assert.equal(service.getRevision(first.revisionId)?.content, "one");
    assert.equal(service.getRevision(second.revisionId)?.content, "two");
    store.close();
  }));
});
