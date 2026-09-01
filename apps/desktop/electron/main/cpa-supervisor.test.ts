import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CpaSupervisor, preferUnprefixedModels } from "./cpa-supervisor";

function touchCpaFiles(): { cpaExePath: string; cpaConfigPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-sup-"));
  const cpaExePath = path.join(dir, "cli-proxy-api.exe");
  const cpaConfigPath = path.join(dir, "config.yaml");
  fs.writeFileSync(cpaExePath, "x");
  fs.writeFileSync(cpaConfigPath, "port: 8317\n");
  return { cpaExePath, cpaConfigPath };
}

const baseSettings = {
  cpaExePath: "x",
  cpaConfigPath: "y",
  cpaPort: 8317,
  defaultModel: "kimi-for-coding",
  models: [] as [],
  permissionMode: "default" as const,
  shutdownCpaOnQuit: false,
  defaultContextLimit: 200_000,
  modelContextLimits: {},
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
    const paths = touchCpaFiles();

    const cpa = new CpaSupervisor({
      getSettings: () => ({ ...baseSettings, ...paths }),
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
    expect(spawnProcess).toHaveBeenCalledWith(
      paths.cpaExePath,
      ["--config", paths.cpaConfigPath],
      expect.objectContaining({
        env: expect.objectContaining({ MANAGEMENT_PASSWORD: "tok" }),
      }),
    );
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

  it("ensureReady reports error when child exits during start", async () => {
    const paths = touchCpaFiles();
    const child = {
      kill: vi.fn(() => true),
      on: (event: string, listener: (...args: unknown[]) => void) => {
        if (event === "exit") {
          queueMicrotask(() => listener(1, null));
        }
      },
      stderr: { on: vi.fn() },
    };
    const cpa = new CpaSupervisor({
      getSettings: () => ({ ...baseSettings, ...paths }),
      getToken: () => "tok",
      probePort: async () => false,
      spawnProcess: vi.fn().mockReturnValue(child),
      pollIntervalMs: 10,
      readyTimeoutMs: 80,
    });
    const status = await cpa.ensureReady();
    expect(status.state).toBe("error");
    if (status.state === "error") {
      expect(status.message).toMatch(/立即退出|exit 1/);
    }
  });

  it("preferUnprefixedModels drops provider/path duplicates", () => {
    expect(
      preferUnprefixedModels([
        "deepseek-v4-flash",
        "deepseek-v4-pro",
        "k3",
        "kimi/k3",
        "g2a/grok-4.5",
        "grok-4.5",
      ]),
    ).toEqual(["deepseek-v4-flash", "deepseek-v4-pro", "k3", "grok-4.5"]);
  });

  it("returns only quota mapped to the requested model", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/v0/management/auth-files")) {
        return {
          ok: true,
          json: async () => ({
            files: [
              {
                name: "codex-a.json",
                provider: "codex",
                quota: {
                  signals: {
                    "X-Codex-Primary-Used-Percent": "28",
                    "X-Codex-Primary-Window-Minutes": "300",
                  },
                },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ models: [{ id: "openai/gpt-5.6-sol" }] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const cpa = new CpaSupervisor({
      getSettings: () => ({ ...baseSettings }),
      getToken: () => "tok",
      probePort: async () => true,
      spawnProcess: vi.fn(),
    });

    const quota = await cpa.getModelQuota("gpt-5.6-sol");
    expect(quota).toMatchObject({
      modelId: "gpt-5.6-sol",
      provider: "codex",
      accountCount: 1,
    });
    expect(quota?.windows[0]?.usedPercent).toBe(28);
    expect(await cpa.getModelQuota("kimi-for-coding")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("listModelCatalog parses exact CPA registry capabilities and caches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "provider/deepseek-v4-flash", context_length: 65536 },
          {
            id: "deepseek-v4-flash",
            context_window: 128000,
            reasoning_efforts: [
              { value: "low" },
              { value: "high" },
              { value: "max" },
            ],
          },
          { id: "no-limit-model", context_window: 32000 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const cpa = new CpaSupervisor({
      getSettings: () => ({ ...baseSettings }),
      getToken: () => "tok",
      probePort: async () => true,
      spawnProcess: vi.fn(),
    });

    const catalog = await cpa.listModelCatalog();
    expect(catalog.some((m) => m.id === "deepseek-v4-flash")).toBe(true);
    const flash = catalog.find((m) => m.id === "deepseek-v4-flash");
    expect(flash?.contextLimit).toBe(128000);
    expect(flash?.reasoningEfforts).toEqual(["low", "high", "max"]);
    expect(flash?.defaultReasoningEffort).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8317/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.stringContaining("grok-shell"),
        }),
      }),
    );

    cpa.mergeSdkModelCapabilities([
      {
        value: "deepseek-v4-flash",
        supportsEffort: true,
        supportedEffortLevels: ["low", "xhigh", "max"],
      },
      {
        value: "no-limit-model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "xhigh"],
      },
    ]);
    // Exact CPA levels win over the SDK's generic proxy fallback.
    expect(
      cpa.getModelCatalog().find((model) => model.id === "deepseek-v4-flash")
        ?.reasoningEfforts,
    ).toEqual(["low", "high", "max"]);
    // SDK still fills a model for which CPA advertised no levels.
    expect(
      cpa.getModelCatalog().find((model) => model.id === "no-limit-model")
        ?.reasoningEfforts,
    ).toEqual(["low", "xhigh"]);
    expect(cpa.getModelCatalog().length).toBeGreaterThan(0);

    // listModels still returns string ids
    const ids = await cpa.listModels();
    expect(ids).toContain("deepseek-v4-flash");

    vi.unstubAllGlobals();
  });
});
