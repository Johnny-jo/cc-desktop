import { createHash } from "node:crypto";
import type { ChatItem, SummaryReadProof, ToolCardState } from "@claude-desktop/shared";

/** Ephemeral anchors for one summary request. Create a fresh state at every batch boundary. */
export type SummaryDedupeState = { anchors: Map<string, string>; seenCalls: Set<string>; scope?: string };

export function createSummaryDedupeState(): SummaryDedupeState {
  return { anchors: new Map(), seenCalls: new Set() };
}

/** Inspect the complete active history, including recent turns excluded from the summary. */
export function protectedSummaryToolCalls(items: readonly ChatItem[]): Set<string> {
  const protectedCalls = new Set<string>();
  const seen = new Set<string>();
  const latestReadByInput = new Map<string, string>();
  let latestTerminal: string | undefined;
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const { id, status } = item.tool;
    if (typeof id !== "string") continue;
    if (!id.trim() || seen.has(id)) protectedCalls.add(id);
    seen.add(id);
    if (status === "done" || status === "error" || status === "stopped") latestTerminal = id;
    const proof = validReadProof(item.tool);
    if (proof) latestReadByInput.set(proof.inputHash.toLowerCase(), id);
  }
  if (latestTerminal !== undefined) protectedCalls.add(latestTerminal);
  // Preserve each reading view's latest observation, including one followed by other reads.
  for (const id of latestReadByInput.values()) protectedCalls.add(id);
  return protectedCalls;
}

const SHA256 = /^[a-f\d]{64}$/i;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function validReadProof(tool: ToolCardState): SummaryReadProof | undefined {
  if (tool.name !== "Read" || tool.status !== "done" || tool.isSubagent || tool.parentToolUseId ||
      tool.task !== undefined || tool.todos !== undefined || tool.agent !== undefined ||
      typeof tool.resultPreview !== "string") return;
  const proof: unknown = tool.summaryRead;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return;
  const p = proof as Record<string, unknown>;
  if (p.format !== 1 || !nonempty(p.scope) || !nonempty(p.targetVersion) ||
      ![p.inputHash, p.resultHash, p.previewHash].every(value => typeof value === "string" && SHA256.test(value))) return;
  if (createHash("sha256").update(tool.resultPreview).digest("hex") !== String(p.previewHash).toLowerCase()) return;
  return proof as SummaryReadProof;
}

function readProofKey(name: string, proof: SummaryReadProof): string {
  return JSON.stringify([name, proof.scope, proof.inputHash.toLowerCase(), proof.targetVersion, proof.resultHash.toLowerCase()]);
}

function duplicateCallIds(items: readonly ChatItem[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool" || typeof item.tool.id !== "string") continue;
    if (seen.has(item.tool.id)) duplicates.add(item.tool.id);
    seen.add(item.tool.id);
  }
  return duplicates;
}

/** Upper bound of duplicate preview bytes removable before per-batch marker costs. */
export function summaryDuplicatePreviewBytes(items: readonly ChatItem[], protectedCalls: ReadonlySet<string>): number {
  const anchors = new Set<string>();
  const ambiguousCalls = duplicateCallIds(items);
  let scope: string | undefined;
  let bytes = 0;
  const clear = (): void => { anchors.clear(); scope = undefined; };
  for (const item of items) {
    if (item.kind !== "tool") {
      if (item.kind === "changes" || (item.kind === "text" && item.role === "system")) clear();
      continue;
    }
    const tool = item.tool;
    const proof = validReadProof(tool);
    if (!proof || typeof tool.id !== "string" || !tool.id.trim()) {
      clear();
      continue;
    }
    if (scope !== proof.scope) clear();
    scope = proof.scope;
    // Ambiguous ids never seed references. Keeping other anchors is deliberately optimistic:
    // a repeated id may be the first occurrence in its real batch, whose state is reset.
    if (protectedCalls.has(tool.id) || ambiguousCalls.has(tool.id)) continue;
    const key = readProofKey(tool.name, proof);
    if (anchors.has(key)) bytes += Buffer.byteLength(tool.resultPreview!, "utf8");
    else anchors.add(key);
  }
  return bytes;
}

/** Only replace preview text. Original history and the caller's speculative state stay untouched. */
export function projectSummaryTools(items: readonly ChatItem[], state: SummaryDedupeState, protectedCalls: ReadonlySet<string>): {
  items: ChatItem[]; state: SummaryDedupeState; deduplicatedCalls: number; savedBytes: number;
} {
  const next: SummaryDedupeState = { anchors: new Map(state.anchors), seenCalls: new Set(state.seenCalls), scope: state.scope };
  let deduplicatedCalls = 0;
  let savedBytes = 0;
  const ambiguousCalls = duplicateCallIds(items);
  const clear = (): void => { next.anchors.clear(); next.scope = undefined; };
  const projected = items.map((item): ChatItem => {
    if (item.kind !== "tool") {
      if (item.kind === "changes" || (item.kind === "text" && item.role === "system")) clear();
      return item;
    }
    const tool = item.tool;
    if (typeof tool.id !== "string") {
      clear();
      return item;
    }
    const repeatedId = next.seenCalls.has(tool.id);
    next.seenCalls.add(tool.id);
    const proof = validReadProof(tool);
    if (!proof || !tool.id.trim() || repeatedId) {
      clear();
      return item;
    }
    // Observation scopes are host-issued query/mutation epochs, never inferred from preview text.
    if (next.scope !== proof.scope) clear();
    next.scope = proof.scope;
    // A protected successful observation keeps its body but does not invalidate other read anchors.
    // Never seed an anchor from a protected call: its id may be ambiguous in full history.
    if (protectedCalls.has(tool.id) || ambiguousCalls.has(tool.id)) return item;
    const key = readProofKey(tool.name, proof);
    const anchor = next.anchors.get(key);
    if (anchor === undefined) {
      next.anchors.set(key, tool.id);
      return item;
    }
    const reference = `[Same complete read as call ${anchor}; identical arguments and target version.]`;
    const saved = Buffer.byteLength(tool.resultPreview!, "utf8") - Buffer.byteLength(reference, "utf8");
    if (saved <= 0) return item;
    deduplicatedCalls++;
    savedBytes += saved;
    return { ...item, tool: { ...tool, resultPreview: reference } };
  });
  return { items: projected, state: next, deduplicatedCalls, savedBytes };
}
