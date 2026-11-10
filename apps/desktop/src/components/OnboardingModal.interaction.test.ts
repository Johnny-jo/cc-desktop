import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingModal } from "./OnboardingModal";
import { ProviderSettings } from "./ProviderSettings";
import { zh } from "../i18n/zh";

const actions = vi.hoisted(() => ({ complete: vi.fn(async (_token: string, _start: boolean) => ({ ok: true, error: undefined as string | undefined })) }));
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[] }));
vi.mock("../state/store", () => ({ completeOnboarding: actions.complete, useAppStore: (selector: (state: unknown) => unknown) => selector({ cpaStatus: { state: "stopped" }, settings: {} }) }));
vi.mock("../i18n/useI18n", () => ({ useI18n: () => ({ t: zh }) }));
vi.mock("./ProviderSettings", () => ({ ProviderSettings: () => React.createElement("section", null, "Model accounts") }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[i], (next: unknown) => { hooks.slots[i] = typeof next === "function" ? next(hooks.slots[i]) : next; }];
  },
}));
function elements(tree: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  return React.Children.toArray(tree).flatMap(child => React.isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as React.ReactNode)] : []);
}
function render() { hooks.cursor = 0; return OnboardingModal({ open: true }); }
function finish(tree: React.ReactNode) {
  const button = elements(tree).find(n => n.type === "button" && /完成设置/.test(renderToStaticMarkup(n.props.children as React.ReactNode)));
  if (!button) throw new Error("Missing complete setup button");
  return (button.props.onClick as () => Promise<void>)();
}
beforeEach(() => { hooks.cursor = 0; hooks.slots = []; vi.clearAllMocks(); });
describe("Provider account onboarding", () => {
  it("embeds account management and completes without a gateway token", async () => {
    const tree = render();
    expect(elements(tree).some(n => n.type === ProviderSettings)).toBe(true);
    const html = renderToStaticMarkup(tree);
    expect(html).not.toContain("CPA");
    expect(html).not.toContain("网关");
    await finish(tree);
    expect(actions.complete).toHaveBeenCalledWith("", false);
  });
  it("keeps completion errors inline and allows another attempt", async () => {
    actions.complete.mockResolvedValueOnce({ ok: false, error: "Storage unavailable" });
    await finish(render());
    expect(renderToStaticMarkup(render())).toContain("Storage unavailable");
    await finish(render());
    expect(actions.complete).toHaveBeenCalledTimes(2);
  });
});
