---
title: "PRD: Inro MVP"
labels:
  - ready-for-agent
status: ready-for-agent
created_at: 2026-05-26
source: proof:sx7t3o45
---

# PRD: Inro MVP

## Problem Statement

The user needs a fast, reliable local inbox for agent-generated documents. Today, when an agent creates Markdown or HTML, the user has to copy content into a browser, temporary file, editor preview, or ad hoc server to inspect it. Those approaches are slow, lose history, and make it hard to compare or revisit earlier agent outputs.

The user wants a personal, one-user companion app that agents can send content to immediately, while the browser shows the latest safe preview and every accepted revision remains preserved.

## Solution

Build Inro as a local Node/TypeScript preview server shipped as an npm CLI package. Agents will submit source content to authenticated HTTP endpoints. The server will create Documents and immutable Revisions in SQLite, render previews on read, expose authenticated browser pages for the Document index and detail views, and preserve Revision history.

The MVP is text-first: Markdown with KaTeX math and sandboxed HTML with browser-supported MathML. The first milestone should prove the end-to-end workflow with Markdown: start server, generate token, send a file with `inro send`, view it in the authenticated browser UI, and verify persistence after restart.

## User Stories

1. As a user, I want to run Inro as a local preview server from the terminal, so that agents have a stable place to send generated content.
2. As a user, I want the server to bind to localhost by default, so that my generated documents are not exposed accidentally.
3. As a user, I want to choose a custom host for Tailscale or LAN access, so that I can view previews from another trusted device.
4. As a user, I want a loud warning when binding to a non-localhost address, so that I understand the exposure risk.
5. As a user, I want the server to generate a persistent bearer token on first run, so that agents can authenticate without manual setup every time.
6. As a user, I want the token stored with restrictive permissions, so that local credentials are not casually exposed.
7. As a user, I want to override the token explicitly, so that I can integrate the server into a custom workflow.
8. As an agent, I want to create a Document through an HTTP API, so that I can send generated content directly to the user.
9. As an agent, I want the create response to include a Document id, Revision id, latest URL, and Revision URL, so that I can report where the user can inspect the result.
10. As an agent, I want to append a Revision to an existing Document, so that iterative outputs stay grouped over time.
11. As a user, I want each accepted submission to become an immutable Revision, so that the history is trustworthy.
12. As a user, I want the latest Revision pointer to advance on each append, so that the default Document page always shows the most recent accepted output.
13. As a user, I want older Revisions to remain addressable, so that I can revisit prior agent output.
14. As an agent, I want to provide an optional Document Key, so that I can intentionally route future submissions to the same Document.
15. As a user, I want titles to be display-only, so that unrelated Documents with the same title do not accidentally merge.
16. As an agent, I want duplicate Document Keys on create to return a conflict, so that accidental merges are prevented.
17. As an agent, I want to provide a Source Agent identity per Revision, so that the user can see which client submitted each output.
18. As a user, I want the index page to show the latest Source Agent, so that I can understand where each Document came from.
19. As a user, I want the index page to indicate when multiple Source Agents contributed to a Document, so that the Document history is clearer.
20. As an agent, I want to provide an optional Revision Summary, so that the user can scan what changed.
21. As a user, I want the Revision timeline to show timestamps, Source Agent, and Revision Summary, so that I can navigate history quickly.
22. As an agent, I want retry-safe submissions with an Idempotency Key, so that network retries do not create duplicate Revisions.
23. As a user, I want the server to reject oversized submissions rather than strip content, so that preserved Revisions are complete and trustworthy.
24. As an agent, I want oversized submissions to return `413 Payload Too Large`, so that I know the content was not accepted.
25. As a user, I want Markdown to render in the browser, so that agent notes, plans, and explanations are readable immediately.
26. As a user, I want KaTeX math support in Markdown, so that mathematical agent output is readable.
27. As a user, I want fenced code blocks to render sensibly, so that generated technical content is usable.
28. As a user, I want HTML to render in a Sandboxed Preview, so that I can inspect generated HTML without granting it full browser powers.
29. As a user, I want browser-supported MathML preserved in HTML, so that math-heavy HTML can display correctly.
30. As a user, I want arbitrary HTML not to be scanned for LaTeX delimiters in the MVP, so that rendering behavior stays predictable.
31. As a user, I want rendered output derived from source on read, so that storage remains simple and source remains canonical.
32. As a user, I want a root index page listing all Documents newest-first, so that I can find recent agent outputs.
33. As a user, I want each index row to show title, format, update time, Revision count, and Source Agent information, so that I can choose the right Document quickly.
34. As a user, I want a Document detail page that shows the latest Sandboxed Preview by default, so that I immediately see the latest result.
35. As a user, I want to toggle between preview and source, so that I can inspect what the agent actually submitted.
36. As a user, I want `/d/:id` to always mean the latest Revision, so that the stable Document URL is useful for ongoing work.
37. As a user, I want Revision-specific URLs, so that historical references do not change when newer Revisions are added.
38. As a user, I want the UI to clearly distinguish latest and historical views, so that I do not confuse an old Revision for current output.
39. As a user, I want the browser UI to require authentication, so that Tailscale or LAN exposure does not make Documents public.
40. As a user, I want the browser token flow to establish a session cookie until browser close, so that normal browsing is convenient but not permanently remembered.
41. As an agent, I want API routes to require bearer authentication, so that only configured clients can submit content.
42. As a user, I want the index page to update when Documents are created or updated, so that I do not have to refresh manually.
43. As a user, I want a Document page to update when a new Revision is added, so that I can watch agent iterations arrive live.
44. As a developer, I want separate global and Document Server-Sent Event feeds, so that live refresh is simple and scoped.
45. As a user, I want an `inro send` helper, so that I can send a local Markdown file without hand-writing curl.
46. As an agent/tool author, I want a simple documented HTTP contract, so that integrating new agents is straightforward.
47. As a developer, I want local development commands to be simple, so that the MVP can be iterated quickly.
48. As a user, I want the server to persist Documents across restarts, so that the preview inbox is durable.
49. As a developer, I want a first milestone that is a thin vertical slice, so that the project proves value before adding complex formats and asset handling.
50. As a future developer, I want domain language to remain precise, so that Document, Revision, Document Key, Source Agent, Revision Summary, and Sandboxed Preview are not conflated.

## Implementation Decisions

- Build a local Node/TypeScript server.
- Ship as an npm package with CLI bins; keep `npm run dev` and `npm start` style local development flows.
- Use Fastify for HTTP routing, middleware, API routes, UI routes, and SSE endpoints.
- Use better-sqlite3 for local SQLite persistence.
- Use server-rendered HTML plus HTMX for browser interactions.
- Use minimal vanilla JavaScript only where needed for Server-Sent Events and small UI behavior.
- Avoid a full SPA framework in the MVP.
- Define a deep **Document Service** module that owns create/append semantics: Document creation, duplicate Document Key conflicts, Revision append, latest Revision advancement, and immutable Revision guarantees.
- Define a deep **Persistence** module that hides SQLite details behind stable operations for Documents, Revisions, idempotency records, and token/config data.
- Define a deep **Rendering** module that accepts Revision source and format and returns safe preview HTML or source output. Markdown and HTML rendering should be externally testable through this interface.
- Define an **Auth** module that handles bearer token validation, first-run token generation, token persistence, UI login/session cookie creation, and API/UI route protection.
- Define a **CLI Server Bootstrap** module that parses host, port, data directory, and token override options, initializes storage, prints warnings, and starts the server.
- Define a **Preview Sender** module for `inro send` that reads a file, infers or accepts format/title, reads server configuration/token, and submits a create request.
- Define a **Live Events** module that publishes and subscribes to global feed and Document feed events without introducing collaboration semantics.
- A Document is the stable user-visible container for related generated content over time.
- A Revision is an immutable submission belonging to exactly one Document.
- A Document has exactly one latest Revision pointer.
- A Document Key is optional and identifies at most one Document.
- Titles are display text and must not be used as identity.
- Source Agent is recorded per Revision and means the submitting client application, not the model/provider.
- Revision Summary is optional, human-readable, and shown in the timeline.
- Sandboxed Preview is the default constrained view for HTML Revisions.
- `POST /api/documents` creates a new Document and its first Revision.
- If `POST /api/documents` receives an already-used Document Key, it returns `409 Conflict` rather than appending.
- `POST /api/documents/:id/revisions` appends an immutable Revision to an existing Document and advances the latest Revision pointer.
- Optional Idempotency Key support is included in the MVP for retry safety.
- Idempotency records are keyed by Source Agent, endpoint, and key; a repeated key returns the original result instead of creating a duplicate Revision.
- Oversized submissions return `413 Payload Too Large`; the server must not silently strip or mutate content.
- MVP formats are `markdown` and `html`.
- Markdown rendering supports CommonMark-compatible syntax, fenced code blocks, and KaTeX math delimiters.
- HTML rendering uses a sandboxed iframe and preserves browser-supported MathML.
- The MVP does not scan arbitrary HTML for LaTeX delimiters.
- Rendered output is derived on read; source plus metadata is the durable record.
- SQLite stores Document metadata, Revision metadata/source, idempotency records, and token/config.
- Small inline `data:` images may remain inside source up to the request size limit.
- Separate asset upload, extraction, content-addressed storage, and garbage collection are out of MVP.
- The server binds to `127.0.0.1` by default.
- Non-localhost binding is supported for Tailscale/LAN but must print a clear warning.
- API and browser UI routes require authentication.
- Browser UI can exchange the token for a session cookie that lasts until browser close.
- Trusted raw-render mode is excluded from MVP.
- External resource blocking is excluded from MVP beyond the basic sandboxed iframe posture.
- Global SSE feed supports index refresh events such as Document created and latest Revision changed.
- Document SSE feed supports Document page refresh events such as Revision added.
- Milestone 1 includes server bootstrap, data directory, token generation, SQLite schema/migrations, `POST /api/documents`, authenticated index page, authenticated latest Document page, Markdown rendering, and minimal `inro send` for creating Markdown Documents.
- Milestone 2 adds Revision append, Revision timeline, Revision-specific URLs, idempotency handling, and Server-Sent Events.
- Milestone 3 adds sandboxed HTML preview, browser UI session polish, Tailscale/LAN warning polish, and request-size-limit hardening.

## Testing Decisions

- Tests should assert external behavior and domain invariants, not implementation details.
- A good test creates observable inputs and checks public outputs: API responses, persisted Documents/Revisions, rendered previews, auth behavior, CLI behavior, and browser-visible HTML.
- The Document Service should be unit tested heavily because it is the deepest domain module and owns the most important invariants.
- Document Service tests should cover creating a Document, rejecting duplicate Document Keys on create, appending Revisions, advancing latest Revision, preserving older Revisions, recording Source Agent, and preserving optional Revision Summary.
- Idempotency behavior should be tested through the service/API boundary: same Source Agent + endpoint + key returns the original result; a different key creates a new Revision.
- Persistence should be tested with a real temporary SQLite database, including restart persistence and schema migration setup.
- Rendering should be tested as a pure/deep module where possible: Markdown renders paragraphs, code blocks, and KaTeX math; HTML returns a sandbox-compatible preview representation; source remains canonical.
- Auth should be tested through API/UI requests: missing token rejected, invalid token rejected, valid bearer accepted, UI session established, UI session expires with browser session semantics where feasible.
- CLI bootstrap should be tested at the behavior boundary: data directory creation, token generation, token reuse, host/port parsing, non-localhost warning, and startup failure cases.
- `inro send` should be tested with a temporary server or mocked HTTP boundary: reads file, sends title/format/content, includes auth, and prints/returns the created Document URL.
- API integration tests should cover `POST /api/documents`, duplicate Document Key conflict, oversized request rejection, and authenticated fetches of index/detail pages.
- Milestone 1 must include an end-to-end smoke test: start server with temp data dir, read generated token, run `inro send` against a Markdown fixture, assert ids/URL, fetch index/detail with auth, verify Markdown/KaTeX rendering, restart server, and verify the Document still exists.
- SSE tests can wait until Milestone 2 and should verify global events for create/latest changes and Document-scoped events for appended Revisions.
- There is no prior test suite in the current repo; use the acceptance test and deep module tests as the initial testing pattern.

## Out of Scope

- Multi-user collaboration.
- Hosted infrastructure.
- Accounts and permissions beyond one local bearer token and browser session.
- Full SPA frontend.
- Svelte/React/Vite application shell for MVP.
- Separate asset upload API.
- Content-addressed asset extraction/storage.
- Asset garbage collection.
- Automatic extraction of linked local files or external images.
- External resource blocking via CSP or URL rewriting/removal.
- True browser/network isolation guarantees.
- Trusted raw-render mode.
- HTML LaTeX delimiter scanning.
- Stored rendered snapshots or renderer-version replay guarantees.
- Duplicate Revision detection by content hash.
- Search.
- Tags or project grouping.
- Markdown or rendered diffs.
- PDF/static HTML export.
- Mermaid or diagram rendering.
- Plain text, SVG, and additional formats.
- Single-binary packaging.
- Docker image packaging.

## Further Notes

- The current repository is essentially empty except for the domain glossary, so this PRD assumes a greenfield implementation.
- The canonical domain terms are Inro, Document, Revision, Document Key, Source Agent, Revision Summary, and Sandboxed Preview.
- The Proof proposal has already been updated to reflect the resolved MVP, implementation stack, packaging, milestones, and Milestone 1 acceptance test.
- No ADR has been created yet. The current decisions are either MVP scope cuts or reversible implementation choices. If the storage technology, auth posture, or frontend architecture becomes costly to reverse, record an ADR then.
- This PRD is published as a local markdown issue because the current directory is not a git repository and no GitHub/GitLab issue tracker configuration is available.
