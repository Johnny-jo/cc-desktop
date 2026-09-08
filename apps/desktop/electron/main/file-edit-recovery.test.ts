import { describe, expect, it } from "vitest";
import { fileEditRecovery } from "./file-edit-recovery";

describe("file edit recovery", () => {
  it.each(["Edit", "Write", "MultiEdit"])("provides conflict and permission recovery for %s", async (tool_name) => {
    const result = await fileEditRecovery({ tool_name });
    expect(result.hookSpecificOutput?.hookEventName).toBe("PostToolUseFailure");
    const guidance = result.hookSpecificOutput?.additionalContext;
    expect(guidance).toContain("重新读取最新文件");
    expect(guidance).toContain("AskUserQuestion");
    expect(guidance).toContain("等待答复后再操作");
    expect(guidance).toContain("不得为了绕过");
  });
  it("does not restart interrupted edits or interfere with unrelated tools", async () => {
    expect(await fileEditRecovery({ tool_name: "Edit", is_interrupt: true })).toEqual({});
    expect(await fileEditRecovery({ tool_name: "Read" })).toEqual({});
    expect(await fileEditRecovery({ tool_name: "Bash" })).toEqual({});
  });
});
