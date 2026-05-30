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
        <div class="seal" aria-hidden="true">印</div>
        <h1>Inro</h1>
        <p class="tagline">印籠 · agent documents</p>
        <form method="post" action="/login">
          <label>Access token <input name="token" type="password" autofocus autocomplete="current-password" /></label>
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
      const readDot = document.isUnread ? `<span class="unread-dot" aria-hidden="true"></span>` : "";
      return `<tr>
        <td class="title-cell${document.isUnread ? " unread" : ""}">${readDot}<a href="/d/${document.id}">${escapeHtml(document.title)}</a></td>
        <td><time datetime="${escapeHtml(document.updatedAt)}" title="${escapeHtml(document.updatedAt)}">${escapeHtml(updated)}</time></td>
        <td><span class="agent">${icon("agent")}${escapeHtml(document.latestSourceAgent)}</span>${multiple}</td>
        <td>${documentActions(document, "/", { iconOnlyReadState: true, iconOnlyDelete: true })}</td>
      </tr>`;
    }).join("\n");

    return reply.type("text/html").send(page("Inro Documents", `
      ${masthead()}
      <main>
        <h1>Documents</h1>
        <table class="ledger">
          <thead><tr><th>Title</th><th>Updated</th><th>Source Agent</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="4"><div class="empty">${icon("inbox")}<p>No Documents yet.</p></div></td></tr>`}</tbody>
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

  app.post("/d/:id/read", async (request, reply) => {
    try {
      documents.markRead((request.params as { id: string }).id);
      return reply.redirect(readReturnTo(request.body));
    } catch (error) {
      if (error instanceof DocumentNotFoundError) return reply.status(404).type("text/html").send(page("Not found", "<p>Document not found.</p>"));
      throw error;
    }
  });

  app.post("/d/:id/unread", async (request, reply) => {
    try {
      documents.markUnread((request.params as { id: string }).id);
      return reply.redirect(readReturnTo(request.body));
    } catch (error) {
      if (error instanceof DocumentNotFoundError) return reply.status(404).type("text/html").send(page("Not found", "<p>Document not found.</p>"));
      throw error;
    }
  });

  app.get("/d/:id", async (request, reply) => {
    const documentId = (request.params as { id: string }).id;
    let document = documents.getDocument(documentId);
    if (!document) return reply.status(404).type("text/html").send(page("Not found", "<p>Document not found.</p>"));
    if (document.isUnread) {
      documents.markRead(document.id);
      document = documents.getDocument(document.id)!;
    }
    const revision = documents.getRevision(document.latestRevisionId)!;
    return reply.type("text/html").send(documentPage({ label: "Latest Revision", document, revision, revisions: documents.listRevisions(document.id) }));
  });

  app.get("/d/:id/r/:revisionId", async (request, reply) => {
    const { id, revisionId } = request.params as { id: string; revisionId: string };
    let document = documents.getDocument(id);
    const revision = documents.getRevision(revisionId);
    if (!document || !revision || revision.documentId !== id) return reply.status(404).type("text/html").send(page("Not found", "<p>Revision not found.</p>"));
    if (revision.id === document.latestRevisionId && document.isUnread) {
      documents.markRead(document.id);
      document = documents.getDocument(document.id)!;
    }
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
  const timeline = input.revisions.map((revision) => {
    const isLatest = revision.id === input.document.latestRevisionId;
    return `<li class="${isLatest ? "latest" : ""}">
    <a href="/d/${input.document.id}/r/${revision.id}">${isLatest ? "Latest Revision" : "Revision"}</a>
    <span class="who"><time datetime="${escapeHtml(revision.createdAt)}">${escapeHtml(formatTimestamp(revision.createdAt))}</time> · ${escapeHtml(revision.sourceAgent)}</span>
    ${revision.revisionSummary ? `<em>${escapeHtml(revision.revisionSummary)}</em>` : ""}
  </li>`;
  }).join("\n");
  const multiple = input.document.sourceAgents.length > 1 ? `<p class="notice">This Document has multiple Source Agents.</p>` : "";

  return page(input.document.title, `
    ${masthead()}
    <main>
      <a class="back" href="/">${icon("arrow-left")}Documents</a>
      <div class="document-header">
        <h1>${escapeHtml(input.document.title)}</h1>
        ${documentActions(input.document, "/")}
      </div>
      <p class="meta">
        <span class="label">${escapeHtml(input.label)}</span>
        <span class="sep">·</span>${readState(input.document)}
        <span class="sep">·</span><span class="mi">${icon(input.revision.format === "html" ? "code" : "markdown")}${escapeHtml(input.revision.format)}</span>
        <span class="sep">·</span><span class="mi">${icon("agent")}${escapeHtml(input.revision.sourceAgent)}</span>
      </p>
      ${multiple}
      ${preview}
      <details>
        <summary>${icon("code")}Source</summary>
        <pre><code>${escapeHtml(input.revision.content)}</code></pre>
      </details>
      <h2>Revision timeline</h2>
      <ol class="timeline">${timeline}</ol>
    </main>
    ${liveReloadScript(`/d/${input.document.id}/events`)}
  `);
}

function documentActions(document: { id: string; title: string; isRead?: boolean }, returnTo: string, options: { iconOnlyReadState?: boolean; iconOnlyDelete?: boolean } = {}): string {
  return `<div class="document-actions">
    ${readStateForm(document, returnTo, options)}
    ${deleteDocumentForm(document, options)}
  </div>`;
}

function readStateForm(document: { id: string; title?: string; isRead?: boolean }, returnTo: string, options: { iconOnlyReadState?: boolean } = {}): string {
  const read = document.isRead === true;
  const action = read ? "unread" : "read";
  const label = read ? "Mark unread" : "Mark read";
  const buttonContent = options.iconOnlyReadState ? icon(read ? "envelope" : "envelope-open") : escapeHtml(label);
  const accessibleLabel = options.iconOnlyReadState ? ` aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"` : "";
  return `<form method="post" action="/d/${document.id}/${action}" class="read-state-form">
    <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
    <button type="submit" class="ghost"${accessibleLabel}>${buttonContent}</button>
  </form>`;
}

function readState(document: { isRead: boolean }): string {
  return document.isRead
    ? `<span class="read-state read">Read</span>`
    : `<span class="read-state unread">Unread</span>`;
}

function deleteDocumentForm(document: { id: string; title: string }, options: { iconOnlyDelete?: boolean } = {}): string {
  const label = options.iconOnlyDelete ? "" : "Delete";
  const accessibleLabel = options.iconOnlyDelete ? ` aria-label="Delete ${escapeHtml(document.title)}" title="Delete"` : "";
  return `<form method="post" action="/d/${document.id}/delete" class="delete-document">
    <button type="submit" class="ghost-danger"${accessibleLabel} data-confirm="${deleteConfirmation(document.title)}" onclick="return confirm(this.dataset.confirm)">${icon("trash")}${label}</button>
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
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css" />
  <link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&display=swap" />
  <style>
    :root {
      --washi: #f1ead9;
      --surface: #fbf7ee;
      --ink: #221c16;
      --ink-soft: #6f6253;
      --line: #ddd0bb;
      --cinnabar: #bd3b2a;
      --cinnabar-deep: #95281b;
      --radius: 14px;
    }
    * { box-sizing: border-box; }
    body {
      font: 16px/1.6 "Satoshi", system-ui, sans-serif; margin: 0; color: var(--ink);
      background: var(--washi);
      background-image: radial-gradient(120% 90% at 50% -10%, #f7f1e3 0%, var(--washi) 55%, #e7dcc6 100%);
      min-height: 100vh; -webkit-font-smoothing: antialiased;
    }
    body::before {
      content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0; opacity: .04;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    }
    .wrap { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }

    .masthead { display: flex; align-items: center; gap: .85rem; margin-bottom: 2.5rem; animation: rise .55s both; }
    .seal {
      flex: none; width: 46px; height: 46px; border-radius: 9px; display: grid; place-items: center;
      background: linear-gradient(150deg, var(--cinnabar), var(--cinnabar-deep)); color: #fcefe4;
      font-size: 24px; line-height: 1; font-weight: 700; transform: rotate(-3deg);
      box-shadow: 0 2px 0 rgba(149,40,27,.5), inset 0 0 0 1px rgba(255,255,255,.14);
    }
    .wordmark { display: flex; flex-direction: column; text-decoration: none; color: var(--ink); }
    .wordmark b { font-family: "Newsreader", Georgia, serif; font-weight: 600; font-size: 1.7rem; letter-spacing: -.01em; line-height: 1; }
    .wordmark span { font-size: .68rem; letter-spacing: .16em; text-transform: uppercase; color: var(--ink-soft); margin-top: .4rem; }

    main { animation: rise .55s .08s both; }
    h1 { font-family: "Newsreader", Georgia, serif; font-weight: 600; letter-spacing: -.015em; font-size: 2rem; margin: 0 0 1.25rem; }
    h2 { font-family: "Newsreader", Georgia, serif; font-weight: 500; font-size: 1.3rem; margin: 2.75rem 0 1rem; }
    a { color: var(--ink); text-decoration-color: var(--line); text-underline-offset: 3px; }
    a:hover { text-decoration-color: var(--cinnabar); }
    .icon { width: 1em; height: 1em; flex: none; vertical-align: -.14em; }
    .back { display: inline-flex; align-items: center; gap: .4rem; font-size: .85rem; color: var(--ink-soft); text-decoration: none; margin-bottom: 1.5rem; }
    .back:hover { color: var(--cinnabar); }

    .ledger { width: 100%; border-collapse: collapse; font-size: .95rem; }
    .ledger thead th { text-align: left; font-weight: 500; font-size: .68rem; letter-spacing: .13em; text-transform: uppercase; color: var(--ink-soft); padding: 0 .75rem .7rem; border-bottom: 1px solid var(--line); }
    .ledger tbody td { padding: .9rem .75rem; border-bottom: 1px solid var(--line); vertical-align: middle; }
    .ledger tbody tr:last-child td { border-bottom: 0; }
    .ledger tbody tr:hover td { background: rgba(189,59,42,.04); }
    .ledger .title-cell a { font-family: "Newsreader", Georgia, serif; font-size: 1.05rem; font-weight: 500; text-decoration: none; }
    .ledger .title-cell.unread a { font-weight: 600; }
    .ledger .title-cell a:hover { color: var(--cinnabar); }
    .unread-dot { display: inline-block; width: .5rem; height: .5rem; border-radius: 999px; background: var(--cinnabar); margin-right: .45rem; vertical-align: .08em; }
    .ledger .num { font-variant-numeric: tabular-nums; color: var(--ink-soft); }
    .empty { display: flex; flex-direction: column; align-items: center; gap: .65rem; text-align: center; color: var(--ink-soft); padding: 3rem 1rem; }
    .empty .icon { width: 1.9rem; height: 1.9rem; color: var(--line); }
    .empty p { margin: 0; }

    .tag { display: inline-flex; align-items: center; gap: .35rem; font: 600 .68rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-soft); border: 1px solid var(--line); border-radius: 999px; padding: .3rem .55rem; }
    .agent { display: inline-flex; align-items: center; gap: .4rem; }
    .agent .icon { color: var(--ink-soft); }
    .badge { display: inline-block; font-size: .64rem; letter-spacing: .08em; text-transform: uppercase; color: var(--cinnabar-deep); border: 1px solid rgba(189,59,42,.4); border-radius: 999px; padding: .14rem .45rem; margin-left: .4rem; }
    time { color: var(--ink-soft); font-variant-numeric: tabular-nums; }

    .document-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
    .meta { color: var(--ink-soft); font-size: .9rem; margin: -.5rem 0 1.5rem; }
    .meta .label { color: var(--cinnabar-deep); font-weight: 600; }
    .meta .mi { display: inline-flex; align-items: center; gap: .35rem; }
    .meta .icon { color: var(--ink-soft); }
    .read-state { display: inline-flex; align-items: center; border-radius: 999px; padding: .13rem .45rem; font-size: .65rem; line-height: 1.2; letter-spacing: .08em; text-transform: uppercase; }
    .read-state.read { color: var(--ink-soft); border: 1px solid var(--line); }
    .read-state.unread { color: var(--cinnabar-deep); border: 1px solid rgba(189,59,42,.4); }
    .meta .sep { opacity: .4; margin: 0 .55rem; }
    .notice { color: var(--cinnabar-deep); font-size: .9rem; border-left: 2px solid var(--cinnabar); padding-left: .8rem; margin: 1.25rem 0; }

    .preview, .preview-frame { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
    .preview { padding: 1.75rem 2rem; }
    .preview-frame { width: 100%; min-height: 70vh; }

    details { margin: 1.5rem 0; }
    summary { display: inline-flex; align-items: center; gap: .4rem; cursor: pointer; font-size: .78rem; color: var(--ink-soft); letter-spacing: .06em; text-transform: uppercase; list-style: none; }
    summary::-webkit-details-marker { display: none; }
    summary:hover { color: var(--cinnabar); }
    pre { padding: 1.1rem 1.25rem; overflow: auto; background: #211c17; color: #f3ece0; border-radius: 10px; font-size: .85rem; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

    .timeline { list-style: none; margin: 0; padding: 0; border-left: 1px solid var(--line); }
    .timeline li { position: relative; padding: 0 0 1.4rem 1.6rem; }
    .timeline li::before { content: ""; position: absolute; left: -5px; top: .4rem; width: 9px; height: 9px; border-radius: 50%; background: var(--washi); border: 1px solid var(--ink-soft); }
    .timeline li.latest::before { background: var(--cinnabar); border-color: var(--cinnabar); }
    .timeline a { font-family: "Newsreader", Georgia, serif; font-weight: 500; text-decoration: none; }
    .timeline .who { color: var(--ink-soft); font-size: .85rem; margin-left: .55rem; }
    .timeline em { display: block; color: var(--ink-soft); font-size: .9rem; margin-top: .15rem; }

    .document-actions { display: flex; align-items: center; justify-content: flex-end; gap: .45rem; }
    .delete-document, .read-state-form { margin: 0; }
    .ghost, .ghost-danger { display: inline-flex; align-items: center; gap: .4rem; font: inherit; font-size: .8rem; color: var(--ink-soft); cursor: pointer; background: none; border: 1px solid var(--line); border-radius: 8px; padding: .45rem .75rem; transition: color .15s, border-color .15s, background .15s; white-space: nowrap; }
    .ghost:hover { color: var(--cinnabar); border-color: var(--cinnabar); background: rgba(189,59,42,.04); }
    .ghost-danger:hover { color: #fcefe4; background: var(--cinnabar); border-color: var(--cinnabar); }

    .login { max-width: 360px; margin: 14vh auto 0; text-align: center; animation: rise .55s both; }
    .login .seal { margin: 0 auto 1.25rem; transform: rotate(-3deg); }
    .login h1 { font-size: 2.4rem; margin-bottom: .25rem; }
    .login .tagline { color: var(--ink-soft); font-size: .78rem; letter-spacing: .16em; text-transform: uppercase; margin: 0 0 2rem; }
    .login form { display: grid; gap: .9rem; text-align: left; }
    .login label { display: grid; gap: .35rem; font-size: .78rem; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-soft); }
    .login input { font: inherit; text-transform: none; letter-spacing: normal; padding: .7rem .85rem; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--ink); }
    .login input:focus { outline: 2px solid var(--cinnabar); outline-offset: 1px; border-color: transparent; }
    .login button { font: 600 1rem/1 "Satoshi", sans-serif; cursor: pointer; color: #fcefe4; background: linear-gradient(150deg, var(--cinnabar), var(--cinnabar-deep)); border: 0; border-radius: 10px; padding: .85rem 1rem; margin-top: .35rem; }
    .login button:hover { filter: brightness(1.06); }

    .markdown-body :first-child { margin-top: 0; }
    .markdown-body h1, .markdown-body h2, .markdown-body h3 { font-family: "Newsreader", Georgia, serif; line-height: 1.25; }
    .markdown-body h1 { font-size: 1.7rem; margin: 1.8rem 0 .8rem; }
    .markdown-body h2 { font-size: 1.35rem; margin: 1.6rem 0 .7rem; }
    .markdown-body h3 { font-size: 1.12rem; margin: 1.4rem 0 .6rem; }
    .markdown-body p, .markdown-body ul, .markdown-body ol { margin: 0 0 1rem; }
    .markdown-body a { color: var(--cinnabar-deep); }
    .markdown-body code { background: rgba(33,28,23,.06); padding: .15em .4em; border-radius: 5px; font-size: .9em; }
    .markdown-body pre code { background: none; padding: 0; }
    .markdown-body blockquote { margin: 1rem 0; padding: .25rem 0 .25rem 1rem; border-left: 3px solid var(--cinnabar); color: var(--ink-soft); }
    .markdown-body hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }
    .markdown-body table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    .markdown-body th, .markdown-body td { border: 1px solid var(--line); padding: .5rem .7rem; text-align: left; }
    .markdown-body img { max-width: 100%; }

    @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { *, ::before { animation: none !important; } }
  </style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}

function masthead(): string {
  return `<header class="masthead">
    <div class="seal" aria-hidden="true">印</div>
    <a class="wordmark" href="/"><b>Inro</b><span>印籠 · agent documents</span></a>
  </header>`;
}

const iconPaths: Record<string, string> = {
  "arrow-left": '<path d="M19 12H5"/><path d="M11 18l-6-6 6-6"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/>',
  envelope: '<rect x="4" y="6" width="16" height="12" rx="1.5"/><path d="m4.5 7 7.5 6 7.5-6"/>',
  "envelope-open": '<path d="M4 10v8h16v-8"/><path d="m4 10 8 6 8-6"/><path d="m4 10 8-6 8 6"/>',
  code: '<path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/>',
  markdown: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M9 13h6"/><path d="M9 17h4"/>',
  agent: '<rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9.5 9.5h5v5h-5z"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
};

function icon(name: keyof typeof iconPaths): string {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name]}</svg>`;
}

function formatTag(format: string): string {
  return `<span class="tag">${icon(format === "html" ? "code" : "markdown")}${escapeHtml(format)}</span>`;
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

function readReturnTo(body: unknown): string {
  const returnTo = readFormField(body, "returnTo");
  return returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
}

function readFormField(body: unknown, field: string): string | undefined {
  if (typeof body === "string") return new URLSearchParams(body).get(field) ?? undefined;
  if (body && typeof body === "object" && field in body) return String((body as Record<string, unknown>)[field]);
  return undefined;
}

function readFormToken(body: unknown): string | undefined {
  return readFormField(body, "token");
}
