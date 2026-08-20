/** Wait for the Write/Bash tool_result so the listing sees new files. */
export const FILE_TREE_REFRESH_MS = 150;

/**
 * Debounce an async load and drop stale in-flight results.
 * Used by the file tree so a tool_use listing (file not on disk yet) cannot
 * overwrite the later tool_result listing.
 */
export function createDebouncedLatest<T>(
  ms: number,
): {
  schedule(
    task: () => Promise<T>,
    apply: (value: T) => void,
    onError?: () => void,
    delay?: number,
  ): void;
  cancel(): void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let gen = 0;
  return {
    schedule(task, apply, onError, delay = ms) {
      if (timer !== null) clearTimeout(timer);
      const g = ++gen;
      const start = () => {
        timer = null;
        void task().then(
          (value) => {
            if (g === gen) apply(value);
          },
          () => {
            if (g === gen) onError?.();
          },
        );
      };
      if (delay <= 0) {
        start();
        return;
      }
      timer = setTimeout(start, delay);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      gen += 1;
    },
  };
}
