import React, { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RoomTimelineItem } from "@claude-desktop/shared";
import {
  ROOM_TIMELINE_RENDER_LIMIT,
  RoomTimeline,
  compactRoomTimelineItems,
} from "./RoomTimeline";

describe("RoomTimeline", () => {
  it("hides join and leave noise and keeps only the newest recovery status", () => {
    const systemItem = (id: string, text: string): RoomTimelineItem => ({
      id,
      at: Number(id.replace(/\D/g, "")) || 0,
      seatId: "",
      authorUserId: null,
      authorLabel: "系统",
      kind: "system",
      text,
    });
    const items = [
      systemItem("system-1", "Alice 加入了群聊"),
      systemItem("system-2", "Alice 已重新连接"),
      systemItem("system-3", "群聊名称已修改"),
      systemItem("system-4", "Bob 退出了群聊"),
      systemItem("system-5", "已重新连接主机"),
    ];

    expect(compactRoomTimelineItems(items).map((item) => item.id)).toEqual([
      "system-3",
      "system-5",
    ]);
  });

  it("mounts only the newest 80 message rows", () => {
    const items: RoomTimelineItem[] = Array.from({ length: 100 }, (_, index) => ({
      id: `item-${index}`,
      at: index,
      seatId: "seat-1",
      authorUserId: "user-1",
      authorLabel: "user",
      kind: "user",
      text: `message-${index}`,
    }));
    const html = renderToStaticMarkup(
      React.createElement(RoomTimeline, {
        items,
        seats: [
          {
            id: "seat-1",
            kind: "human",
            name: "user",
            occupantUserId: "user-1",
            takenOverBy: null,
            sessionId: null,
            running: false,
            agentName: null,
          },
        ],
        selectedSeatId: null,
        myUserId: "user-1",
        timelineRef: createRef<HTMLDivElement>(),
        onOpenMenu: () => undefined,
      }),
    );

    expect((html.match(/kind-user/g) ?? [])).toHaveLength(
      ROOM_TIMELINE_RENDER_LIMIT,
    );
    expect(html).not.toContain("message-19");
    expect(html).toContain("message-20");
    expect(html).toContain("message-99");
    expect(html).toContain("较早的 20 条消息暂不渲染");
  });
});
