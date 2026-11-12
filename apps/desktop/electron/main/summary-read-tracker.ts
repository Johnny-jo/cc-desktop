import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { SummaryReadProof } from "@claude-desktop/shared";

type JsonObject = Record<string, unknown>;
type HookOptions = { signal?: AbortSignal };
type Pending = {
  scope: string;
  inputHash: string;
  targetVersion: string;
  canonical: string;
  args: JsonObject;
  signal?: AbortSignal;
};
type Completed = { proof: Omit<SummaryReadProof, "previewHash">; preSignal?: AbortSignal; postSignal?: AbortSignal };
const MAX_CALLS = 512;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);

// Hash actual JSON, including unfamiliar fields. Reject lossy/non-JSON values.
function stableJson(value: unknown, ancestors = new Set<object>(), depth = 0): string {
  if (depth > 64) throw new Error("JSON nesting limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error("Not JSON");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Not a JSON object");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new Error("Sparse array is not complete JSON");
        items.push(stableJson(value[index], ancestors, depth + 1));
      }
      return "[" + items.join(",") + "]";
    }
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableJson((value as JsonObject)[key], ancestors, depth + 1)).join(",") + "}";
  } finally { ancestors.delete(value); }
}

function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }

// Reject network/device namespaces before any OS path lookup, including on a
// non-Windows host. Resolving such names can itself connect to a remote server.
function localPath(value: string): boolean {
  if (!value || value.includes("\0") || /^[\\/]{2}/.test(value) ||
    /^\\(?:\?\?|device|global\?\?)\\/i.test(value) || /^[a-z]:(?![\\/])/i.test(value)) return false;
  return !value.replace(/^[a-z]:/i, "").split(/[\\/]/).some(segment =>
    segment.includes(":") || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment.trimEnd()));
}

function absoluteLocalPath(value: string): boolean {
  return localPath(value) && path.isAbsolute(value) &&
    (process.platform !== "win32" || /^[a-z]:[\\/]/i.test(value));
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !!relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

// lstat each component before following any component with realpath/stat.
// All junctions/symlinks are ineligible, even when their target is still local.
function ordinaryPath(base: string, candidate: string, file: boolean): boolean {
  const relative = path.relative(base, candidate), segments = relative ? relative.split(path.sep) : [];
  let cursor = base;
  const rootInfo = lstatSync(base);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return false;
  for (let index = 0; index < segments.length; index++) {
    cursor = path.join(cursor, segments[index]);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) return false;
    const isFileTarget = index === segments.length - 1 && file;
    if (isFileTarget ? !info.isFile() : !info.isDirectory()) return false;
  }
  return !file || !!segments.length;
}
function hasIncompleteSignal(value: JsonObject) {
  return Object.entries(value).some(([key, flag]) =>
    /^(?:truncatedByTokenCap|truncated|isTruncated|is_error|isError|error|partial|isPartial|preview|isPreview|shortened)$/i.test(key) &&
    flag !== false && flag !== null && flag !== undefined);
}

function deliveredText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || !content.length || !content.every(block =>
    object(block) && block.type === "text" && typeof block.text === "string" && !hasIncompleteSignal(block))) return;
  // Match normalize-sdk-event's Read toolPreview, after rejecting non-text blocks.
  const texts = content.map(block => (block as JsonObject).text as string).filter(Boolean);
  return texts.length ? texts.join("\n") : undefined;
}

/**
 * Read-only observation of successful built-in Read hooks. No content reads,
 * permissions, tool-output rewrites or SDK-history changes occur here.
 * The caller has already validated root with symbolProjectRoot.
 */
export function createSummaryReadTracker(options: { root: string; isActive: () => boolean }) {
  const queryScope = randomUUID();
  let epoch = 0, revoked = false;
  const pending = new Map<string, Pending>(), completed = new Map<string, Completed>();
  let root: string | undefined;
  try {
    if (absoluteLocalPath(options.root)) {
      const requested = path.resolve(options.root);
      if (ordinaryPath(path.parse(requested).root, requested, false)) {
        const canonical = realpathSync.native(requested);
        if (localPath(canonical) && statSync(canonical).isDirectory()) root = canonical;
      }
    }
  } catch { /* Inaccessible roots cannot produce evidence. */ }
  const scope = () => queryScope + ":" + epoch;
  const rotate = () => { epoch++; pending.clear(); completed.clear(); };
  const revoke = () => { revoked = true; rotate(); };
  const active = (signal?: AbortSignal) => {
    if (revoked) return false;
    if (signal?.aborted || !options.isActive()) { revoke(); return false; }
    return !!root;
  };
  const callId = (input: JsonObject, fallback?: string) => {
    if (typeof input.tool_use_id !== "string" || !input.tool_use_id) return undefined;
    if (fallback !== undefined && fallback !== input.tool_use_id) return undefined;
    return input.tool_use_id;
  };
  const builtinRead = (input: JsonObject) => input.tool_name === "Read" &&
    input.agent_id === undefined && input.mcp_server === undefined;

  function snapshot(file: unknown): { canonical: string; version: string } | undefined {
    // SDK FileReadInput requires an absolute path. Never guess a relative path
    // from the query root: the CLI's cwd can change while a query is active.
    if (!root || typeof file !== "string" || !absoluteLocalPath(file)) return;
    try {
      const requested = path.resolve(root, file);
      if (!localPath(requested) || !contained(root, requested) || !ordinaryPath(root, requested, true)) return;
      const canonical = realpathSync.native(requested);
      if (!localPath(canonical) || !contained(root, canonical)) return;
      const stat = statSync(canonical, { bigint: true });
      if (!stat.isFile() || realpathSync.native(requested) !== canonical) return;
      return { canonical, version: digest(stableJson({ canonical, dev: String(stat.dev), ino: String(stat.ino),
        size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) })) };
    } catch { return; }
  }

  function completeText(result: unknown, observation: Pending): boolean {
    // Confirmed against bundled CLI + SDK 0.3.318. Raw content here is not the
    // line-numbered/possibly shortened rendering shown in the visible tool card.
    if (!object(result) || result.type !== "text" || hasIncompleteSignal(result) || !object(result.file)) return false;
    const file = result.file;
    if (hasIncompleteSignal(file) || typeof file.content !== "string" || !positiveInteger(file.startLine) ||
      !positiveInteger(file.totalLines) || !positiveInteger(file.numLines)) return false;
    if (Object.hasOwn(result, "content") || Object.hasOwn(result, "content_blocks")) return false;
    if (/\[(?:output|content|response)?\s*(?:truncated|omitted)[^\]]*\]/i.test(file.content)) return false;
    if (file.content.split("\n").length !== file.numLines) return false;
    const start = observation.args.offset ?? 1, limit = observation.args.limit;
    if (!positiveInteger(start) || (limit !== undefined && !positiveInteger(limit)) || observation.args.pages !== undefined) return false;
    if (file.startLine !== start || start > file.totalLines) return false;
    const expected = Math.min(limit === undefined ? file.totalLines : limit as number, file.totalLines - start + 1);
    if (file.numLines !== expected) return false;
    const target = snapshot(file.filePath);
    return target?.canonical === observation.canonical && target.version === observation.targetVersion;
  }

  const pre = async (value: unknown, toolUseId?: string, hookOptions?: HookOptions): Promise<{}> => {
    if (!active(hookOptions?.signal)) return {};
    if (!object(value) || !builtinRead(value)) { rotate(); return {}; }
    const id = callId(value, toolUseId);
    if (!id || !object(value.tool_input)) { rotate(); return {}; }
    try {
      const args = value.tool_input, inputJson = stableJson(args), target = snapshot(args.file_path);
      if (!target) { rotate(); return {}; }
      // Reused IDs cannot pair an earlier completion with a new invocation.
      if (pending.has(id) || completed.has(id)) { rotate(); return {}; }
      if (pending.size >= MAX_CALLS) rotate();
      pending.set(id, { scope: scope(), inputHash: digest(inputJson), targetVersion: target.version,
        canonical: target.canonical, args: JSON.parse(inputJson), signal: hookOptions?.signal });
    } catch { rotate(); }
    return {};
  };
  const post = async (value: unknown, toolUseId?: string, hookOptions?: HookOptions): Promise<{}> => {
    if (!active(hookOptions?.signal)) return {};
    if (!object(value)) { rotate(); return {}; }
    const id = callId(value, toolUseId), observation = id ? pending.get(id) : undefined;
    if (id) pending.delete(id);
    if (!observation) return {};
    if (!active(observation.signal)) return {};
    try {
      const target = object(value.tool_input) ? snapshot(value.tool_input.file_path) : undefined;
      if (!builtinRead(value) || observation.scope !== scope() ||
        digest(stableJson(value.tool_input)) !== observation.inputHash || target?.version !== observation.targetVersion ||
        target.canonical !== observation.canonical || !completeText(value.tool_response, observation)) { rotate(); return {}; }
      if (completed.size >= MAX_CALLS) completed.delete(completed.keys().next().value!);
      completed.set(id!, { proof: { format: 1, scope: observation.scope, inputHash: observation.inputHash,
        targetVersion: observation.targetVersion, resultHash: digest(stableJson(value.tool_response)) },
        preSignal: observation.signal, postSignal: hookOptions?.signal });
    } catch { rotate(); }
    return {};
  };
  const failure = async (_value: unknown, _toolUseId?: string, hookOptions?: HookOptions): Promise<{}> => {
    if (active(hookOptions?.signal)) rotate();
    return {};
  };
  return {
    pre, post, failure,
    take(call: string, preview: string | undefined, deliveredContent?: unknown): SummaryReadProof | undefined {
      const result = completed.get(call); completed.delete(call);
      if (!result || typeof preview !== "string" || !active(result.preSignal) || !active(result.postSignal) || result.proof.scope !== scope()) return;
      const delivered = deliveredText(deliveredContent);
      if (delivered === undefined || delivered.slice(0, 200) !== preview) return;
      try {
        // Sibling Post hooks may rewrite the real tool_result after we observed
        // the original Read. Bind its full final bytes as well as the original.
        return { ...result.proof, resultHash: digest(stableJson({ originalResultHash: result.proof.resultHash, deliveredContent })),
          previewHash: digest(preview) };
      } catch { return; }
    },
    revoke,
  };
}
