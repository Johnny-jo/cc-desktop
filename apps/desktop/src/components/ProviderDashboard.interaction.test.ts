import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@claude-desktop/shared";
import { ProviderDashboard } from "./ProviderDashboard";
import { ThemedSelect } from "./Select";

type EffectSlot = { deps?: unknown[]; cleanup?: () => void };
const hooks = vi.hoisted(() => ({
  cursor: 0, slots: [] as unknown[], pending: [] as Array<() => void>, writes: 0, containerWidth: 0,
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[i], (next: unknown) => {
      hooks.writes++;
      hooks.slots[i] = typeof next === "function" ? next(hooks.slots[i]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const i = hooks.cursor++;
    return hooks.slots[i] ??= { current: initial };
  },
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    const i = hooks.cursor++;
    const previous = hooks.slots[i] as EffectSlot | undefined;
    if (previous && deps && previous.deps?.length === deps.length && deps.every((dep, j) => Object.is(dep, previous.deps![j]))) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      hooks.slots[i] = { deps, cleanup: effect() || undefined } satisfies EffectSlot;
    });
  },
}));

function elements(tree: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  return React.Children.toArray(tree).flatMap(child => React.isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(typeof child.type === "function" && child.type !== ThemedSelect
      ? (child.type as (props: unknown) => React.ReactNode)(child.props)
      : child.props.children as React.ReactNode)] : []);
}
function text(tree: React.ReactNode): string {
  return React.Children.toArray(tree).map(child => React.isValidElement<Record<string, unknown>>(child)
    ? text(typeof child.type === "function" && child.type !== ThemedSelect ? (child.type as (props: unknown) => React.ReactNode)(child.props) : child.props.children as React.ReactNode)
    : String(child)).join(" ");
}
function render() {
  hooks.cursor = 0;
  const tree = ProviderDashboard();
  if (hooks.containerWidth) for (const element of elements(tree)) {
    const ref = element.props.ref as { current: unknown } | undefined;
    if (ref && typeof ref === "object") {
      ref.current ??= {};
      Object.assign(ref.current as object, { clientWidth: hooks.containerWidth });
    }
  }
  hooks.pending.splice(0).forEach(effect => effect());
  return tree;
}
function unmount() {
  for (const slot of hooks.slots) (slot as EffectSlot | undefined)?.cleanup?.();
}
function button(tree: React.ReactNode, label: string) {
  const found = elements(tree).find(n => n.type === "button" && text(n.props.children as React.ReactNode) === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
function click(tree: React.ReactNode, label: string) {
  (button(tree, label).props.onClick as () => void)();
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const zero = {
  requests: 0, successes: 0, failures: 0, cancellations: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, unreportedUsageRequests: 0, successRate: null as number | null,
  cacheReadReportedRequests: 0, cacheCreationReportedRequests: 0, cacheHitRequests: 0,
};
const metrics = {
  ...zero, requests: 10, successes: 6, failures: 2, cancellations: 2,
  inputTokens: 500, outputTokens: 400, cacheReadTokens: 500, cacheCreationTokens: 100, totalTokens: 1500,
  cacheReadReportedRequests: 6, cacheCreationReportedRequests: 2, cacheHitRequests: 4,
  successRate: 0.75,
};
const startAt = new Date("2026-11-09T00:00:00Z").getTime();
function fixture(range = "24h", override = {}) {
  return {
    range, startAt, endAt: startAt + 3 * 3600000, bucketMs: 3600000, recordingSince: startAt,
    metrics,
    buckets: [
      { ...zero, startAt, requests: 4, successes: 4, totalTokens: 1000, inputTokens: 500, outputTokens: 400, cacheCreationTokens: 100, successRate: 1 },
      { ...zero, startAt: startAt + 3600000 },
      { ...zero, startAt: startAt + 2 * 3600000, requests: 6, successes: 2, failures: 2, cancellations: 2, cacheReadTokens: 500, totalTokens: 500, successRate: 0.5 },
    ],
    providers: [
      { providerId: "claude-long-provider-account-identifier", providerName: "Personal Claude", providerType: "claude", metrics },
      { providerId: "gateway-long-provider-account-identifier", providerName: "Office gateway", providerType: "openai-compatible", metrics: zero },
    ],
    ...override,
  };
}
function desktopHarness(data = fixture()) {
  const listeners = new Map<string, () => void>();
  const unsubscribe = vi.fn((channel: string) => { listeners.delete(channel); });
  const desktop = {
    getProviderUsage: vi.fn(async (_range: string, _providerId?: string) => data),
    on: vi.fn((channel: string, listener: () => void) => {
      listeners.set(channel, listener);
      return () => unsubscribe(channel);
    }),
  };
  vi.stubGlobal("window", { desktop });
  return { desktop, listeners, unsubscribe };
}

beforeEach(() => {
  hooks.cursor = 0; hooks.slots = []; hooks.pending = []; hooks.writes = 0; hooks.containerWidth = 0;
});
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Provider usage dashboard", () => {
  it("shows actual token consumption, outcomes and separately scaled trends", async () => {
    const { desktop } = desktopHarness();
    render(); await settle();
    const tree = render();
    expect(desktop.getProviderUsage).toHaveBeenCalledWith("24h", undefined);
    expect(text(tree)).toContain("1,500");
    expect(text(tree)).toContain("75%");
    expect(text(tree)).toContain("缓存读取");
    expect(text(tree)).toContain("缓存创建");
    expect(text(tree)).toContain("已取消 2");
    expect(text(tree)).toContain("成功率不包含取消的请求");
    expect(text(tree)).not.toContain("上下文窗口");
    const svgs = elements(tree).filter(n => n.type === "svg");
    expect(svgs.map(n => n.props["aria-label"])).toEqual(["Token 消耗趋势", "请求成功率趋势"]);
    expect(text(svgs[1])).toContain("100%");
    expect(text(svgs[0])).not.toContain("100%");
  });

  it("loads all three ranges and filters by readable provider names", async () => {
    const { desktop } = desktopHarness();
    render(); await settle();
    click(render(), "7 天"); render(); await settle();
    expect(desktop.getProviderUsage).toHaveBeenLastCalledWith("7d", undefined);
    click(render(), "一个月"); render(); await settle();
    expect(desktop.getProviderUsage).toHaveBeenLastCalledWith("30d", undefined);
    const select = elements(render()).find(n => n.type === ThemedSelect)!;
    const labels = (select.props.options as Array<{ label: string }>).map(option => option.label).join(" ");
    expect(labels).toContain("全部 Provider");
    expect(labels).toContain("Personal Claude");
    expect(labels).not.toContain("long-provider-account-identifier");
    (select.props.onChange as (value: string) => void)("claude-long-provider-account-identifier");
    render(); await settle();
    expect(desktop.getProviderUsage).toHaveBeenLastCalledWith("30d", "claude-long-provider-account-identifier");
    expect(elements(render()).find(n => n.type === ThemedSelect)?.props.value).toBe("claude-long-provider-account-identifier");
  });

  it("leaves success-rate gaps for buckets without completed requests and offers keyboard-readable details", async () => {
    desktopHarness(); render(); await settle();
    const charts = elements(render()).filter(n => n.type === "svg");
    const ratePath = elements(charts[1]).find(n => n.type === "path")!;
    expect(String(ratePath.props.d).match(/M/g)).toHaveLength(2);
    expect(String(ratePath.props.d)).not.toContain("L");
    const focusPoints = elements(charts[1]).filter(n => n.props.tabIndex === 0);
    expect(focusPoints).toHaveLength(3);
    expect(focusPoints.map(n => n.props["aria-label"]).join(" ")).toContain("无已完成请求");
    expect(focusPoints.map(n => n.props["aria-label"]).join(" ")).toContain("50%");
  });

  it.each(["24h", "7d", "30d"])("includes the ending date in %s bucket details across midnight", async range => {
    const at = new Date("2026-11-09T15:30:00Z").getTime();
    const bucketMs = range === "24h" ? 3600000 : 86400000;
    desktopHarness(fixture(range, { startAt: at, endAt: at + bucketMs, bucketMs, recordingSince: at, buckets: [{ ...metrics, startAt: at }] }));
    render(); await settle();
    const ending = new Date(at + bucketMs).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const point = elements(render()).find(n => n.props.tabIndex === 0)!;
    expect(point.props["aria-label"]).toContain(` – ${ending}`);
  });

  it("matches chart coordinates to the available width so narrow layouts keep readable ticks and tooltips", async () => {
    let resize!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe = vi.fn();
      disconnect = disconnect;
    });
    hooks.containerWidth = 390;
    desktopHarness(); render(); await settle(); render();
    const chartWidth = () => Number(String(elements(render()).find(n => n.type === "svg")!.props.viewBox).split(" ")[2]);
    expect(chartWidth()).toBeLessThanOrEqual(390);
    expect(chartWidth()).toBeGreaterThan(300);
    hooks.containerWidth = 900; render(); resize();
    expect(chartWidth()).toBeGreaterThan(800);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it("leaves unrecorded history blank instead of implying zero token usage before recording began", async () => {
    desktopHarness(fixture("24h", {
      recordingSince: startAt + 3600000,
      buckets: [
        { ...zero, startAt },
        { ...zero, startAt: startAt + 3600000 },
        { ...metrics, startAt: startAt + 2 * 3600000 },
      ],
    }));
    render(); await settle();
    const chart = elements(render()).find(n => n.type === "svg")!;
    const points = elements(chart).filter(n => n.type === "circle");
    expect(points).toHaveLength(2);
    const historyBucket = elements(chart).find(n => n.props.tabIndex === 0)!;
    expect(historyBucket.props["aria-label"]).toContain("尚未开始统计");
    expect(historyBucket.props["aria-label"]).not.toContain("总计 0");
  });

  it("calls out missing upstream usage while keeping cancellation-only success rates undefined", async () => {
    const cancelled = { ...zero, requests: 2, cancellations: 2, unreportedUsageRequests: 2 };
    desktopHarness(fixture("24h", { metrics: cancelled, buckets: [{ ...cancelled, startAt }] }));
    render(); await settle();
    const tree = render();
    expect(text(tree)).toContain("有 2 个请求完全未上报用量");
    expect(text(tree)).toContain("失败/取消请求可能不完整");
    const rateChart = elements(tree).filter(n => n.type === "svg")[1];
    expect(elements(rateChart).filter(n => n.type === "path")).toHaveLength(0);
    expect(text(rateChart)).toContain("尚无可计算成功率的请求");
  });

  it("shows a real empty state and recording start instead of invented history", async () => {
    desktopHarness(fixture("24h", { metrics: zero, buckets: [] }));
    render(); await settle();
    const tree = render();
    expect(text(tree)).toContain("此时间范围内还没有请求记录");
    expect(text(tree)).toContain("统计从");
    expect(text(tree)).toContain("开始积累");
    expect(elements(tree).filter(n => n.type === "path")).toHaveLength(0);
    expect(text(tree)).not.toContain("0%");
  });

  it("refreshes usage events and releases event listeners and timers when unmounted", async () => {
    vi.useFakeTimers();
    const { desktop, listeners, unsubscribe } = desktopHarness();
    render(); await settle();
    expect(desktop.on).toHaveBeenCalledWith(IPC.providerUsageUpdated, expect.any(Function));
    desktop.getProviderUsage.mockResolvedValueOnce(fixture("24h", { metrics: { ...metrics, totalTokens: 9876 } }));
    listeners.get(IPC.providerUsageUpdated)!(); await settle();
    expect(text(render())).toContain("9,876");
    unmount();
    expect(unsubscribe).toHaveBeenCalledWith(IPC.providerUsageUpdated);
    expect(vi.getTimerCount()).toBe(0);
    const count = desktop.getProviderUsage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(desktop.getProviderUsage).toHaveBeenCalledTimes(count);
  });

  it("offers error retry and preserves successful data when a refresh fails", async () => {
    const { desktop } = desktopHarness();
    desktop.getProviderUsage.mockRejectedValueOnce(new Error("Database unavailable"));
    render(); await settle();
    expect(text(render())).toContain("Database unavailable");
    click(render(), "重试"); await settle();
    expect(elements(render()).some(n => n.props.role === "alert")).toBe(false);
    desktop.getProviderUsage.mockRejectedValueOnce(new Error("Refresh failed"));
    click(render(), "刷新"); await settle();
    expect(text(render())).toContain("Refresh failed");
    expect(text(render())).toContain("1,500");
  });

  it("ignores an older range response after a fast range switch", async () => {
    const { desktop } = desktopHarness();
    render(); await settle();
    const old = deferred<ReturnType<typeof fixture>>();
    desktop.getProviderUsage.mockImplementationOnce(() => old.promise);
    click(render(), "7 天"); render();
    desktop.getProviderUsage.mockResolvedValueOnce(fixture("30d", { metrics: { ...metrics, totalTokens: 2222 } }));
    click(render(), "一个月"); render(); await settle();
    old.resolve(fixture("7d", { metrics: { ...metrics, totalTokens: 1111 } })); await settle();
    expect(text(render())).toContain("2,222");
    expect(text(render())).not.toContain("1,111");
  });

  it("ignores a pending request completion after unmount", async () => {
    const { desktop } = desktopHarness();
    const pending = deferred<ReturnType<typeof fixture>>();
    desktop.getProviderUsage.mockImplementationOnce(() => pending.promise);
    render();
    expect(desktop.getProviderUsage).toHaveBeenCalledTimes(1);
    unmount();
    const writes = hooks.writes;
    pending.resolve(fixture()); await settle();
    expect(hooks.writes).toBe(writes);
  });
});
