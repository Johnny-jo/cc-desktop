import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomSnapshot } from "@claude-desktop/shared";
import type { RoomModState } from "../state/room-store";
import { ModPlayPanel } from "./ModPlayPanel";

const state = vi.hoisted(() => ({
  activeRoom: null as RoomSnapshot | null,
  mod: null as RoomModState | null,
}));

vi.mock("../state/room-store", () => ({
  useRoomStore: (select: (value: typeof state) => unknown) => select(state),
}));
vi.mock("../i18n/useI18n", async () => {
  const { zh } = await import("../i18n/zh");
  return { useI18n: () => ({ locale: "zh", t: zh }) };
});

beforeEach(() => {
  state.mod = null;
  state.activeRoom = {
    roomId: "room", name: "Group", status: "open", port: 21000,
    hostLabel: "Host", inviteHost: "127.0.0.1", memberCount: 1,
    requireMods: false, modChecksum: "pack", autoApprove: true,
    hasPassword: false, encrypt: false, localUserId: "guest",
    members: [{ userId: "guest", name: "Guest", role: "member", modChecksum: "" }],
    seats: [{ id: "seat", kind: "human", name: "Guest", occupantUserId: "guest",
      takenOverBy: null, sessionId: null, running: false, agentName: null }],
    items: [],
  };
});

function render() {
  return renderToStaticMarkup(React.createElement(ModPlayPanel, {
    role: "member", seats: state.activeRoom!.seats, localUserId: "guest",
  }));
}

describe("Mod participation panel", () => {
  it("offers participation before any activity projection arrives", () => {
    expect(render()).toContain("加载 Mod 并参与");
  });

  it("shows public activity only to spectators even if private data is stale", () => {
    state.mod = {
      publicView: { title: "Public activity", phase: "play", lines: [] },
      seatViews: { seat: { secret: "private-role" } },
      actions: { vote: {} },
    };
    const html = render();
    expect(html).toContain("Public activity");
    expect(html).not.toContain("private-role");
    expect(html).not.toContain("room-mod-action-name");
    state.activeRoom!.members[0].modChecksum = "pack";
    expect(render()).toContain("private-role");
    expect(render()).toContain("room-mod-action-name");
  });

  it("does not offer participation when the room has no activity", () => {
    state.activeRoom!.modChecksum = "";
    expect(render()).toBe("");
  });
});
