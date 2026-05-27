import { basename, extname } from "node:path";
import { readFileSync } from "node:fs";
import type { RevisionFormat } from "../domain/types.js";
import { readToken } from "./runtime.js";

export interface SendFileOptions {
  filePath: string;
  serverUrl?: string;
  token?: string;
  dataDir?: string;
  title?: string;
  format?: RevisionFormat;
  documentKey?: string;
  sourceAgent?: string;
  revisionSummary?: string;
}

export interface SendFileResult {
  documentId: string;
  revisionId: string;
  latestUrl: string;
  revisionUrl: string;
  message: string;
}

interface ApiCreateResponse {
  documentId: string;
  revisionId: string;
  latestUrl: string;
  revisionUrl: string;
}

export async function sendFile(options: SendFileOptions): Promise<SendFileResult> {
  const serverUrl = (options.serverUrl ?? process.env.INRO_SERVER_URL ?? "http://127.0.0.1:4317").replace(/\/$/, "");
  const token = options.token ?? process.env.INRO_TOKEN ?? readToken(options.dataDir);
  if (!token) throw new Error("No Inro token available. Pass --token or start the server once to create one.");

  const content = readFileSync(options.filePath, "utf8");
  const format = options.format ?? inferFormat(options.filePath);
  const title = options.title ?? inferTitle(options.filePath);

  const response = await fetch(`${serverUrl}/api/documents`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title,
      format,
      content,
      documentKey: options.documentKey,
      sourceAgent: options.sourceAgent ?? "inro-cli",
      revisionSummary: options.revisionSummary,
    }),
  });

  if (!response.ok) {
    throw new Error(`Inro send failed (${response.status}): ${await response.text()}`);
  }
  const body = await response.json() as ApiCreateResponse;
  const latestUrl = absolutize(serverUrl, body.latestUrl);
  const revisionUrl = absolutize(serverUrl, body.revisionUrl);
  return {
    documentId: body.documentId,
    revisionId: body.revisionId,
    latestUrl,
    revisionUrl,
    message: `Document created: ${latestUrl}`,
  };
}

function inferFormat(filePath: string): RevisionFormat {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  return "markdown";
}

function inferTitle(filePath: string): string {
  const name = basename(filePath);
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

function absolutize(serverUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${serverUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}
