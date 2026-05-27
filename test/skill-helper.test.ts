import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { buildInroServer } from "../src/server/app.js";
import { openInroDatabase } from "../src/persistence/sqlite.js";

const execFile = promisify(execFileCallback);

const setupHelper = ".agents/skills/inro-preview/scripts/setup-inro-skill.mjs";
const sendHelper = ".agents/skills/inro-preview/scripts/send-inro-document.mjs";

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
      ]);
      assert.match(setup.stdout, /Inro skill configured/);
      assert.match(setup.stdout, new RegExp(baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(setup.stdout, new RegExp(token));
      assert.equal(statSync(configPath).mode & 0o777, 0o600);

      const filePath = join(dir, "hosted-note.md");
      writeFileSync(filePath, "# Hosted Note\n\nSent through skill config.", "utf8");

      const sent = await execFile(process.execPath, [sendHelper, filePath, "--config", configPath]);
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
});
