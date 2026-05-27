export type RevisionFormat = "markdown" | "html";

export interface DocumentRecord {
  id: string;
  documentKey?: string;
  title: string;
  format: RevisionFormat;
  latestRevisionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RevisionRecord {
  id: string;
  documentId: string;
  format: RevisionFormat;
  content: string;
  sourceAgent: string;
  revisionSummary?: string;
  createdAt: string;
}

export interface DocumentView extends DocumentRecord {
  revisionCount: number;
  latestSourceAgent: string;
  sourceAgents: string[];
}
