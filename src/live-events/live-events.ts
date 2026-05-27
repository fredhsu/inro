export interface LiveEvent {
  type: "document-created" | "latest-revision-changed" | "revision-added";
  documentId: string;
  revisionId: string;
}

type Listener = (event: LiveEvent) => void;

export interface LiveEvents {
  publishGlobal(event: LiveEvent): void;
  publishDocument(documentId: string, event: LiveEvent): void;
  subscribeGlobal(listener: Listener): () => void;
  subscribeDocument(documentId: string, listener: Listener): () => void;
}

export function createLiveEvents(): LiveEvents {
  const globalListeners = new Set<Listener>();
  const documentListeners = new Map<string, Set<Listener>>();

  return {
    publishGlobal(event) {
      for (const listener of globalListeners) listener(event);
    },
    publishDocument(documentId, event) {
      for (const listener of documentListeners.get(documentId) ?? []) listener(event);
    },
    subscribeGlobal(listener) {
      globalListeners.add(listener);
      return () => { globalListeners.delete(listener); };
    },
    subscribeDocument(documentId, listener) {
      const listeners = documentListeners.get(documentId) ?? new Set<Listener>();
      listeners.add(listener);
      documentListeners.set(documentId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) documentListeners.delete(documentId);
      };
    },
  };
}
