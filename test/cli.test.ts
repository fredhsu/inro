import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { prepareRuntime } from "../src/cli/runtime.js";
import { sendFile } from "../src/cli/send.js";
import { buildInroServer } from "../src/server/app.js";
import { openInroDatabase } from "../src/persistence/sqlite.js";

describe("CLI bootstrap and inro send", () => {
  it("creates and reuses a persistent bearer token with restrictive permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-runtime-"));
    try {
      const first = prepareRuntime({ dataDir: dir });
      const second = prepareRuntime({ dataDir: dir });
      assert.equal(second.token, first.token);
      assert.equal(first.dbPath, join(dir, "inro.sqlite"));
      assert.equal(statSync(first.tokenPath).mode & 0o777, 0o600);

      const overridden = prepareRuntime({ dataDir: dir, tokenOverride: "manual-token" });
      assert.equal(overridden.token, "manual-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends a local Markdown file to the authenticated server and prints the Document URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inro-send-"));
    const token = "send-token";
    const store = openInroDatabase(join(dir, "inro.sqlite"));
    const app = buildInroServer({ store, token, publicBaseUrl: "http://127.0.0.1:0" });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      assert.equal(typeof address, "object");
      const port = (address as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;
      const filePath = join(dir, "agent-note.md");
      writeFileSync(filePath, "# Agent Note\n\nHello $x^2$", "utf8");

      const sent = await sendFile({ filePath, serverUrl: baseUrl, token, sourceAgent: "cli-test" });
      assert.match(sent.message, /Document created:/);
      assert.equal(sent.latestUrl, `${baseUrl}/d/${sent.documentId}`);

      const detail = await fetch(sent.latestUrl, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(detail.status, 200);
      assert.match(await detail.text(), /Agent Note/);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
