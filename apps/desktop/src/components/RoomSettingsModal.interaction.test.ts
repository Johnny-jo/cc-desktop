import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomSnapshot } from "@claude-desktop/shared";
import { zh } from "../i18n/zh";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (next: unknown) => {
      hooks.slots[index] = typeof next === "function" ? next(hooks.slots[index]) : next;
    }];
  },
}));
vi.mock("react-dom", async original => ({ ...await original<typeof import("react-dom")>(), createPortal: (node: unknown) => node }));
vi.mock("../i18n/useI18n", () => ({ useI18n: () => ({ t: zh }) }));
vi.mock("../lib/room-notify", () => ({ isRoomMuted: () => false, setRoomMuted: vi.fn() }));
import { RoomSettingsModal } from "./RoomSettingsModal";

const room: RoomSnapshot = {
  roomId: "r", name: "原群名", status: "open", port: 18765, hostLabel: "本人", inviteHost: "",
  memberCount: 1, requireMods: false, modChecksum: "", autoApprove: false, hasPassword: false,
  encrypt: true, localUserId: "me", members: [{ userId: "me", name: "本人", role: "host" }], seats: [], items: [],
};
function nodes(element: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  return React.Children.toArray(element).flatMap(child => React.isValidElement<Record<string, unknown>>(child)
    ? [child, ...nodes(child.props.children as React.ReactNode)] : []);
}
function text(element: React.ReactNode): string {
  return React.Children.toArray(element).map(child => React.isValidElement<{ children?: React.ReactNode }>(child)
    ? text(child.props.children) : String(child)).join("");
}
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0;
  vi.stubGlobal("document", { body: {} });
});

describe("RoomSettingsModal invitation feedback", () => {
  it("shows an invitation failure after a dirty-name close prompt, without losing the name draft", async () => {
    const onInvite = vi.fn(async () => ({ ok: false, error: "邀请服务暂时不可用" }));
    const onClose = vi.fn();
    const render = () => { hooks.cursor = 0; return RoomSettingsModal({ room, canHost: true, onInvite, onClose }); };
    const input = () => nodes(render()).find(node => node.props.id === "room-name-input")!;
    (input().props.onChange as (event: unknown) => void)({ target: { value: "修改后的群名" } });
    (nodes(render()).find(node => node.props.className === "settings-close-btn")!.props.onClick as () => void)();
    expect(text(render())).toContain("放弃未保存的群聊名称？");
    await (nodes(render()).find(node => node.props["aria-label"] === "邀请成员")!.props.onClick as () => Promise<void>)();
    expect(onInvite).toHaveBeenCalledOnce();
    expect(text(render())).toContain("邀请服务暂时不可用");
    expect(input().props.value).toBe("修改后的群名");
    expect(onClose).not.toHaveBeenCalled();
  });
});
