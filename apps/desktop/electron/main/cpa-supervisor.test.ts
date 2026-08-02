import { describe, expect, it, vi } from "vitest";
import { CpaSupervisor } from "./cpa-supervisor";

const baseSettings = {
  cpaExePath: "x",
  cpaConfigPath: "y",
  cpaPort: 8317,
  defaultModel: "kimi-for-coding",
  models: [] as [],
  permissionMode: "default" as const,
  shutdownCpaOnQuit: false,
};

describe("CpaSupervisor", () => {
  it("buildEnv sets anthropic proxy vars", () => {
    const cpa = new CpaSupervisor({
      getSettings: () => ({ ...baseSettings }),
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
      getSettings: () => ({ ...baseSettings }),
      getToken: () => "tok",
      probePort: async () => true,
      spawnProcess: vi.fn(),
    });
    const status = await cpa.ensureReady();
    expect(status.state).toBe("ready");
    expect(status.state === "ready" && status.managedByApp).toBe(false);
  });

  it("ensureReady timeout kills managed child and does not leak on retry", async () => {
    const kill1 = vi.fn(() => true);
    const kill2 = vi.fn(() => true);
    const child1 = { kill: kill1, on: vi.fn() };
    const child2 = { kill: kill2, on: vi.fn() };
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(child1)
      .mockReturnValueOnce(child2);

    const cpa = new CpaSupervisor({
      getSettings: () => ({ ...baseSettings }),
      getToken: () => "tok",
      // Port never becomes ready — forces spawn + ready timeout path.
      probePort: async () => false,
      spawnProcess,
      pollIntervalMs: 10,
      readyTimeoutMs: 40,
    });

    const status1 = await cpa.ensureReady();
    expect(status1.state).toBe("error");
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    // Timed out: managed child must be killed and ownership cleared.
    expect(kill1).toHaveBeenCalled();
    expect(cpa.getStatus().state).toBe("error");

    // stopIfManaged should be a no-op after cleanup (child already cleared).
    cpa.stopIfManaged();
    expect(kill1).toHaveBeenCalledTimes(1);

    // Retry ensureReady: must spawn a fresh process, not leave the old one alive.
    const status2 = await cpa.ensureReady();
    expect(status2.state).toBe("error");
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(kill2).toHaveBeenCalled();
    // First child was already cleaned on timeout; second retry should not
    // re-kill it as a "previous managed child" beyond that cleanup.
    expect(kill1).toHaveBeenCalledTimes(1);
  });
});
