import type { RevisionFormat } from "../domain/types.js";
import type { LiveEvents } from "../live-events/live-events.js";
import type { DocumentService } from "./document-service.js";

export type SubmissionTarget =
  | { kind: "new-document"; title: string; documentKey?: string }
  | { kind: "existing-document"; documentId: string };

export interface SubmitRevisionInput {
  target: SubmissionTarget;
  format: RevisionFormat;
  content: string;
  sourceAgent: string;
  revisionSummary?: string;
  idempotencyKey?: string;
}

export interface SubmissionResponse {
  documentId: string;
  revisionId: string;
  latestUrl: string;
  revisionUrl: string;
  absoluteLatestUrl: string;
  absoluteRevisionUrl: string;
}

export interface SubmissionOutcome {
  response: SubmissionResponse;
  replayed: boolean;
}

export interface IdempotencyRecords {
  getIdempotencyRecord(sourceAgent: string, scope: string, key: string): unknown | undefined;
  saveIdempotencyRecord(sourceAgent: string, scope: string, key: string, response: unknown, createdAt: string): void;
}

export interface SubmissionServiceOptions {
  documents: DocumentService;
  idempotencyRecords: IdempotencyRecords;
  liveEvents: LiveEvents;
  publicBaseUrl: string;
}

export interface SubmissionService {
  submitRevision(input: SubmitRevisionInput): SubmissionOutcome;
}

export function createSubmissionService(options: SubmissionServiceOptions): SubmissionService {
  return new DefaultSubmissionService(options);
}

class DefaultSubmissionService implements SubmissionService {
  constructor(private readonly options: SubmissionServiceOptions) {}

  submitRevision(input: SubmitRevisionInput): SubmissionOutcome {
    const idempotencyKey = emptyToUndefined(input.idempotencyKey);
    const scope = idempotencyScope(input.target);

    if (idempotencyKey) {
      const prior = this.options.idempotencyRecords.getIdempotencyRecord(input.sourceAgent, scope, idempotencyKey);
      if (prior) return { response: prior as SubmissionResponse, replayed: true };
    }

    const result = input.target.kind === "new-document"
      ? this.options.documents.createDocument({
          title: input.target.title,
          documentKey: input.target.documentKey,
          format: input.format,
          content: input.content,
          sourceAgent: input.sourceAgent,
          revisionSummary: input.revisionSummary,
        })
      : this.options.documents.appendRevision(input.target.documentId, {
          format: input.format,
          content: input.content,
          sourceAgent: input.sourceAgent,
          revisionSummary: input.revisionSummary,
        });

    const response = responseFor(result.documentId, result.revisionId, this.options.publicBaseUrl);
    if (idempotencyKey) {
      this.options.idempotencyRecords.saveIdempotencyRecord(input.sourceAgent, scope, idempotencyKey, response, new Date().toISOString());
    }
    this.publishEvents(input.target, result.documentId, result.revisionId);
    return { response, replayed: false };
  }

  private publishEvents(target: SubmissionTarget, documentId: string, revisionId: string): void {
    if (target.kind === "new-document") {
      this.options.liveEvents.publishGlobal({ type: "document-created", documentId, revisionId });
      return;
    }

    this.options.liveEvents.publishGlobal({ type: "latest-revision-changed", documentId, revisionId });
    this.options.liveEvents.publishDocument(documentId, { type: "revision-added", documentId, revisionId });
  }
}

function idempotencyScope(target: SubmissionTarget): string {
  if (target.kind === "new-document") return "submission:new-document";
  return `submission:document:${target.documentId}`;
}

function responseFor(documentId: string, revisionId: string, publicBaseUrl: string): SubmissionResponse {
  const latestUrl = `/d/${documentId}`;
  const revisionUrl = `/d/${documentId}/r/${revisionId}`;
  const base = publicBaseUrl.replace(/\/$/, "");
  return { documentId, revisionId, latestUrl, revisionUrl, absoluteLatestUrl: `${base}${latestUrl}`, absoluteRevisionUrl: `${base}${revisionUrl}` };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}
