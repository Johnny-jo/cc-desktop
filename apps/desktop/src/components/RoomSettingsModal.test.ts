import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomSnapshot } from "@claude-desktop/shared";
import { zh } from "../i18n/zh";

vi.mock("react-dom", async original => ({ ...await original<typeof import("react-dom")>(), createPortal: (node: unknown) => node }));
vi.mock("../i18n/useI18n", () => ({ useI18n: () => ({ t: zh }) }));
vi.mock("../lib/room-notify", () => ({ isRoomMuted: () => false, setRoomMuted: vi.fn() }));
import { RoomSettingsModal } from "./RoomSettingsModal";

const room: RoomSnapshot = {
  roomId: "room", name: "研发群", status: "open", port: 18765, hostLabel: "Johnny",
  inviteHost: "192.168.1.2", memberCount: 1, requireMods: false, modChecksum: "game-123",
  autoApprove: false, hasPassword: false, encrypt: true, localUserId: "me",
  members: [{ userId: "me", name: "Johnny", role: "host" }], seats: [], items: [],
  kernel: { mods: [{ id: "pulse", name: "定时任务", version: "1", state: "active" }] },
};
beforeEach(() => vi.stubGlobal("document", { body: {} }));
function render(overrides: Partial<React.ComponentProps<typeof RoomSettingsModal>> = {}) {
  return renderToStaticMarkup(React.createElement(RoomSettingsModal, {
    room, canHost: true, onClose: () => {}, onInvite: async () => ({ ok: true }), ...overrides,
  }));
}

describe("RoomSettingsModal connection details", () => {
  it("hides settings while the invitation dialog is above it", () => {
    expect(render({ suspended: true })).toBe("");
  });
  it("contains the connection, encryption, extensions and activity information removed from the chat header", () => {
    const html = render();
    for (const text of ["连接信息", "本地主持", "已启用加密", "定时任务", "已启用群活动", "18765"]) expect(html).toContain(text);
    expect(html).toContain('aria-label="邀请成员"');
  });
  it("does not expose host invitation to a guest or a disconnected room", () => {
    expect(render({ canHost: false })).not.toContain('aria-label="邀请成员"');
    const html = render({ offline: true });
    expect(html).toContain("连接已断开");
    expect(html).not.toContain('aria-label="邀请成员"');
  });
  it("shows unencrypted and inactive states truthfully", () => {
    const html = render({ room: { ...room, encrypt: false, modChecksum: "", kernel: undefined } });
    expect(html).toContain("未启用加密");
    expect(html).toContain("未启用扩展");
    expect(html).toContain("暂无群活动");
  });
});
