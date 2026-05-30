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
  last_read_revision_id: string | null;
  last_read_at: string | null;
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
  deleteDocument(documentId: string): boolean;
  updateLatestRevision(documentId: string, revisionId: string, updatedAt: string, format: "markdown" | "html"): void;
  markDocumentRead(documentId: string, revisionId: string, readAt: string): boolean;
  markDocumentUnread(documentId: string): boolean;
  createRevision(revision: RevisionRecord): void;
  getRevision(id: string): RevisionRecord | undefined;
  listRevisions(documentId: string): RevisionRecord[];
  getIdempotencyRecord(sourceAgent: string, scope: string, key: string): unknown | undefined;
  saveIdempotencyRecord(sourceAgent: string, scope: string, key: string, response: unknown, createdAt: string): void;
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
      last_read_revision_id TEXT,
      last_read_at TEXT,
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
  ensureColumn(db, "documents", "last_read_revision_id", "TEXT");
  ensureColumn(db, "documents", "last_read_at", "TEXT");
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((info) => info.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

class SqliteStore implements InroStore {
  constructor(private readonly db: Database.Database) {}

  createDocument(document: DocumentRecord): void {
    this.db.prepare(`
      INSERT INTO documents (id, document_key, title, format, latest_revision_id, last_read_revision_id, last_read_at, created_at, updated_at)
      VALUES (@id, @documentKey, @title, @format, @latestRevisionId, @lastReadRevisionId, @lastReadAt, @createdAt, @updatedAt)
    `).run({ ...document, documentKey: document.documentKey ?? null, lastReadRevisionId: document.lastReadRevisionId ?? null, lastReadAt: document.lastReadAt ?? null });
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

  deleteDocument(documentId: string): boolean {
    const result = this.db.transaction((id: string) => {
      const deleted = this.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
      if (deleted.changes > 0) {
        this.db.prepare("DELETE FROM idempotency_records WHERE response_json LIKE ?")
          .run(`%\"documentId\":\"${id}\"%`);
      }
      return deleted;
    })(documentId);
    return result.changes > 0;
  }

  updateLatestRevision(documentId: string, revisionId: string, updatedAt: string, format: "markdown" | "html"): void {
    this.db.prepare("UPDATE documents SET latest_revision_id = ?, updated_at = ?, format = ? WHERE id = ?")
      .run(revisionId, updatedAt, format, documentId);
  }

  markDocumentRead(documentId: string, revisionId: string, readAt: string): boolean {
    const result = this.db.prepare("UPDATE documents SET last_read_revision_id = ?, last_read_at = ? WHERE id = ?")
      .run(revisionId, readAt, documentId);
    return result.changes > 0;
  }

  markDocumentUnread(documentId: string): boolean {
    const result = this.db.prepare("UPDATE documents SET last_read_revision_id = NULL, last_read_at = NULL WHERE id = ?")
      .run(documentId);
    return result.changes > 0;
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

  getIdempotencyRecord(sourceAgent: string, scope: string, key: string): unknown | undefined {
    const row = this.db.prepare("SELECT response_json FROM idempotency_records WHERE source_agent = ? AND endpoint = ? AND idempotency_key = ?")
      .get(sourceAgent, scope, key) as { response_json: string } | undefined;
    return row ? JSON.parse(row.response_json) : undefined;
  }

  saveIdempotencyRecord(sourceAgent: string, scope: string, key: string, response: unknown, createdAt: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO idempotency_records (source_agent, endpoint, idempotency_key, response_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sourceAgent, scope, key, JSON.stringify(response), createdAt);
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
    lastReadRevisionId: row.last_read_revision_id ?? undefined,
    lastReadAt: row.last_read_at ?? undefined,
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
