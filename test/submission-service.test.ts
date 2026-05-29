import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { LiveEvent, LiveEvents } from "../src/live-events/live-events.js";
import { openInroDatabase } from "../src/persistence/sqlite.js";
import { createDocumentService } from "../src/services/document-service.js";
import { createSubmissionService } from "../src/services/submission-service.js";

function withStore<T>(fn: (dbPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "inro-submission-"));
  try {
    return fn(join(dir, "inro.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function recordingLiveEvents(): LiveEvents & { globalEvents: LiveEvent[]; documentEvents: LiveEvent[] } {
  const globalEvents: LiveEvent[] = [];
  const documentEvents: LiveEvent[] = [];
  return {
    globalEvents,
    documentEvents,
    publishGlobal(event) { globalEvents.push(event); },
    publishDocument(_documentId, event) { documentEvents.push(event); },
    subscribeGlobal: () => () => {},
    subscribeDocument: () => () => {},
  };
}

describe("Submission module", () => {
  it("deduplicates a retried new Document Submission without publishing duplicate live events", () => withStore((dbPath) => {
    const store = openInroDatabase(dbPath);
    const liveEvents = recordingLiveEvents();
    const documents = createDocumentService(store);
    const submissions = createSubmissionService({ documents, idempotencyRecords: store, liveEvents, publicBaseUrl: "http://inro.test" });

    const first = submissions.submitRevision({
      target: { kind: "new-document", title: "Retry" },
      format: "markdown",
      content: "one",
      sourceAgent: "agent",
      idempotencyKey: "retry-1",
    });
    const second = submissions.submitRevision({
      target: { kind: "new-document", title: "Retry changed" },
      format: "markdown",
      content: "would duplicate",
      sourceAgent: "agent",
      idempotencyKey: "retry-1",
    });

    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.response, first.response);
    assert.equal(documents.listDocuments().length, 1);
    assert.equal(documents.getDocument(first.response.documentId)?.revisionCount, 1);
    assert.deepEqual(liveEvents.globalEvents, [{ type: "document-created", documentId: first.response.documentId, revisionId: first.response.revisionId }]);
    assert.deepEqual(liveEvents.documentEvents, []);
    store.close();
  }));

  it("scopes append idempotency by Source Agent and target Document", () => withStore((dbPath) => {
    const store = openInroDatabase(dbPath);
    const liveEvents = recordingLiveEvents();
    const documents = createDocumentService(store);
    const submissions = createSubmissionService({ documents, idempotencyRecords: store, liveEvents, publicBaseUrl: "http://inro.test" });

    const firstDocument = submissions.submitRevision({ target: { kind: "new-document", title: "A" }, format: "markdown", content: "a1", sourceAgent: "agent" });
    const secondDocument = submissions.submitRevision({ target: { kind: "new-document", title: "B" }, format: "markdown", content: "b1", sourceAgent: "agent" });
    liveEvents.globalEvents.length = 0;
    liveEvents.documentEvents.length = 0;

    const firstAppend = submissions.submitRevision({
      target: { kind: "existing-document", documentId: firstDocument.response.documentId },
      format: "markdown",
      content: "a2",
      sourceAgent: "agent",
      idempotencyKey: "daily",
    });
    const secondAppend = submissions.submitRevision({
      target: { kind: "existing-document", documentId: secondDocument.response.documentId },
      format: "markdown",
      content: "b2",
      sourceAgent: "agent",
      idempotencyKey: "daily",
    });
    const firstReplay = submissions.submitRevision({
      target: { kind: "existing-document", documentId: firstDocument.response.documentId },
      format: "markdown",
      content: "a2 changed",
      sourceAgent: "agent",
      idempotencyKey: "daily",
    });

    assert.equal(firstAppend.replayed, false);
    assert.equal(secondAppend.replayed, false);
    assert.equal(firstReplay.replayed, true);
    assert.equal(firstAppend.response.documentId, firstDocument.response.documentId);
    assert.equal(secondAppend.response.documentId, secondDocument.response.documentId);
    assert.notEqual(firstAppend.response.revisionId, secondAppend.response.revisionId);
    assert.deepEqual(firstReplay.response, firstAppend.response);
    assert.equal(documents.getDocument(firstDocument.response.documentId)?.revisionCount, 2);
    assert.equal(documents.getDocument(secondDocument.response.documentId)?.revisionCount, 2);
    assert.equal(liveEvents.globalEvents.length, 2);
    assert.equal(liveEvents.documentEvents.length, 2);
    store.close();
  }));
});
