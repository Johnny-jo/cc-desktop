import { describe, expect, it, vi } from "vitest";
import { CpaSupervisor } from "./cpa-supervisor";

describe("CpaSupervisor", () => {
  it("buildEnv sets anthropic proxy vars", () => {
    const cpa = new CpaSupervisor({
      getSettings: () => ({
        cpaExePath: "x",
        cpaConfigPath: "y",
        cpaPort: 8317,
        defaultModel: "kimi-for-coding",
        models: [],
        permissionMode: "default",
        shutdownCpaOnQuit: false,
      }),
      getToken: () => "tok",
      probePort: async () => true,
      spawnProcess: vi.fn(),
    });
    const env = cpa.buildProcessEnv();
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok");
    expect(env.ANTHROPIC_MODEL).toBe("kimi-for-coding");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("ensureReady is ready when port open", async () => {
    const cpa = new CpaSupervisor({
      getSettings: () => ({
        cpaExePath: "x",
        cpaConfigPath: "y",
        cpaPort: 8317,
        defaultModel: "kimi-for-coding",
        models: [],
        permissionMode: "default",
        shutdownCpaOnQuit: false,
      }),
      getToken: () => "tok",
      probePort: async () => true,
      spawnProcess: vi.fn(),
    });
    const status = await cpa.ensureReady();
    expect(status.state).toBe("ready");
    expect(status.state === "ready" && status.managedByApp).toBe(false);
  });
});
