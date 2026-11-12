import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppSettings, SdkNormalizedEvent } from "@claude-desktop/shared";
import { expect, it } from "vitest";
import { DiffTracker } from "./diff-tracker";
import type { ModelRuntime } from "./model-runtime";
import type { PermissionBroker } from "./permission-broker";
import { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";

type Hook = (input: Record<string, unknown>, id: string, options: { signal: AbortSignal }) => Promise<unknown>;
it.each([
  { mode: "balanced", room: false, subagent: false, proof: true },
  { mode: "standard", room: false, subagent: false, proof: false },
  { mode: "balanced", room: true, subagent: false, proof: false },
  { mode: "balanced", room: false, subagent: true, proof: false },
])("binds complete-read proof only to eligible main-session results: %j", async scenario => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-proof-manager-"));
  const file = path.join(root, "source.txt");
  const text = "source line\n".repeat(30);
  fs.writeFileSync(file, text);
  const events: SdkNormalizedEvent[] = [];
  const cpa = { ensureReady: async () => ({ state: "ready", port: 8317, managedByApp: false }),
    getModelCatalog: () => [], buildProcessEnv: () => ({}) } as unknown as ModelRuntime;
  const settings = { get: () => ({ defaultModel: "fixture", models: ["fixture"], permissionMode: "default",
    defaultContextLimit: 200_000, modelContextLimits: {}, tokenSavings: { mode: scenario.mode } } as AppSettings) } as SettingsStore;
  const manager = new SessionManager({ cpa, settings, diffTracker: new DiffTracker(),
    permissionBroker: { canUseTool: async () => ({ behavior: "allow", updatedInput: {} }) } as unknown as PermissionBroker,
    emit: event => events.push(event), emitSession() {}, emitDiff() {}, queryFn: async function* ({ prompt, options }) {
      if (typeof prompt !== "string") for await (const _message of prompt) break;
      const input = { file_path: file };
      const tool = { id: "read-call", name: "Read", input };
      const parent = scenario.subagent ? { parent_tool_use_id: "parent" } : {};
      yield { type: "assistant", ...parent, message: { content: [{ type: "tool_use", ...tool }] } };
      const hooks = options.hooks as Record<string, { hooks: Hook[] }[]>;
      const invoke = async (name: string, fields = {}) => {
        for (const group of hooks[name] ?? []) for (const hook of group.hooks) {
          await hook({ tool_name: "Read", tool_input: input, tool_use_id: tool.id,
            ...(scenario.subagent ? { agent_id: "child" } : {}), ...fields }, tool.id, { signal: new AbortController().signal });
        }
      };
      await invoke("PreToolUse");
      const response = { type: "text", file: { filePath: file, content: text, startLine: 1, numLines: 31, totalLines: 31 } };
      await invoke("PostToolUse", { tool_response: response });
      yield { type: "user", ...parent, tool_use_result: response,
        message: { content: [{ type: "tool_result", tool_use_id: tool.id, content: text }] } };
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    } });
  try {
    await manager.start({ text: "Read fixture", attachments: [] }, root, scenario.room ? { roomReadOnly: true } : undefined);
    const end = events.find(event => event.type === "tool_end");
    if (!end || end.type !== "tool_end") throw Error("Missing tool result");
    expect(end.tool.resultPreview).toBe(text.slice(0, 200));
    if (scenario.proof) {
      expect(end.tool.summaryRead).toMatchObject({ format: 1,
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/), resultHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        previewHash: createHash("sha256").update(text.slice(0, 200)).digest("hex") });
    } else expect(end.tool.summaryRead).toBeUndefined();
  } finally {
    manager.disposeAll();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
