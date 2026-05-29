import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { RevisionFormat } from "../domain/types.js";
import { createLiveEvents, type LiveEvent, type LiveEvents } from "../live-events/live-events.js";
import { escapeHtml, renderRevision } from "../rendering/rendering.js";
import { DocumentKeyConflictError, DocumentNotFoundError, createDocumentService } from "../services/document-service.js";
import { createSubmissionService } from "../services/submission-service.js";
import type { InroStore } from "../persistence/sqlite.js";

export interface BuildServerOptions {
  store: InroStore;
  token: string;
  publicBaseUrl: string;
  bodyLimit?: number;
  liveEvents?: LiveEvents;
}

interface CreateDocumentBody {
  title?: string;
  documentKey?: string;
  format?: RevisionFormat;
  content?: string;
  sourceAgent?: string;
  revisionSummary?: string;
  idempotencyKey?: string;
}

interface AppendRevisionBody {
  format?: RevisionFormat;
  content?: string;
  sourceAgent?: string;
  revisionSummary?: string;
  idempotencyKey?: string;
}

export function buildInroServer(options: BuildServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: options.bodyLimit ?? 1024 * 1024 });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => done(null, body));
  void app.register(cookie);
  const documents = createDocumentService(options.store);
  const liveEvents = options.liveEvents ?? createLiveEvents();
  const submissions = createSubmissionService({ documents, idempotencyRecords: options.store, liveEvents, publicBaseUrl: options.publicBaseUrl });
  const deleteDocument = (documentId: string) => {
    documents.deleteDocument(documentId);
    liveEvents.publishGlobal({ type: "document-deleted", documentId });
    liveEvents.publishDocument(documentId, { type: "document-deleted", documentId });
  };

  app.setErrorHandler((error, _request, reply) => {
    if ((error as { statusCode?: number }).statusCode === 413) {
      return reply.status(413).send({ error: "Payload Too Large" });
    }
    app.log.error(error);
    return reply.status(500).send({ error: "Internal Server Error" });
  });

  app.get("/login", async (_request, reply) => {
    return reply.type("text/html").send(page("Inro Login", `
      <main class="login">
        <h1>Inro</h1>
        <form method="post" action="/login">
          <label>Token <input name="token" type="password" autofocus /></label>
          <button type="submit">Open Inro</button>
        </form>
      </main>
    `));
  });

  app.post("/login", async (request, reply) => {
    const token = readFormToken(request.body);
    if (token !== options.token) return reply.status(401).type("text/html").send(page("Inro Login", "<p>Invalid token.</p>"));
    return reply.setCookie("inro_session", options.token, { httpOnly: true, sameSite: "lax", path: "/" }).redirect("/");
  });

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/login") return;
    if (isAuthorized(request, options.token)) return;
    if (request.url.startsWith("/api/")) return reply.status(401).send({ error: "Unauthorized" });
    return reply.redirect("/login");
  });

  app.post("/api/documents", async (request, reply) => {
    const body = request.body as CreateDocumentBody;
    const validation = validateCreate(body);
    if (validation) return reply.status(400).send({ error: validation });

    try {
      const outcome = submissions.submitRevision({
        target: { kind: "new-document", title: body.title!, documentKey: emptyToUndefined(body.documentKey) },
        format: body.format!,
        content: body.content!,
        sourceAgent: body.sourceAgent!,
        revisionSummary: emptyToUndefined(body.revisionSummary),
        idempotencyKey: emptyToUndefined(body.idempotencyKey),
      });
      return reply.status(outcome.replayed ? 200 : 201).send(outcome.response);
    } catch (error) {
      if (error instanceof DocumentKeyConflictError) return reply.status(409).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/api/documents/:id", async (request, reply) => {
    try {
      deleteDocument((request.params as { id: string }).id);
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof DocumentNotFoundError) return reply.status(404).send({ error: error.message });
      throw error;
    }
  });

  app.post("/api/documents/:id/revisions", async (request, reply) => {
    const body = request.body as AppendRevisionBody;
    const validation = validateAppend(body);
    if (validation) return reply.status(400).send({ error: validation });
    try {
      const outcome = submissions.submitRevision({
        target: { kind: "existing-document", documentId: (request.params as { id: string }).id },
        format: body.format!,
        content: body.content!,
        sourceAgent: body.sourceAgent!,
        revisionSummary: emptyToUndefined(body.revisionSummary),
        idempotencyKey: emptyToUndefined(body.idempotencyKey),
      });
      return reply.status(outcome.replayed ? 200 : 201).send(outcome.response);
    } catch (error) {
      if (error instanceof DocumentNotFoundError) return reply.status(404).send({ error: error.message });
      throw error;
    }
  });

  app.get("/events", async (request, reply) => {
    return openSse(request, reply, (send) => liveEvents.subscribeGlobal(send));
  });

  app.get("/d/:id/events", async (request, reply) => {
    const documentId = (request.params as { id: string }).id;
    return openSse(request, reply, (send) => liveEvents.subscribeDocument(documentId, send));
  });

  app.get("/", async (_request, reply) => {
    const rows = documents.listDocuments().map((document) => {
      const multiple = document.sourceAgents.length > 1 ? " <span class=\"badge\">multiple Source Agents</span>" : "";
      const updated = formatTimestamp(document.updatedAt);
      return `<tr>
        <td><a href="/d/${document.id}">${escapeHtml(document.title)}</a></td>
        <td>${escapeHtml(document.format)}</td>
        <td><time datetime="${escapeHtml(document.updatedAt)}" title="${escapeHtml(document.updatedAt)}">${escapeHtml(updated)}</time></td>
        <td>${document.revisionCount}</td>
        <td>${escapeHtml(document.latestSourceAgent)}${multiple}</td>
        <td>${deleteDocumentForm(document, "row")}</td>
      </tr>`;
    }).join("\n");

    return reply.type("text/html").send(page("Inro Documents", `
      <main>
        <h1>Documents</h1>
        <table>
          <thead><tr><th>Title</th><th>Format</th><th>Updated</th><th>Revisions</th><th>Source Agent</th><th>Actions</th></tr></thead>
          <tbody>${rows || "<tr><td colspan=\"6\">No Documents yet.</td></tr>"}</tbody>
        </table>
      </main>
      ${liveReloadScript("/events")}
    `));
  });

  app.delete("/d/:id", async (request, reply) => {
    try {
      deleteDocument((request.params as { id: string }).id);
      if (request.headers["hx-target"] === "body") return reply.header("HX-Redirect", "/").status(204).send();
      return reply.status(204).send();
    } catch (error) {
      if (error instanceof DocumentNotFoundError) return reply.status(404).type("text/html").send(page("Not found", "<p>Document not found.</p>"));
      throw error;
    }
  });

  app.post("/d/:id/delete", async (request, reply) => {
    try {
      deleteDocument((request.params as { id: string }).id);
      return reply.redirect("/");
    } catch (error) {
      if (error instanceof DocumentNotFoundError) return reply.status(404).type("text/html").send(page("Not found", "<p>Document not found.</p>"));
      throw error;
    }
  });

  app.get("/d/:id", async (request, reply) => {
    const document = documents.getDocument((request.params as { id: string }).id);
    if (!document) return reply.status(404).type("text/html").send(page("Not found", "<p>Document not found.</p>"));
    const revision = documents.getRevision(document.latestRevisionId)!;
    return reply.type("text/html").send(documentPage({ label: "Latest Revision", document, revision, revisions: documents.listRevisions(document.id) }));
  });

  app.get("/d/:id/r/:revisionId", async (request, reply) => {
    const { id, revisionId } = request.params as { id: string; revisionId: string };
    const document = documents.getDocument(id);
    const revision = documents.getRevision(revisionId);
    if (!document || !revision || revision.documentId !== id) return reply.status(404).type("text/html").send(page("Not found", "<p>Revision not found.</p>"));
    const label = revision.id === document.latestRevisionId ? "Latest Revision" : "Historical Revision";
    return reply.type("text/html").send(documentPage({ label, document, revision, revisions: documents.listRevisions(document.id) }));
  });

  return app;
}

function isAuthorized(request: FastifyRequest, token: string): boolean {
  const header = request.headers.authorization;
  if (header === `Bearer ${token}`) return true;
  if (request.cookies?.inro_session === token) return true;
  const queryToken = (request.query as { token?: string } | undefined)?.token;
  return queryToken === token;
}

function openSse(request: FastifyRequest, reply: FastifyReply, subscribe: (send: (event: LiveEvent) => void) => () => void): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  reply.raw.write(": connected\n\n");
  const unsubscribe = subscribe((event) => {
    reply.raw.write(`event: ${event.type}\n`);
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  request.raw.on("close", unsubscribe);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function documentPage(input: { label: string; document: ReturnType<ReturnType<typeof createDocumentService>["getDocument"]> extends infer D ? NonNullable<D> : never; revision: NonNullable<ReturnType<ReturnType<typeof createDocumentService>["getRevision"]>>; revisions: NonNullable<ReturnType<ReturnType<typeof createDocumentService>["getRevision"]>>[] }) {
  const rendered = renderRevision({ format: input.revision.format, content: input.revision.content });
  const preview = rendered.mode === "iframe"
    ? `<iframe class="preview-frame" sandbox="${rendered.sandbox}" srcdoc="${escapeHtml(rendered.html)}"></iframe>`
    : `<section class="preview markdown-body">${rendered.html}</section>`;
  const timeline = input.revisions.map((revision) => `<li>
    <a href="/d/${input.document.id}/r/${revision.id}">${revision.id === input.document.latestRevisionId ? "latest" : "revision"}</a>
    <time>${escapeHtml(revision.createdAt)}</time>
    <span>${escapeHtml(revision.sourceAgent)}</span>
    ${revision.revisionSummary ? `<em>${escapeHtml(revision.revisionSummary)}</em>` : ""}
  </li>`).join("\n");
  const multiple = input.document.sourceAgents.length > 1 ? `<p class="notice">This Document has multiple Source Agents.</p>` : "";

  return page(input.document.title, `
    <main>
      <p><a href="/">← Documents</a></p>
      <div class="document-header">
        <h1>${escapeHtml(input.document.title)}</h1>
        ${deleteDocumentForm(input.document, "page")}
      </div>
      <p class="label">${input.label}</p>
      <p>Format: ${escapeHtml(input.revision.format)} · Source Agent: ${escapeHtml(input.revision.sourceAgent)}</p>
      ${multiple}
      ${preview}
      <details>
        <summary>Source</summary>
        <pre><code>${escapeHtml(input.revision.content)}</code></pre>
      </details>
      <h2>Revision timeline</h2>
      <ol>${timeline}</ol>
    </main>
    ${liveReloadScript(`/d/${input.document.id}/events`)}
  `);
}

function deleteDocumentForm(document: { id: string; title: string }, variant: "row" | "page"): string {
  const target = variant === "row" ? "closest tr" : "body";
  const swap = variant === "row" ? "outerHTML" : "innerHTML";
  return `<form method="post" action="/d/${document.id}/delete" class="delete-document" hx-delete="/d/${document.id}" hx-target="${target}" hx-swap="${swap}">
    <button type="submit" class="danger" data-confirm="${deleteConfirmation(document.title)}" onclick="return confirm(this.dataset.confirm)">Delete Document</button>
  </form>`;
}

function deleteConfirmation(title: string): string {
  return escapeHtml(`Delete “${title}” and all of its Revisions? This cannot be undone.`);
}

function liveReloadScript(path: string): string {
  return `<script>
    (() => {
      if (!window.EventSource) return;
      const events = new EventSource(${JSON.stringify(path)});
      const reload = () => window.location.reload();
      events.addEventListener("document-created", reload);
      events.addEventListener("latest-revision-changed", reload);
      events.addEventListener("revision-added", reload);
      events.addEventListener("document-deleted", reload);
    })();
  </script>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Inro</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css">
  <script src="https://unpkg.com/htmx.org@2.0.4" defer></script>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #f7f4ef; color: #211a14; }
    main { max-width: 960px; margin: 2rem auto; padding: 1rem; background: white; border: 1px solid #e3d8ca; border-radius: 12px; }
    table { width: 100%; border-collapse: collapse; } th, td { padding: .5rem; border-bottom: 1px solid #eadfD2; text-align: left; }
    pre { padding: 1rem; overflow: auto; background: #191714; color: #f8f4eb; border-radius: 8px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .preview { padding: 1rem; border: 1px solid #eadfd2; border-radius: 8px; }
    .preview-frame { width: 100%; min-height: 70vh; border: 1px solid #eadfd2; border-radius: 8px; background: white; }
    .label, .badge, .notice { font-weight: 700; color: #7a3f00; }
    .document-header { display: flex; justify-content: space-between; gap: 1rem; align-items: start; }
    .delete-document { margin: 0; }
    .danger { color: #8a1f11; border: 1px solid #c99; background: #fff8f6; border-radius: 6px; padding: .35rem .6rem; cursor: pointer; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function validateCreate(body: CreateDocumentBody): string | undefined {
  if (!body || typeof body !== "object") return "JSON body required";
  if (!body.title) return "title is required";
  return validateAppend(body as AppendRevisionBody);
}

function validateAppend(body: AppendRevisionBody): string | undefined {
  if (!body || typeof body !== "object") return "JSON body required";
  if (body.format !== "markdown" && body.format !== "html") return "format must be markdown or html";
  if (typeof body.content !== "string") return "content is required";
  if (!body.sourceAgent) return "sourceAgent is required";
  return undefined;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function readFormToken(body: unknown): string | undefined {
  if (typeof body === "string") return new URLSearchParams(body).get("token") ?? undefined;
  if (body && typeof body === "object" && "token" in body) return String((body as { token: unknown }).token);
  return undefined;
}
