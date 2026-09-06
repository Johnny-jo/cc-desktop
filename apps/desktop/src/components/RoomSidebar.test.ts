import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomListItem } from "@claude-desktop/shared";

vi.mock("../state/store", () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ settings: { locale: "zh" } }),
  clearActiveSession: () => {}, clearChangesSessionOverride: () => {},
  detachedWindowRoomId: () => null, detachedWindowSessionId: () => null,
}));
vi.mock("../state/room-changes-bridge", () => ({ syncRoomSeatSessions: () => {} }));

const room: RoomListItem = {
  roomId: "r", name: "开发群", status: "open", role: "host", memberCount: 3,
  onlineCount: 2, port: 0, inviteHost: "",
};
const at = new Date(2026, 8, 6, 9, 7).getTime();

async function renderRoom(patch: Partial<RoomListItem> = {}) {
  vi.stubGlobal("window", { desktop: { listRooms: async () => ({ rooms: [{ ...room, ...patch }] }) } });
  const store = await import("../state/room-store");
  await store.refreshRooms();
  store.selectRoom(room.roomId);
  const { RoomSidebar } = await import("./RoomSidebar");
  return renderToStaticMarkup(React.createElement(RoomSidebar));
}

beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals(); });

describe("group list row", () => {
  it("renders a local initial, name and real message time above the sender preview", async () => {
    const html = await renderRoom({ lastMessage: { authorLabel: "开发", text: "已完成 [文件]", at } });
    expect(html).toMatch(/class="room-list-avatar"[^>]*>开<\/span>/);
    expect(html).toMatch(/class="room-list-heading"[^>]*>.*开发群.*<time[^>]*>09:07<\/time><\/span>/);
    expect(html).toMatch(/class="room-list-preview"[^>]*>开发: 已完成 \[文件\]<\/span>/);
    expect(html).toContain(`dateTime="${new Date(at).toISOString()}"`);
    expect(html).toContain("active");
  });

  it("shows an empty preview without inventing a time for a room with no chat", async () => {
    const html = await renderRoom();
    expect(html).toContain('class="room-list-preview"');
    expect(html).toContain("暂无消息");
    expect(html).not.toContain("<time");
  });

  it("retains the rejoin action with a real recalled-message preview", async () => {
    const html = await renderRoom({ offline: true, status: "ended", lastMessage: { authorLabel: "小明", text: "已撤回", at } });
    expect(html).toContain("小明: 已撤回");
    expect(html).toContain("room-row-rejoin");
    expect(html).toContain("重连");
    expect(html).toContain("双击或拖出侧栏在新窗口打开");
  });

  it("escapes preview text and uses a whole Unicode initial", async () => {
    const html = await renderRoom({ name: "  😀讨论", lastMessage: { authorLabel: "<b>人</b>", text: "<script>alert(1)</script>", at } });
    expect(html).toMatch(/class="room-list-avatar"[^>]*>😀<\/span>/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("omits an invalid timestamp without affecting the preview", async () => {
    const html = await renderRoom({ lastMessage: { authorLabel: "开发", text: "答复", at: NaN } });
    expect(html).toContain("开发: 答复");
    expect(html).not.toContain("<time");
  });
});
