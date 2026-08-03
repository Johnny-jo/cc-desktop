import type { FileChange, FileChangeStatus } from "./models";

function lineDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  // MVP: naive line walk — good enough for short Edit chunks
  const max = Math.max(oldLines.length, newLines.length);
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) {
      if (o !== undefined) out.push(` ${o}`);
    } else {
      if (o !== undefined) out.push(`-${o}`);
      if (n !== undefined) out.push(`+${n}`);
    }
  }
  return out.join("\n");
}

export function buildEditHunk(input: {
  path: string;
  oldString: string;
  newString: string;
}): string {
  const body = lineDiff(input.oldString, input.newString);
  return [
    `--- a/${input.path}`,
    `+++ b/${input.path}`,
    "@@",
    body,
  ].join("\n");
}

export function buildWriteHunk(input: {
  path: string;
  previousContent: string | null;
  nextContent: string;
}): string {
  if (input.previousContent == null) {
    const added = input.nextContent
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n");
    return [
      `--- /dev/null`,
      `+++ b/${input.path}`,
      "@@ new file",
      added,
    ].join("\n");
  }
  const body = lineDiff(input.previousContent, input.nextContent);
  return [`--- a/${input.path}`, `+++ b/${input.path}`, "@@", body].join("\n");
}

export function upsertFileChange(
  map: Map<string, FileChange>,
  event: {
    path: string;
    tool: "Edit" | "Write" | "Bash";
    hunk: string;
    at: number;
    status: FileChangeStatus;
  },
): Map<string, FileChange> {
  const next = new Map(map);
  const prev = next.get(event.path);
  if (!prev) {
    next.set(event.path, {
      path: event.path,
      status: event.status,
      hunks: event.hunk,
      updatedAt: event.at,
      events: [{ tool: event.tool, at: event.at, hunk: event.hunk }],
    });
    return next;
  }
  const events = [...prev.events, { tool: event.tool, at: event.at, hunk: event.hunk }];
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

export function changesToArray(map: Map<string, FileChange>): FileChange[] {
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
