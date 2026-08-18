import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostRoomKv } from "./mod-kernel-store";
import {
  IMPROVE_MCP,
  IMPROVE_TOOLS,
  MEMORY_MCP,
  MEMORY_TOOLS,
  tryCreateImproveMcp,
  tryCreateMemoryMcp,
} from "./mod-kernel-compile";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  dirs.length = 0;
});

describe("tryCreateMemoryMcp", () => {
  it("creates an always-loaded in-process memory MCP the SDK accepts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-mcp-"));
    dirs.push(dir);
    const kv = new HostRoomKv(path.join(dir, "store.json"));
    const opts = tryCreateMemoryMcp(kv);
    expect(opts).not.toBeNull();
    expect(opts?.extraMcpServers?.[MEMORY_MCP]).toBeTruthy();
    expect(opts?.extraAllowedTools).toEqual(
      expect.arrayContaining([...MEMORY_TOOLS, `mcp__${MEMORY_MCP}__memory_get`]),
    );
  });
});

describe("tryCreateImproveMcp", () => {
  it("creates an always-loaded improve MCP the SDK accepts", () => {
    const opts = tryCreateImproveMcp({
      list: () => [],
      getSource: () => null,
      propose: () => ({ ok: true, decision: "pending", status: "pending" }),
      status: () => ({ autonomy: 0, proposals: [], canRollback: [] }),
      rollback: () => ({ ok: false, error: "none" }),
    });
    expect(opts).not.toBeNull();
    expect(opts?.extraMcpServers?.[IMPROVE_MCP]).toBeTruthy();
    expect(opts?.extraAllowedTools).toEqual(
      expect.arrayContaining([...IMPROVE_TOOLS, `mcp__${IMPROVE_MCP}__kernel_propose`]),
    );
  });
});
