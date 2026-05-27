import { randomUUID } from "node:crypto";
import type { DocumentView, RevisionFormat, RevisionRecord } from "../domain/types.js";
import type { InroStore } from "../persistence/sqlite.js";

export class DocumentKeyConflictError extends Error {
  constructor(public readonly documentKey: string) {
    super(`Document Key already exists: ${documentKey}`);
    this.name = "DocumentKeyConflictError";
  }
}

export class DocumentNotFoundError extends Error {
  constructor(public readonly documentId: string) {
    super(`Document not found: ${documentId}`);
    this.name = "DocumentNotFoundError";
  }
}

export interface CreateDocumentInput {
  title: string;
  documentKey?: string;
  format: RevisionFormat;
  content: string;
  sourceAgent: string;
  revisionSummary?: string;
}

export interface AppendRevisionInput {
  format: RevisionFormat;
  content: string;
  sourceAgent: string;
  revisionSummary?: string;
}

export interface RevisionResult {
  documentId: string;
  revisionId: string;
}

export interface DocumentService {
  createDocument(input: CreateDocumentInput): RevisionResult;
  appendRevision(documentId: string, input: AppendRevisionInput): RevisionResult;
  getDocument(documentId: string): DocumentView | undefined;
  listDocuments(): DocumentView[];
  getRevision(revisionId: string): RevisionRecord | undefined;
  listRevisions(documentId: string): RevisionRecord[];
}

export function createDocumentService(store: InroStore): DocumentService {
  return new DefaultDocumentService(store);
}

class DefaultDocumentService implements DocumentService {
  constructor(private readonly store: InroStore) {}

  createDocument(input: CreateDocumentInput): RevisionResult {
    if (input.documentKey && this.store.getDocumentByKey(input.documentKey)) {
      throw new DocumentKeyConflictError(input.documentKey);
    }

    const now = new Date().toISOString();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    this.store.createDocument({
      id: documentId,
      documentKey: input.documentKey,
      title: input.title,
      format: input.format,
      latestRevisionId: revisionId,
      createdAt: now,
      updatedAt: now,
    });
    this.store.createRevision({
      id: revisionId,
      documentId,
      format: input.format,
      content: input.content,
      sourceAgent: input.sourceAgent,
      revisionSummary: input.revisionSummary,
      createdAt: now,
    });
    return { documentId, revisionId };
  }

  appendRevision(documentId: string, input: AppendRevisionInput): RevisionResult {
    if (!this.store.getDocument(documentId)) {
      throw new DocumentNotFoundError(documentId);
    }
    const now = new Date().toISOString();
    const revisionId = randomUUID();
    this.store.createRevision({
      id: revisionId,
      documentId,
      format: input.format,
      content: input.content,
      sourceAgent: input.sourceAgent,
      revisionSummary: input.revisionSummary,
      createdAt: now,
    });
    this.store.updateLatestRevision(documentId, revisionId, now, input.format);
    return { documentId, revisionId };
  }

  getDocument(documentId: string): DocumentView | undefined {
    const document = this.store.getDocument(documentId);
    return document ? this.enrich(document) : undefined;
  }

  listDocuments(): DocumentView[] {
    return this.store.listDocuments().map((document) => this.enrich(document));
  }

  getRevision(revisionId: string): RevisionRecord | undefined {
    return this.store.getRevision(revisionId);
  }

  listRevisions(documentId: string): RevisionRecord[] {
    return this.store.listRevisions(documentId);
  }

  private enrich(document: ReturnType<InroStore["getDocument"]> extends infer D ? NonNullable<D> : never): DocumentView {
    const revisions = this.store.listRevisions(document.id);
    const latest = revisions.find((revision) => revision.id === document.latestRevisionId) ?? revisions.at(-1);
    const sourceAgents = [...new Set(revisions.map((revision) => revision.sourceAgent))];
    return {
      ...document,
      revisionCount: revisions.length,
      latestSourceAgent: latest?.sourceAgent ?? "unknown",
      sourceAgents,
    };
  }
}
