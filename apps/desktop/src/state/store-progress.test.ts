import { beforeEach, describe, expect, it } from "vitest";
import type { SessionSummary } from "@claude-desktop/shared";
import {
  __applySessionEventForTests, __resetStoreForTests, __upsertSessionForTests,
  getState, RENDERER_TRANSCRIPT_CAP,
} from "./store";

const summary: SessionSummary = {
  id: "progress", title: "Long task", cwd: "D:/project", updatedAt: 1, status: "running",
  progress: {
    tasks: [{ id: "7", title: "Verify", status: "in_progress" }],
    agents: [{ id: "agent-a", toolUseId: "call-a", title: "Inspect", status: "running" }],
  },
};

beforeEach(() => __resetStoreForTests());

describe("main chat progress summary routing", () => {
  it("keeps progress beyond the renderer history cap and the parent's result", () => {
    __upsertSessionForTests(summary);
    for (let i = 0; i < RENDERER_TRANSCRIPT_CAP + 10; i++) {
      __applySessionEventForTests({ type: "text_done", sessionId: summary.id, text: `Output ${i}` });
    }
    __applySessionEventForTests({ type: "result", sessionId: summary.id, ok: true });
    expect(getState().itemsBySession[summary.id]).toHaveLength(RENDERER_TRANSCRIPT_CAP);
    expect(getState().sessions[0]).toMatchObject({ status: "idle", progress: summary.progress });
  });

  it("updates an inactive session's progress without switching the active conversation", () => {
    __upsertSessionForTests({ ...summary, id: "active" });
    __upsertSessionForTests({ ...summary, status: "idle" });
    __upsertSessionForTests({
      ...summary, status: "idle",
      progress: { tasks: [], agents: [{ ...summary.progress!.agents[0], status: "completed", summary: "Verified" }] },
    });
    expect(getState().activeSessionId).toBe("active");
    expect(getState().sessions.find(value => value.id === summary.id)?.progress?.agents[0]).toMatchObject({ status: "completed", summary: "Verified" });
  });

  it("removes discarded task progress when an authoritative rewind summary clears it", () => {
    __upsertSessionForTests(summary);
    __upsertSessionForTests({ ...summary, progress: undefined, status: "idle" });
    expect(getState().sessions[0].progress).toBeUndefined();
  });
});
