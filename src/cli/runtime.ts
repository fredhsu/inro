import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimeOptions {
  dataDir?: string;
  tokenOverride?: string;
}

export interface InroRuntime {
  dataDir: string;
  dbPath: string;
  tokenPath: string;
  token: string;
}

export function defaultDataDir(): string {
  return process.env.INRO_DATA_DIR ?? join(homedir(), ".inro");
}

export function prepareRuntime(options: RuntimeOptions = {}): InroRuntime {
  const dataDir = options.dataDir ?? defaultDataDir();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { chmodSync(dataDir, 0o700); } catch {}

  const dbPath = join(dataDir, "inro.sqlite");
  const tokenPath = join(dataDir, "token");
  const token = options.tokenOverride ?? readOrCreateToken(tokenPath);
  return { dataDir, dbPath, tokenPath, token };
}

export function readToken(dataDir = defaultDataDir()): string | undefined {
  const tokenPath = join(dataDir, "token");
  if (!existsSync(tokenPath)) return undefined;
  return readFileSync(tokenPath, "utf8").trim();
}

function readOrCreateToken(tokenPath: string): string {
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  try { chmodSync(tokenPath, 0o600); } catch {}
  return token;
}
