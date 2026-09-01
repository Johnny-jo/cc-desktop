import { describe, expect, it, vi } from "vitest";
import { parseCpaQuotaObservation } from "./cpa-quota";

describe("parseCpaQuotaObservation", () => {
  it("parses Claude five-hour and seven-day quota", () => {
    const quota = parseCpaQuotaObservation("claude", {
      observed_at: "2026-09-01T00:00:00Z",
      signals: {
        "Anthropic-Ratelimit-Unified-5h-Utilization": "0.23",
        "Anthropic-Ratelimit-Unified-5h-Reset": "1788224400",
        "Anthropic-Ratelimit-Unified-7d-Utilization": "0.41",
      },
    });
    expect(quota?.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["5h", 23], ["7d", 41],
    ]);
  });

  it("selects the active Codex namespace", () => {
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
    const quota = parseCpaQuotaObservation("codex", {
      signals: {
        "X-Codex-Active-Limit": "codex_bengalfox",
        "X-Codex-Bengalfox-Primary-Used-Percent": "35",
        "X-Codex-Bengalfox-Primary-Window-Minutes": "300",
        "X-Codex-Bengalfox-Primary-Reset-After-Seconds": "60",
        "X-Codex-Other-Primary-Used-Percent": "99",
        "X-Codex-Plan-Type": "plus",
      },
    });
    expect(quota?.windows[0]).toMatchObject({ label: "5h", usedPercent: 35 });
    expect(quota?.plan).toBe("plus");
  });

  it("does not invent quota for unsupported providers", () => {
    expect(parseCpaQuotaObservation("openai-compatibility", { signals: { limit: "1" } })).toBeNull();
  });
});
