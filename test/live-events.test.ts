import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLiveEvents } from "../src/live-events/live-events.js";

describe("Live Events", () => {
  it("publishes separate global and Document-scoped events", () => {
    const events = createLiveEvents();
    const global: unknown[] = [];
    const documentEvents: unknown[] = [];

    const unsubscribeGlobal = events.subscribeGlobal((event) => global.push(event));
    const unsubscribeDocument = events.subscribeDocument("doc-1", (event) => documentEvents.push(event));

    events.publishGlobal({ type: "document-created", documentId: "doc-1", revisionId: "rev-1" });
    events.publishDocument("doc-1", { type: "revision-added", documentId: "doc-1", revisionId: "rev-2" });
    events.publishDocument("doc-2", { type: "revision-added", documentId: "doc-2", revisionId: "rev-x" });

    assert.deepEqual(global, [{ type: "document-created", documentId: "doc-1", revisionId: "rev-1" }]);
    assert.deepEqual(documentEvents, [{ type: "revision-added", documentId: "doc-1", revisionId: "rev-2" }]);

    unsubscribeGlobal();
    unsubscribeDocument();
  });
});
