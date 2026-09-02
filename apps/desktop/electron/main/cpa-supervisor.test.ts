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
        cwd: path.dirname(paths.cpaConfigPath),
        env: expect.objectContaining({
          MANAGEMENT_PASSWORD: "tok",
          MANAGEMENT_STATIC_PATH: path.join(
            path.dirname(paths.cpaConfigPath),
            "static",
          ),
        }),
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

  it("actively refreshes Kimi quota and keeps the last value on failure", async () => {
    let fail = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (fail) return { ok: false, status: 503, json: async () => ({}) };
      if (url.endsWith("/v0/management/auth-files")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            files: [{ name: "kimi.json", type: "kimi", auth_index: "kimi-1" }],
          }),
        };
      }
      if (url.includes("/auth-files/models?")) {
        return { ok: true, status: 200, json: async () => ({ models: [{ id: "kimi-k3" }] }) };
      }
      const request = JSON.parse(String(init?.body)) as { url: string };
      expect(request.url).toBe("https://api.kimi.com/coding/v1/usages");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status_code: 200,
          body: { usage: { used: 20, limit: 100 } },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const cpa = new CpaSupervisor({
      getSettings: () => ({ ...baseSettings }),
      getToken: () => "tok",
      probePort: async () => true,
      spawnProcess: vi.fn(),
    });

    const fresh = await cpa.getModelQuota("kimi-k3");
    expect(fresh).toMatchObject({ provider: "kimi", stale: false, accountCount: 1 });
    expect(fresh?.windows[0]?.usedPercent).toBe(20);

    fail = true;
    const stale = await cpa.getModelQuota("kimi-k3");
    expect(stale).toMatchObject({ provider: "kimi", stale: true });
    expect(stale?.refreshFailedAt).toEqual(expect.any(Number));
    vi.unstubAllGlobals();
  });

  it("actively refreshes xAI/Grok weekly billing", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v0/management/auth-files")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            files: [{ name: "grok.json", provider: "grok", authIndex: "xai-1" }],
          }),
        };
      }
      if (url.includes("/auth-files/models?")) {
        return { ok: true, status: 200, json: async () => ({ models: [{ id: "grok-4.5" }] }) };
      }
      const request = JSON.parse(String(init?.body)) as { url: string };
      const weekly = request.url.includes("format=credits");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status_code: 200,
          body: {
            config: {
              currentPeriod: {
                type: weekly ? "WEEKLY" : "MONTHLY",
                start: "2026-09-01T00:00:00Z",
                end: weekly ? "2026-09-08T00:00:00Z" : "2026-10-01T00:00:00Z",
              },
              creditUsagePercent: weekly ? 35 : 10,
            },
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const cpa = new CpaSupervisor({
      getSettings: () => ({ ...baseSettings }),
      getToken: () => "tok",
      probePort: async () => true,
      spawnProcess: vi.fn(),
    });

    const quota = await cpa.getModelQuota("grok-4.5");
    expect(quota).toMatchObject({ provider: "xai", accountCount: 1 });
    expect(quota?.windows[0]).toMatchObject({ label: "Weekly", usedPercent: 35 });
    vi.unstubAllGlobals();
  });

  it("actively refreshes Antigravity quota for Gemini models", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v0/management/auth-files")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            files: [{
              name: "antigravity.json",
              type: "antigravity",
              auth_index: "ag-1",
              project_id: "project-1",
            }],
          }),
        };
      }
      if (url.includes("/auth-files/models?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ id: "gemini-3-pro-high" }] }),
        };
      }
      const request = JSON.parse(String(init?.body)) as { url: string; data: string };
      expect(request.url).toContain("retrieveUserQuotaSummary");
      expect(JSON.parse(request.data)).toEqual({ project: "project-1" });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status_code: 200,
          body: {
            groups: [{
              displayName: "Gemini 3 Pro",
              buckets: [{ window: "5h", remainingFraction: 0.8 }],
            }, {
              displayName: "Claude Sonnet 4.6",
              buckets: [{ window: "5h", remainingFraction: 0.1 }],
            }],
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const cpa = new CpaSupervisor({
      getSettings: () => ({ ...baseSettings }),
      getToken: () => "tok",
      probePort: async () => true,
      spawnProcess: vi.fn(),
    });

    const quota = await cpa.getModelQuota("gemini-3-pro-high");
    expect(quota).toMatchObject({ provider: "antigravity", accountCount: 1 });
    expect(quota?.windows).toHaveLength(1);
    expect(quota?.windows[0]?.usedPercent).toBeCloseTo(20);
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
