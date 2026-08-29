export type EditorBufferSnapshot = {
  content: string;
  savedContent: string;
  encoding: string;
  dirty: boolean;
  anchor: number;
  head: number;
  scrollTop: number;
  scrollLeft: number;
};

/** Plain-text snapshots are cheap; CodeMirror views, histories and trees are not. */
export const MAX_CACHED_EDITOR_BUFFERS = 8;

const snapshots = new Map<string, EditorBufferSnapshot>();

function cacheKey(projectPath: string, rel: string): string {
  return `${projectPath}\u0000${rel}`;
}

function trimCleanSnapshots(): void {
  while (snapshots.size > MAX_CACHED_EDITOR_BUFFERS) {
    const clean = [...snapshots].find(([, snapshot]) => !snapshot.dirty);
    if (!clean) return; // Never silently throw away an unsaved edit.
    snapshots.delete(clean[0]);
  }
}

export function storeEditorBuffer(
  projectPath: string,
  rel: string,
  snapshot: EditorBufferSnapshot,
): void {
  const key = cacheKey(projectPath, rel);
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  trimCleanSnapshots();
}

/** Consume a snapshot when rebuilding its CodeMirror instance. */
export function takeEditorBuffer(
  projectPath: string,
  rel: string,
): EditorBufferSnapshot | undefined {
  const key = cacheKey(projectPath, rel);
  const snapshot = snapshots.get(key);
  snapshots.delete(key);
  return snapshot;
}

export function dropEditorBuffer(projectPath: string, rel: string): void {
  snapshots.delete(cacheKey(projectPath, rel));
}

/** Test/diagnostic helper; the returned count excludes mounted editors. */
export function getEditorBufferCacheSize(): number {
  return snapshots.size;
}

export function clearEditorBufferCache(): void {
  snapshots.clear();
}
