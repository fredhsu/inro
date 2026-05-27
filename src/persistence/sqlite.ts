import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DocumentRecord, RevisionRecord } from "../domain/types.js";

interface DocumentRow {
  id: string;
  document_key: string | null;
  title: string;
  format: "markdown" | "html";
  latest_revision_id: string;
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  id: string;
  document_id: string;
  format: "markdown" | "html";
  content: string;
  source_agent: string;
  revision_summary: string | null;
  created_at: string;
}

export interface InroStore {
  createDocument(document: DocumentRecord): void;
  getDocument(id: string): DocumentRecord | undefined;
  getDocumentByKey(documentKey: string): DocumentRecord | undefined;
  listDocuments(): DocumentRecord[];
  updateLatestRevision(documentId: string, revisionId: string, updatedAt: string, format: "markdown" | "html"): void;
  createRevision(revision: RevisionRecord): void;
  getRevision(id: string): RevisionRecord | undefined;
  listRevisions(documentId: string): RevisionRecord[];
  getIdempotencyRecord(sourceAgent: string, endpoint: string, key: string): unknown | undefined;
  saveIdempotencyRecord(sourceAgent: string, endpoint: string, key: string, response: unknown, createdAt: string): void;
  close(): void;
}

export function openInroDatabase(dbPath: string): InroStore {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // Best-effort on filesystems that do not support POSIX modes.
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return new SqliteStore(db);
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      document_key TEXT UNIQUE,
      title TEXT NOT NULL,
      format TEXT NOT NULL CHECK (format IN ('markdown', 'html')),
      latest_revision_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS revisions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      format TEXT NOT NULL CHECK (format IN ('markdown', 'html')),
      content TEXT NOT NULL,
      source_agent TEXT NOT NULL,
      revision_summary TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idempotency_records (
      source_agent TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (source_agent, endpoint, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_revisions_document_created_at ON revisions(document_id, created_at ASC);
  `);
}

class SqliteStore implements InroStore {
  constructor(private readonly db: Database.Database) {}

  createDocument(document: DocumentRecord): void {
    this.db.prepare(`
      INSERT INTO documents (id, document_key, title, format, latest_revision_id, created_at, updated_at)
      VALUES (@id, @documentKey, @title, @format, @latestRevisionId, @createdAt, @updatedAt)
    `).run({ ...document, documentKey: document.documentKey ?? null });
  }

  getDocument(id: string): DocumentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | undefined;
    return row ? mapDocument(row) : undefined;
  }

  getDocumentByKey(documentKey: string): DocumentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM documents WHERE document_key = ?").get(documentKey) as DocumentRow | undefined;
    return row ? mapDocument(row) : undefined;
  }

  listDocuments(): DocumentRecord[] {
    const rows = this.db.prepare("SELECT * FROM documents ORDER BY updated_at DESC, created_at DESC").all() as DocumentRow[];
    return rows.map(mapDocument);
  }

  updateLatestRevision(documentId: string, revisionId: string, updatedAt: string, format: "markdown" | "html"): void {
    this.db.prepare("UPDATE documents SET latest_revision_id = ?, updated_at = ?, format = ? WHERE id = ?")
      .run(revisionId, updatedAt, format, documentId);
  }

  createRevision(revision: RevisionRecord): void {
    this.db.prepare(`
      INSERT INTO revisions (id, document_id, format, content, source_agent, revision_summary, created_at)
      VALUES (@id, @documentId, @format, @content, @sourceAgent, @revisionSummary, @createdAt)
    `).run({ ...revision, revisionSummary: revision.revisionSummary ?? null });
  }

  getRevision(id: string): RevisionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM revisions WHERE id = ?").get(id) as RevisionRow | undefined;
    return row ? mapRevision(row) : undefined;
  }

  listRevisions(documentId: string): RevisionRecord[] {
    const rows = this.db.prepare("SELECT * FROM revisions WHERE document_id = ? ORDER BY created_at ASC").all(documentId) as RevisionRow[];
    return rows.map(mapRevision);
  }

  getIdempotencyRecord(sourceAgent: string, endpoint: string, key: string): unknown | undefined {
    const row = this.db.prepare("SELECT response_json FROM idempotency_records WHERE source_agent = ? AND endpoint = ? AND idempotency_key = ?")
      .get(sourceAgent, endpoint, key) as { response_json: string } | undefined;
    return row ? JSON.parse(row.response_json) : undefined;
  }

  saveIdempotencyRecord(sourceAgent: string, endpoint: string, key: string, response: unknown, createdAt: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO idempotency_records (source_agent, endpoint, idempotency_key, response_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sourceAgent, endpoint, key, JSON.stringify(response), createdAt);
  }

  close(): void {
    this.db.close();
  }
}

function mapDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    documentKey: row.document_key ?? undefined,
    title: row.title,
    format: row.format,
    latestRevisionId: row.latest_revision_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRevision(row: RevisionRow): RevisionRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    format: row.format,
    content: row.content,
    sourceAgent: row.source_agent,
    revisionSummary: row.revision_summary ?? undefined,
    createdAt: row.created_at,
  };
}
