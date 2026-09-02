import { describe, expect, it, vi } from "vitest";
import { parseCpaQuotaObservation, parseCpaQuotaPayload } from "./cpa-quota";

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

  it("parses ISO timestamps as dates, not as 1970 epoch seconds", () => {
    const quota = parseCpaQuotaObservation("claude", {
      observed_at: "2026-09-01T00:00:00Z",
      signals: {
        "Anthropic-Ratelimit-Unified-5h-Utilization": "0.23",
        "Anthropic-Ratelimit-Unified-5h-Reset": "2026-09-01T05:00:00Z",
      },
    });
    expect(quota?.observedAt).toBe(Date.parse("2026-09-01T00:00:00Z"));
    expect(quota?.windows[0]?.resetAt).toBe(Date.parse("2026-09-01T05:00:00Z"));
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

  it("parses Kimi subscription usage windows", () => {
    const quota = parseCpaQuotaPayload("kimi", {
      limits: [
        {
          title: "5 hour",
          detail: { used: 25, limit: 100, reset_in: 60 },
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        },
      ],
    }, 1_700_000_000_000);
    expect(quota?.windows[0]).toMatchObject({
      label: "5 hour",
      usedPercent: 25,
      windowMinutes: 300,
      resetAt: 1_700_000_060_000,
    });
  });

  it("parses xAI weekly billing and product usage", () => {
    const quota = parseCpaQuotaPayload("grok", {
      config: {
        currentPeriod: {
          type: "WEEKLY",
          start: "2026-09-01T00:00:00Z",
          end: "2026-09-08T00:00:00Z",
        },
        creditUsagePercent: "40",
        productUsage: [{ product: "Grok Code", usagePercent: 55 }],
      },
    });
    expect(quota?.windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["Weekly", 40],
      ["Grok Code", 55],
    ]);
    expect(quota?.windows[0]?.windowMinutes).toBe(10_080);
  });

  it("parses Antigravity grouped remaining fractions", () => {
    const quota = parseCpaQuotaPayload("antigravity", {
      groups: [{
        displayName: "Gemini 3 Pro",
        buckets: [{
          displayName: "5 hour",
          window: "5h",
          remainingFraction: 0.7,
          resetTime: "2026-09-01T05:00:00Z",
        }],
      }],
    });
    expect(quota?.windows[0]).toMatchObject({
      label: "Gemini 3 Pro · 5 hour",
      windowMinutes: 300,
      resetAt: Date.parse("2026-09-01T05:00:00Z"),
    });
    expect(quota?.windows[0]?.usedPercent).toBeCloseTo(30);
  });
});
