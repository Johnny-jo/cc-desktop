import type { FileChange, FileChangeEvent, FileChangeStatus } from "./models";

let eventSeq = 0;
/** Unique id for one tracked write operation. */
export function newChangeEventId(): string {
  eventSeq += 1;
  return `ev-${Date.now().toString(36)}-${eventSeq}`;
}

/** Hard caps — full-file Write of multi‑MB sources used to freeze the UI. */
export const DIFF_MAX_LINES = 800;
export const DIFF_MAX_CHARS = 120_000;
export const DIFF_PREVIEW_ROWS = 600;

function truncateForDiff(
  text: string,
  maxLines = DIFF_MAX_LINES,
  maxChars = DIFF_MAX_CHARS,
): { text: string; truncated: boolean; totalLines: number } {
  const lines = text.split("\n");
  const totalLines = lines.length;
  let out = text;
  let truncated = false;
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }
  return { text: out, truncated, totalLines };
}

/**
 * Build a unified-diff style body with a proper @@ header so the UI can show
 * "which line numbers changed".
 *
 * @param oldBase 1-based starting line number of oldText within the full file
 * @param newBase 1-based starting line number of newText within the full file
 *                (same as oldBase for in-place Edit; 1 for full-file Write)
 */
function lineDiff(
  oldText: string,
  newText: string,
  opts?: { oldBase?: number; newBase?: number },
): string {
  const oldBase = Math.max(1, opts?.oldBase ?? 1);
  const newBase = Math.max(1, opts?.newBase ?? 1);
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  // Drop trailing empty line from split so "a\n" → ["a"] not ["a",""]
  if (oldLines.length && oldLines[oldLines.length - 1] === "") oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === "") newLines.pop();

  type Row =
    | { kind: "eq"; o: string; oldNo: number; newNo: number }
    | { kind: "del"; o: string; oldNo: number }
    | { kind: "add"; n: string; newNo: number };

  const rows: Row[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  // Start just before base so the first real line gets number = base
  let oi = oldBase - 1;
  let ni = newBase - 1;
  // Pair by index (MVP). Full-file Write/Edit-with-file gives correct absolute nos.
  // A contiguous changed run is grouped: all deletions first, then all
  // additions — block display instead of per-line -/+ interleaving.
  let pendDel: Row[] = [];
  let pendAdd: Row[] = [];
  const flush = () => {
    if (pendDel.length) rows.push(...pendDel);
    if (pendAdd.length) rows.push(...pendAdd);
    pendDel = [];
    pendAdd = [];
  };
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n && o !== undefined) {
      flush();
      oi += 1;
      ni += 1;
      rows.push({ kind: "eq", o, oldNo: oi, newNo: ni });
      continue;
    }
    if (o !== undefined) {
      oi += 1;
      pendDel.push({ kind: "del", o, oldNo: oi });
    }
    if (n !== undefined) {
      ni += 1;
      pendAdd.push({ kind: "add", n, newNo: ni });
    }
  }
  flush();

  if (!rows.some((r) => r.kind !== "eq")) {
    return "@@ -1,0 +1,0 @@\n# (no line changes)";
  }

  // Emit one big hunk covering all changes, with line counts.
  // Find first/last non-eq for a tighter range; keep 1 line of context.
  let first = rows.findIndex((r) => r.kind !== "eq");
  let last = rows.length - 1;
  while (last > first && rows[last]!.kind === "eq") last -= 1;
  first = Math.max(0, first - 1);
  last = Math.min(rows.length - 1, last + 1);

  const slice = rows.slice(first, last + 1);
  let oldStart = 1;
  let newStart = 1;
  // Find first row that has an old/new number
  for (const r of slice) {
    if (r.kind === "eq" || r.kind === "del") {
      oldStart = r.oldNo;
      break;
    }
  }
  for (const r of slice) {
    if (r.kind === "eq" || r.kind === "add") {
      newStart = r.newNo;
      break;
    }
  }
  let oldCount = 0;
  let newCount = 0;
  const body: string[] = [];
  for (const r of slice) {
    if (r.kind === "eq") {
      oldCount += 1;
      newCount += 1;
      body.push(` ${r.o}`);
    } else if (r.kind === "del") {
      oldCount += 1;
      body.push(`-${r.o}`);
    } else {
      newCount += 1;
      body.push(`+${r.n}`);
    }
  }

  // Annotate header with human-readable changed line ranges (new-file numbers).
  const changedNewLines: number[] = [];
  for (const r of slice) {
    if (r.kind === "add") changedNewLines.push(r.newNo);
  }
  const changedOldLines: number[] = [];
  for (const r of slice) {
    if (r.kind === "del") changedOldLines.push(r.oldNo);
  }
  const rangeHint = formatLineRanges(changedNewLines, changedOldLines);

  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${
    rangeHint ? `  ${rangeHint}` : ""
  }`;
  return [header, ...body].join("\n");
}

/** e.g. "lines +3–5, +12" / "lines −2, +4–6" */
function formatLineRanges(added: number[], removed: number[]): string {
  const parts: string[] = [];
  if (removed.length) parts.push(`−${collapseRanges(removed)}`);
  if (added.length) parts.push(`+${collapseRanges(added)}`);
  if (!parts.length) return "";
  return `lines ${parts.join(", ")}`;
}

function collapseRanges(nums: number[]): string {
  if (!nums.length) return "";
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const chunks: string[] = [];
  let start = sorted[0]!;
  let prev = start;
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i]!;
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    chunks.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = prev = n;
  }
  chunks.push(start === prev ? `${start}` : `${start}–${prev}`);
  return chunks.join(", ");
}

/**
 * 1-based line number where `snippet` starts inside `fileContent`.
 * Returns 1 if not found (caller may fall back to fragment-relative numbers).
 */
export function findSnippetStartLine(
  fileContent: string,
  snippet: string,
): number {
  if (!snippet) return 1;
  const normFile = fileContent.replace(/\r\n/g, "\n");
  const normSnip = snippet.replace(/\r\n/g, "\n");
  // Prefer exact match; also try without trailing newline mismatch
  let idx = normFile.indexOf(normSnip);
  if (idx < 0) {
    const trimmed = normSnip.replace(/\n$/, "");
    idx = normFile.indexOf(trimmed);
  }
  if (idx < 0) return 1;
  // Number of lines before idx + 1
  if (idx === 0) return 1;
  return normFile.slice(0, idx).split("\n").length;
}

/**
 * Apply Edit-style replacement to full file content (first match or all).
 */
export function applyEditToContent(
  fileContent: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string | null {
  const normFile = fileContent.replace(/\r\n/g, "\n");
  const normOld = oldString.replace(/\r\n/g, "\n");
  const normNew = newString.replace(/\r\n/g, "\n");
  if (!normFile.includes(normOld)) {
    const trimmed = normOld.replace(/\n$/, "");
    if (!normFile.includes(trimmed)) return null;
    return replaceAll
      ? normFile.split(trimmed).join(normNew)
      : normFile.replace(trimmed, normNew);
  }
  return replaceAll
    ? normFile.split(normOld).join(normNew)
    : normFile.replace(normOld, normNew);
}

export function buildEditHunk(input: {
  path: string;
  oldString: string;
  newString: string;
  /**
   * 1-based line of oldString in the full file. When omitted, numbers are
   * relative to the snippet (always start at 1) — prefer passing previousContent
   * so we can locate the snippet automatically.
   */
  startLine?: number;
  /** Full file before edit — used to locate absolute start line of oldString */
  previousContent?: string | null;
  replaceAll?: boolean;
}): string {
  // Huge snippets (rare) — don't build multi‑MB previews.
  if (
    input.oldString.length > DIFF_MAX_CHARS ||
    input.newString.length > DIFF_MAX_CHARS
  ) {
    return [
      `--- a/${input.path}`,
      `+++ b/${input.path}`,
      `@@ large edit @@`,
      `# edit snippet too large for inline preview`,
      `# old ${input.oldString.length} chars → new ${input.newString.length} chars`,
      `# open the file in the editor tab to inspect`,
    ].join("\n");
  }
  // Locate old_string in the full file so gutter numbers match real file lines.
  // Diff only the snippet (not whole file) so insertions don't desync index pairing.
  let base =
    input.startLine && input.startLine > 0 ? input.startLine : 1;
  if (
    (!input.startLine || input.startLine <= 0) &&
    input.previousContent != null &&
    input.previousContent !== ""
  ) {
    // Avoid scanning multi‑MB files for snippet start — use first 1MB only.
    const hay =
      input.previousContent.length > 1_000_000
        ? input.previousContent.slice(0, 1_000_000)
        : input.previousContent;
    base = findSnippetStartLine(hay, input.oldString);
  }
  // newBase = oldBase for pure replace; if new has more/fewer lines the
  // subsequent numbers still shift correctly within the snippet.
  const body = lineDiff(input.oldString, input.newString, {
    oldBase: base,
    newBase: base,
  });
  return [`--- a/${input.path}`, `+++ b/${input.path}`, body].join("\n");
}

export function buildWriteHunk(input: {
  path: string;
  previousContent: string | null;
  nextContent: string;
}): string {
  const nextCap = truncateForDiff(input.nextContent);
  const prevCap =
    input.previousContent == null
      ? null
      : truncateForDiff(input.previousContent);

  if (prevCap == null) {
    const lines = nextCap.text.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const shown = Math.max(lines.length, 1);
    const total = nextCap.totalLines;
    const added = lines.map((l) => `+${l}`).join("\n");
    const range =
      total === 1
        ? "lines +1"
        : nextCap.truncated
          ? `lines +1–${total} (preview first ${shown})`
          : `lines +1–${total}`;
    const header = [
      `--- /dev/null`,
      `+++ b/${input.path}`,
      `@@ -0,0 +1,${shown} @@  new file · ${range}`,
    ];
    if (nextCap.truncated) {
      header.push(
        `# preview truncated · file has ${total} lines · showing first ${shown}`,
      );
    }
    return [...header, added || "+"].join("\n");
  }

  // Both sides huge → skip O(n) line walk, show summary only
  if (
    prevCap.totalLines > DIFF_MAX_LINES ||
    nextCap.totalLines > DIFF_MAX_LINES ||
    (input.previousContent?.length ?? 0) > DIFF_MAX_CHARS ||
    input.nextContent.length > DIFF_MAX_CHARS
  ) {
    const oldN = prevCap.totalLines;
    const newN = nextCap.totalLines;
    return [
      `--- a/${input.path}`,
      `+++ b/${input.path}`,
      `@@ -1,${Math.min(oldN, DIFF_MAX_LINES)} +1,${Math.min(newN, DIFF_MAX_LINES)} @@  large file`,
      `# large change · old ${oldN} lines → new ${newN} lines`,
      `# full inline preview skipped to keep UI responsive`,
      `# open the file in the editor tab to inspect`,
    ].join("\n");
  }

  const body = lineDiff(prevCap.text, nextCap.text);
  const note =
    prevCap.truncated || nextCap.truncated
      ? `\n# preview truncated · old ${prevCap.totalLines} / new ${nextCap.totalLines} lines`
      : "";
  return [`--- a/${input.path}`, `+++ b/${input.path}`, body].join("\n") + note;
}

export function upsertFileChange(
  map: Map<string, FileChange>,
  event: {
    id: string;
    path: string;
    tool: "Edit" | "Write" | "Bash";
    hunk: string;
    at: number;
    status: FileChangeStatus;
    toolUseId?: string;
  },
): Map<string, FileChange> {
  const next = new Map(map);
  const prev = next.get(event.path);
  const entry: FileChangeEvent = {
    id: event.id,
    tool: event.tool,
    at: event.at,
    hunk: event.hunk,
    ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
  };
  if (!prev) {
    next.set(event.path, {
      path: event.path,
      status: event.status,
      hunks: event.hunk,
      updatedAt: event.at,
      events: [entry],
    });
    return next;
  }
  const events = [...prev.events, entry];
  // MVP aggregate display: last event hunk + count header
  const hunks = [
    `# ${events.length} change(s) in session (showing latest)`,
    event.hunk,
  ].join("\n");
  next.set(event.path, {
    path: event.path,
    status: prev.status === "A" || event.status === "A" ? "A" : "M",
    hunks,
    updatedAt: event.at,
    events,
  });
  return next;
}

/**
 * Truncate a file's change events at (and excluding) `fromEventId` — used
 * after rolling back to just before that operation. Returns undefined when
 * no events remain (file should leave the change set).
 */
export function truncateFileChange(
  change: FileChange,
  fromEventId: string,
): FileChange | undefined {
  const idx = change.events.findIndex((e) => e.id === fromEventId);
  if (idx < 0) return change;
  const events = change.events.slice(0, idx);
  if (!events.length) return undefined;
  const last = events[events.length - 1]!;
  return {
    path: change.path,
    status: change.status,
    hunks: last.hunk,
    updatedAt: last.at,
    events,
  };
}

export function changesToArray(map: Map<string, FileChange>): FileChange[] {
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Parse a unified-diff hunk into display rows with old/new line numbers.
 * Used by DiffView to render a line-number gutter.
 */
export type DiffDisplayRow = {
  kind: "meta" | "hunk" | "add" | "del" | "ctx";
  text: string;
  /** 1-based line number in old file; null if not applicable */
  oldNo: number | null;
  /** 1-based line number in new file; null if not applicable */
  newNo: number | null;
};

/** One visual block: unchanged lead-in, or a contiguous −/+ change run. */
export type DiffDisplayGroup =
  | { kind: "lead"; row: DiffDisplayRow }
  | { kind: "change"; dels: DiffDisplayRow[]; adds: DiffDisplayRow[] };

/**
 * Collapse adjacent del/add rows into change runs. A ctx / hunk / meta row
 * always splits. Replacements (dels then adds, no ctx between) become one group.
 */
export function groupDiffDisplayRows(
  rows: DiffDisplayRow[],
): DiffDisplayGroup[] {
  const out: DiffDisplayGroup[] = [];
  let dels: DiffDisplayRow[] = [];
  let adds: DiffDisplayRow[] = [];
  const flush = () => {
    if (!dels.length && !adds.length) return;
    out.push({ kind: "change", dels, adds });
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.kind === "del") {
      dels.push(row);
    } else if (row.kind === "add") {
      adds.push(row);
    } else {
      flush();
      out.push({ kind: "lead", row });
    }
  }
  flush();
  return out;
}

export function parseHunkForDisplay(
  hunks: string,
  maxRows = DIFF_PREVIEW_ROWS,
): DiffDisplayRow[] {
  // Cap raw length first so split() on multi‑MB strings can't freeze the main thread.
  const raw =
    hunks.length > DIFF_MAX_CHARS * 2
      ? hunks.slice(0, DIFF_MAX_CHARS * 2)
      : hunks;
  const lines = raw.split("\n");
  const rows: DiffDisplayRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inBody = false;
  let truncated = hunks.length > raw.length;

  for (const line of lines) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    if (line.startsWith("@@")) {
      inBody = true;
      const m = line.match(/@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
      if (m) {
        oldNo = Math.max(0, Number(m[1]) - 1);
        newNo = Math.max(0, Number(m[2]) - 1);
      }
      rows.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (!inBody) {
      rows.push({
        kind: "meta",
        text: line,
        oldNo: null,
        newNo: null,
      });
      continue;
    }
    if (line.startsWith("+")) {
      newNo += 1;
      rows.push({ kind: "add", text: line, oldNo: null, newNo });
    } else if (line.startsWith("-")) {
      oldNo += 1;
      rows.push({ kind: "del", text: line, oldNo, newNo: null });
    } else if (line.startsWith(" ") || line === "") {
      oldNo += 1;
      newNo += 1;
      rows.push({
        kind: "ctx",
        text: line || " ",
        oldNo,
        newNo,
      });
    } else if (line.startsWith("#")) {
      rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    } else {
      rows.push({ kind: "ctx", text: line, oldNo: null, newNo: null });
    }
  }
  if (truncated) {
    rows.push({
      kind: "meta",
      text: `# preview capped at ${maxRows} rows · open file in editor for full content`,
      oldNo: null,
      newNo: null,
    });
  }
  return rows;
}

/** Extract human-readable range summary from the first @@ header, if any. */
export function extractLineRangeSummary(hunks: string): string | null {
  const m = hunks.match(/@@[^@]*@@\s*(.+)$/m);
  if (m?.[1]?.trim()) return m[1].trim();
  // Fallback: count +/- lines
  let add = 0;
  let del = 0;
  for (const line of hunks.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) del += 1;
  }
  if (!add && !del) return null;
  const parts: string[] = [];
  if (add) parts.push(`+${add}`);
  if (del) parts.push(`−${del}`);
  return parts.join(" ");
}

/** Caps for the full-text (whole file + inline changes) view. */
export const FULLTEXT_MAX_LINES = 4000;
export const FULLTEXT_MAX_CHARS = 512_000;

/**
 * Merge the current full file text with a recorded hunk: every file line is
 * shown, added lines are marked `add`, deleted lines are spliced back in at
 * their original positions as `del`. Used by DiffView's "全文" mode.
 *
 * Anchor rule: a deleted line belongs just before the next hunk row that has
 * a new-file line number (ctx or add); trailing dels anchor past the end.
 */
export function mergeFullTextWithHunks(
  fullText: string,
  hunks: string,
  maxLines = FULLTEXT_MAX_LINES,
): DiffDisplayRow[] {
  const hunkRows = parseHunkForDisplay(hunks, Number.MAX_SAFE_INTEGER);
  const addNewNos = new Set<number>();
  const dels = new Map<number, { text: string; oldNo: number | null }[]>();
  let pendingDels: { text: string; oldNo: number | null }[] = [];
  const flushDels = (anchor: number) => {
    if (!pendingDels.length) return;
    const list = dels.get(anchor) ?? [];
    list.push(...pendingDels);
    dels.set(anchor, list);
    pendingDels = [];
  };
  for (const r of hunkRows) {
    if (r.kind === "del") {
      pendingDels.push({ text: r.text, oldNo: r.oldNo });
    } else if ((r.kind === "add" || r.kind === "ctx") && r.newNo != null) {
      if (r.kind === "add") addNewNos.add(r.newNo);
      flushDels(r.newNo);
    }
  }
  flushDels(Number.POSITIVE_INFINITY);

  let text = fullText;
  let truncated = false;
  if (text.length > FULLTEXT_MAX_CHARS) {
    text = text.slice(0, FULLTEXT_MAX_CHARS);
    truncated = true;
  }
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  const shown = lines.slice(0, maxLines);
  if (totalLines > maxLines) truncated = true;

  const rows: DiffDisplayRow[] = [];
  const emitDels = (anchor: number) => {
    const list = dels.get(anchor);
    if (!list) return;
    for (const d of list) {
      rows.push({ kind: "del", text: d.text, oldNo: d.oldNo, newNo: null });
    }
  };

  shown.forEach((line, i) => {
    const newNo = i + 1;
    emitDels(newNo);
    if (addNewNos.has(newNo)) {
      rows.push({ kind: "add", text: `+${line}`, oldNo: null, newNo });
    } else {
      rows.push({ kind: "ctx", text: ` ${line}` || " ", oldNo: newNo, newNo });
    }
  });
  if (!truncated) emitDels(Number.POSITIVE_INFINITY);
  if (truncated) {
    rows.push({
      kind: "meta",
      text: `# full text capped · file has ${totalLines} lines · showing first ${Math.min(maxLines, totalLines)}`,
      oldNo: null,
      newNo: null,
    });
  }
  return rows;
}
