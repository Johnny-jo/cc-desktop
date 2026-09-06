import React, { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RoomAttachmentRef, RoomSeat, RoomTimelineItem } from "@claude-desktop/shared";
import {
  ROOM_TIMELINE_RENDER_LIMIT,
  RoomMessageRow,
  RoomTimeline,
  compactRoomTimelineItems,
  resolveRoomMessageAuthorSeat,
} from "./RoomTimeline";

const agentSeat: RoomSeat = {
  id: "agent-1",
  kind: "agent",
  name: "开发员",
  occupantUserId: null,
  takenOverBy: null,
  sessionId: null,
  running: false,
  agentName: "developer",
};

const attachment: RoomAttachmentRef = {
  id: "9e2cd485-2b96-4cde-a4b3-6efe1d03c96c",
  name: "@Johnny 设计稿.png",
  size: 1536,
  mimeType: "image/png",
  kind: "image",
  sha256: "a".repeat(64),
};

function message(overrides: Partial<RoomTimelineItem> = {}): RoomTimelineItem {
  return {
    id: "message-1",
    at: 0,
    seatId: agentSeat.id,
    authorUserId: "me",
    authorLabel: "Johnny",
    kind: "user",
    text: "请检查布局",
    ...overrides,
  };
}

function renderTimeline(
  props: Partial<React.ComponentProps<typeof RoomTimeline>> = {},
) {
  return renderToStaticMarkup(
    React.createElement(RoomTimeline, {
      roomId: "room-1",
      items: [],
      seats: [agentSeat],
      selectedSeatId: null,
      myUserId: "me",
      timelineRef: createRef<HTMLDivElement>(),
      onOpenMenu: () => undefined,
      ...props,
    }),
  );
}

function messageRows(html: string): string[] {
  return html.split(/(?=<div class="room-msg(?:\s|"))/u)
    .filter((part) => part.startsWith('<div class="room-msg'));
}

function rowClasses(row: string): string[] {
  return (row.match(/^<div class="([^"]+)"/u)?.[1] ?? "").split(" ");
}

function expectSenderHeader(row: string, sender: string, at: number) {
  const header = row.match(/<div class="room-msg-meta">([\s\S]*?)<\/div>/u)?.[1];
  expect(header).toBeDefined();
  expect(header?.replace(/<[^>]+>/gu, "")).toBe(sender + new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit",
  }));
  expect(header?.match(/<(?:span|time)\b/gu)).toHaveLength(2);
}

describe("RoomTimeline", () => {
  const humanSeat: RoomSeat = { ...agentSeat, id: "human", name: "Johnny", kind: "human", occupantUserId: "me" };
  const otherHumanSeat: RoomSeat = { ...humanSeat, id: "other-human", name: "小林", occupantUserId: "other-user" };

  it.each(["", agentSeat.id])("renders system notices without an avatar or sender header (legacy seat %s)", seatId => {
    const [row] = messageRows(renderTimeline({
      seats: [agentSeat, humanSeat], selectedSeatId: agentSeat.id, onMentionSeat: () => {},
      items: [message({ kind: "system", seatId, authorLabel: "系统", source: "kernel", text: "群聊名称已修改\n<公告> & 提醒" })],
    }));

    expect(rowClasses(row)).toContain("kind-system");
    expect(rowClasses(row)).not.toContain("is-human");
    expect(rowClasses(row)).not.toContain("is-agent");
    expect(rowClasses(row)).not.toContain("is-me");
    expect(row).not.toContain("room-msg-avatar");
    expect(row).not.toContain("room-msg-meta");
    expect(row).not.toContain("room-msg-author");
    expect(row).not.toContain("room-msg-source");
    expect(row).not.toContain("room-msg-seat");
    expect(row).not.toContain('role="button"');
    expect(row).not.toContain("<svg");
    expect(row).not.toContain("系统");
    expect(row).not.toContain(agentSeat.name);
    expect(row).toContain("群聊名称已修改\n&lt;公告&gt; &amp; 提醒");
  });

  it("keeps a system notice's full timestamp accessible without a message header", () => {
    const at = Date.UTC(2026, 8, 6, 4, 23, 45);
    const html = renderTimeline({ items: [message({ kind: "system", at, text: "群聊名称已修改" })] });
    const time = html.match(/<time\b([^>]*)>([^<]+)<\/time>/u);

    expect(time).not.toBeNull();
    expect(time?.[1]).toContain(`dateTime="${new Date(at).toISOString()}"`);
    expect(time?.[1]).not.toMatch(/\bhidden\b|aria-hidden/);
    expect(time?.[2]).toBe(new Date(at).toLocaleString());
    expect(html).not.toContain("room-msg-meta");
  });

  it.each([NaN, Number.MAX_VALUE])("keeps a system notice visible without machine-readable time for invalid at=%s", at => {
    let html = "";
    expect(() => {
      html = renderTimeline({ items: [message({ kind: "system", at, text: "群聊名称已修改" })] });
    }).not.toThrow();

    expect(html).toContain('class="room-msg-text">群聊名称已修改</div>');
    expect(html).not.toMatch(/\bdatetime=/iu);
    expect(html).not.toContain("room-msg-avatar");
    expect(html).not.toContain("room-msg-meta");
  });

  it.each([
    ["matching sender and seat names", { seatId: humanSeat.id }],
    ["a legacy target Agent", { seatId: agentSeat.id }],
    ["a legacy target human", { seatId: otherHumanSeat.id }],
    ["a renamed actual author", { authorLabel: "旧昵称" }],
    ["a departed actual author", { authorUserId: "departed" }],
    ["a missing author identity", { authorUserId: null }],
    ["an extension-sourced message", { source: "kernel" }],
  ] satisfies Array<[string, Partial<RoomTimelineItem>]>) (
    "renders only the actual human sender and time with %s", (_description, overrides) => {
      const item = message({ at: Date.UTC(2026, 8, 6, 4, 23), ...overrides });
      const [row] = messageRows(renderTimeline({ items: [item], seats: [agentSeat, humanSeat, otherHumanSeat] }));

      expectSenderHeader(row, humanSeat.name, item.at);
      expect(rowClasses(row)).toContain("is-human");
      expect(rowClasses(row).includes("is-me")).toBe(item.authorUserId === "me");
    },
  );

  it.each([
    ["assistant", agentSeat.name], ["assistant", "旧 Agent 名"],
    ["tool", agentSeat.name], ["tool", "旧 Agent 名"],
  ] as const)("renders only the Agent seat name and time for %s (label %s)", (kind, authorLabel) => {
    const item = message({ kind, authorLabel, source: "kernel", at: Date.UTC(2026, 8, 6, 4, 24) });
    const [row] = messageRows(renderTimeline({ items: [item], seats: [agentSeat, humanSeat] }));

    expectSenderHeader(row, agentSeat.name, item.at);
    expect(rowClasses(row)).toContain("is-agent");
    expect(rowClasses(row)).not.toContain("is-me");
  });

  it("keeps the recorded Agent name when its seat no longer exists", () => {
    const item = message({ kind: "assistant", seatId: "departed-agent", authorLabel: "历史 Agent" });
    const [row] = messageRows(renderTimeline({ items: [item], seats: [agentSeat, humanSeat], onMentionSeat: () => {} }));

    expectSenderHeader(row, item.authorLabel, item.at);
    expect(row).not.toContain('role="button"');
  });

  it("renders the actual human game sender once while preserving the game result", () => {
    const item = message({ kind: "game", authorLabel: "旧昵称", game: { type: "dice", value: "🎲" } });
    const [row] = messageRows(renderTimeline({ items: [item], seats: [agentSeat, humanSeat] }));

    expectSenderHeader(row, humanSeat.name, item.at);
    expect(rowClasses(row)).toContain("is-human");
    expect(rowClasses(row)).toContain("is-me");
    expect(row).toContain('class="room-game-icon">🎲</span>');
    expect(row).toContain(item.text);
  });

  it.each(["user", "assistant"] as const)("labels the %s avatar with the resolved sender name", kind => {
    const [row] = messageRows(renderTimeline({ seats: [agentSeat, humanSeat], onMentionSeat: () => {},
      items: [message({ kind, authorLabel: "旧昵称" })],
    }));

    expect(row).toContain('role="button"');
    expect(row).toContain('tabindex="0"');
    expect(row).toContain(`aria-label="提及 ${kind === "user" ? humanSeat.name : agentSeat.name}"`);
    expect(row).not.toContain("旧昵称");
  });

  it.each([
    ["departed human", { authorUserId: "departed" }],
    ["recalled human", { recalled: true }],
    ["recalled Agent", { kind: "assistant", recalled: true }],
    ["tool output", { kind: "tool" }],
    ["game result", { kind: "game" }],
  ] satisfies Array<[string, Partial<RoomTimelineItem>]>) (
    "does not enable avatar mentions for a %s", (_description, overrides) => {
      const html = renderTimeline({ seats: [agentSeat, humanSeat], onMentionSeat: () => {}, items: [message(overrides)] });

      expect(html).not.toContain('role="button"');
      expect(html).not.toContain('tabindex="0"');
      expect(html).not.toContain('aria-label="提及 ');
    },
  );

  it.each(["user", "assistant", "tool", "system"] as const)(
    "renders attachment-only %s messages in the real timeline",
    (kind) => {
      const html = renderTimeline({ items: [message({ kind, text: "", attachments: [attachment] })] });

      expect(html).toContain('class="room-attachments"');
      expect(html).toContain(attachment.name);
      expect(html).toContain("1536 B");
      expect(html).toContain("image/png");
      expect(html).toContain('aria-label="预览 @Johnny 设计稿.png"');
      expect(html).toContain('aria-label="保存 @Johnny 设计稿.png"');
      expect(html).not.toContain('class="room-msg-text');
      expect(html).not.toContain("<img");
      expect(html).not.toContain(attachment.sha256);
    },
  );
  it.each(["user", "assistant"] as const)(
    "keeps %s text mentions and quotes separate from attachment names",
    (kind) => {
      const html = renderTimeline({ seats: [agentSeat, humanSeat], selectedSeatId: agentSeat.id, items: [message({
        kind,
        text: "@Johnny 请检查",
        mentions: [{ seatId: humanSeat.id, start: 0, end: 7 }],
        quote: { id: "quoted", authorLabel: "小林", text: "@Johnny 原消息" },
        attachments: [attachment],
      })] });

      expect(html.match(/class="room-mention is-me"/g)).toHaveLength(1);
      expect(html).toContain('class="room-msg-quote-text">@Johnny 原消息</span>');
      expect(html).toContain(attachment.name);
      expect(rowClasses(messageRows(html)[0])).toContain("focus");
      expect(rowClasses(messageRows(html)[0])).toContain(kind === "user" ? "is-human" : "is-agent");
    },
  );
  it.each(["user", "assistant", "tool", "system"] as const)(
    "never renders recalled %s attachment references or previews",
    (kind) => {
      const html = renderTimeline({ items: [message({ kind, text: "", recalled: true, attachments: [attachment] })] });
      expect(html).toContain("此消息已撤回");
      expect(html).not.toContain("room-attachments");
      expect(html).not.toContain(attachment.name);
      expect(html).not.toContain(attachment.id);
      expect(html).not.toContain("<img");
    },
  );
  it("updates memoized rows when attachment metadata or room identity changes", () => {
    const compare = (RoomMessageRow as unknown as {
      compare: (a: React.ComponentProps<typeof RoomMessageRow>, b: React.ComponentProps<typeof RoomMessageRow>) => boolean;
    }).compare;
    const props: React.ComponentProps<typeof RoomMessageRow> = {
      roomId: "room-1", item: message({ attachments: [attachment] }), seat: agentSeat,
      selected: false, isMe: true, seats: [], mySeatId: null, onOpenMenu: () => {},
    };
    expect(compare(props, { ...props, item: { ...props.item, attachments: [{ ...attachment }] } })).toBe(true);
    for (const change of [
      { id: "another-attachment" }, { name: "renamed.png" }, { size: 2048 },
      { mimeType: "image/jpeg" }, { kind: "binary" as const }, { sha256: "b".repeat(64) },
    ]) {
      expect(compare(props, { ...props, item: { ...props.item, attachments: [{ ...attachment, ...change }] } })).toBe(false);
    }
    expect(compare(props, { ...props, item: { ...props.item, attachments: [] } })).toBe(false);
    expect(compare(props, { ...props, roomId: "room-2" })).toBe(false);
  });

  it("highlights only validated metadata, using IDs for identical display names", () => {
    const seats = [agentSeat, humanSeat, { ...humanSeat, id: "namesake", occupantUserId: "other" }];
    const html = renderTimeline({ seats, items: [message({ text: "@Johnny @Johnny @Johnny ", mentions: [
      { seatId: "human", start: 0, end: 7 },
      { seatId: "namesake", start: 8, end: 15 },
    ] })] });
    expect(html.match(/class="room-mention(?: is-me)?"/g)).toHaveLength(2);
    expect(html.match(/class="room-mention is-me"/g)).toHaveLength(1);
    expect(renderTimeline({ seats, items: [message({ text: "@Johnny " })] })).not.toContain('class="room-mention');
  });
  it("highlights structured assistant mentions while preserving Markdown", () => {
    const html = renderTimeline({ seats: [agentSeat, humanSeat], items: [message({ kind: "assistant", authorUserId: null,
      text: "@Johnny **请看**", mentions: [{ seatId: "human", start: 0, end: 7 }], taskId: "task-1",
    })] });
    expect(html).toContain('class="room-mention is-me"');
    expect(html).toContain('<strong>请看</strong>');
    expect(html).toContain('data-task-id="task-1"');
  });
  it.each([
    ["", " A &amp; B", "", " A &amp; B"],
    ["&#x1F600; ", " A &#38; B", "😀 ", " A &amp; B"],
    ["\\* ", " A \\* B", "* ", " A * B"],
    ["\\&amp; ", " A \\\\ B", "&amp;amp; ", " A \\ B"],
    ["&NotEqualTilde; ", " &copy;", "≂̸ ", " ©"],
    ["&notAnEntity; ", " A &amp; B", "&amp;notAnEntity; ", " A &amp; B"],
  ])("highlights a source-offset mention through Markdown entities/escapes (%s / %s)", (prefix, suffix, renderedPrefix, renderedSuffix) => {
    const text = `${prefix}@Johnny${suffix}`;
    const html = renderTimeline({ seats: [agentSeat, humanSeat], items: [message({ kind: "assistant", authorUserId: null,
      text, mentions: [{ seatId: "human", start: prefix.length, end: prefix.length + 7 }],
    })] });
    expect(html).toContain(`${renderedPrefix}<span class="room-mention is-me">@Johnny</span>${renderedSuffix}`);
  });
  it("maps only the recorded occurrence after decoded entities and escaped punctuation", () => {
    const text = "&#x1F600; @Johnny \\* @Johnny A &amp; B";
    const start = text.lastIndexOf("@Johnny");
    const html = renderTimeline({ seats: [agentSeat, humanSeat], items: [message({ kind: "assistant", authorUserId: null,
      text, mentions: [{ seatId: "human", start, end: start + 7 }],
    })] });
    expect(html.match(/class="room-mention is-me"/g)).toHaveLength(1);
    expect(html).toContain('😀 @Johnny * <span class="room-mention is-me">@Johnny</span> A &amp; B');
  });
  it("resolves the clicked author by human user ID, never by the addressed Agent", () => {
    expect(resolveRoomMessageAuthorSeat(message(), [agentSeat, humanSeat])).toEqual(humanSeat);
    expect(resolveRoomMessageAuthorSeat(message({ authorUserId: "removed" }), [agentSeat, humanSeat])).toBeNull();
    expect(resolveRoomMessageAuthorSeat(message({ kind: "assistant" }), [agentSeat, humanSeat])).toEqual(agentSeat);
  });
  it("left-clicking an author avatar passes the actual author's seat", () => {
    const renderRow = (RoomMessageRow as React.MemoExoticComponent<
      (props: React.ComponentProps<typeof RoomMessageRow>) => React.ReactElement
    >).type;
    const picked: RoomSeat[] = [];
    const row = renderRow({ item: message(), seat: agentSeat, authorSeat: humanSeat, seats: [agentSeat, humanSeat],
      selected: false, isMe: false, mySeatId: null,
      onOpenMenu: () => {}, onMentionSeat: seat => { picked.push(seat); },
    }) as React.ReactElement<{ children: React.ReactNode }>;
    const avatar = React.Children.toArray(row.props.children).find(child => React.isValidElement(child) && (child.props as { className?: string }).className === "room-msg-avatar") as React.ReactElement<React.HTMLAttributes<HTMLElement>>;
    avatar.props.onClick?.({ button: 0 } as React.MouseEvent<HTMLElement>);
    expect(picked.map(seat => seat.id)).toEqual(["human"]);
  });
  it.each([
    ["me", true],
    ["other-user", false],
  ])("renders user %s addressing an Agent as a human author", (authorUserId, own) => {
    const [row] = messageRows(renderTimeline({ items: [message({ authorUserId })] }));

    expect(rowClasses(row)).toContain("is-human");
    expect(rowClasses(row).includes("is-me")).toBe(own);
    expect(rowClasses(row)).not.toContain("is-agent");
    expect(row).toContain('<circle cx="8" cy="5.5"');
    expect(row).not.toContain('<rect x="2.5"');
    expect(row).toContain('class="room-msg-author">Johnny</span>');
  });

  it.each([agentSeat.id, "removed-agent"])(
    "renders assistant prose on the left even with my authorUserId (seat %s)",
    (seatId) => {
      const [row] = messageRows(renderTimeline({
        items: [message({ kind: "assistant", seatId, authorLabel: "开发员", text: "**已检查**" })],
        selectedSeatId: seatId,
      }));

      expect(rowClasses(row)).toContain("is-agent");
      expect(rowClasses(row)).not.toContain("is-me");
      expect(rowClasses(row)).toContain("focus");
      expect(row).toMatch(/class="[^"]*room-agent-prose/u);
      expect(row).toContain('<rect x="2.5"');
      expect(row).toContain("<strong>已检查</strong>");
    },
  );

  it("keeps a directly rendered assistant row on the left when isMe is true", () => {
    const html = renderToStaticMarkup(React.createElement(RoomMessageRow, {
      item: message({ kind: "assistant" }),
      seat: agentSeat,
      selected: false,
      isMe: true,
      seats: [],
      mySeatId: null,
      onOpenMenu: () => undefined,
    }));

    expect(rowClasses(html)).not.toContain("is-me");
  });

  it("keeps each live Agent's thinking, text and tool in its own turn row", () => {
    const reviewSeat = { ...agentSeat, id: "agent-2", name: "检查员", running: true };
    const rows = messageRows(renderTimeline({
      seats: [{ ...agentSeat, running: true }, reviewSeat],
      liveExec: [
        { turnId: "turn-dev", seatId: agentSeat.id, at: 1, text: "正在调整布局", tool: "Edit", thinking: "检查组件结构" },
        { turnId: "turn-review", seatId: reviewSeat.id, at: 2, text: "", thinking: "核对阅读层级" },
      ],
    }));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('data-seat-id="agent-1"');
    expect(rows[0]).toContain('data-turn-id="turn-dev"');
    expect(rows[0]).toContain('class="room-msg-author">开发员</span>');
    expect(rows[0]).toContain("正在调整布局");
    expect(rows[0]).toContain("Edit");
    expect(rows[0]).toContain("检查组件结构");
    expect(rows[0]).not.toContain("核对阅读层级");
    expect(rows[0]).toMatch(/class="[^"]*room-agent-prose/u);
    expect(rows[1]).toContain('data-seat-id="agent-2"');
    expect(rows[1]).toContain('data-turn-id="turn-review"');
    expect(rows[1]).toContain('class="room-msg-author">检查员</span>');
    expect(rows[1]).toContain("核对阅读层级");
    expect(rows[1]).not.toContain("Edit");
    for (const row of rows) {
      expect(rowClasses(row)).toContain("is-agent");
      expect(rowClasses(row)).not.toContain("room-typing");
      expect(rowClasses(row)).not.toContain("is-me");
    }
  });

  it("does not add typing to a tool-only live row or hide another Agent's typing", () => {
    const rows = messageRows(renderTimeline({
      seats: [
        { ...agentSeat, running: true },
        { ...agentSeat, id: "agent-2", name: "检查员", running: true },
      ],
      liveExec: [{ turnId: "tool-turn", seatId: agentSeat.id, at: 1, text: "", tool: "Read" }],
    }));

    expect(rows).toHaveLength(2);
    const typingRows = rows.filter((row) => rowClasses(row).includes("room-typing"));
    expect(typingRows).toHaveLength(1);
    expect(typingRows[0]).toContain('class="room-msg-author">检查员</span>');
    expect(rows.find((row) => row.includes("Read"))).not.toContain("room-typing");
  });

  it("keeps typing until an empty live entry has visible progress", () => {
    const [row] = messageRows(renderTimeline({
      seats: [{ ...agentSeat, running: true }],
      liveExec: [{ turnId: "empty-turn", seatId: agentSeat.id, at: 1, text: "", tool: "", thinking: "" }],
    }));

    expect(rowClasses(row)).toContain("room-typing");
    expect(rowClasses(row)).toContain("is-agent");
    expect(row).toContain('aria-label="正在工作"');
  });

  it("preserves message quotes and Markdown code and blockquote markup", () => {
    const html = renderTimeline({
      items: [message({
        kind: "assistant",
        text: "`inline`\n\n```ts\nconst value = 1;\n```\n\n> 引用说明",
        quote: { id: "quoted", authorLabel: "小林", text: "原消息" },
      })],
    });

    expect(html).toContain('class="room-msg-quote"');
    expect(html).toContain('class="room-msg-quote-author">小林</span>');
    expect(html).toContain('class="room-msg-quote-text">原消息</span>');
    expect(html).toMatch(/<code class="md-inline-code"[^>]*>inline<\/code>/u);
    expect(html).toMatch(/<pre><code class="language-ts"[^>]*>/u);
    expect(html).toContain("<blockquote>");
  });

  it("hides recalled message content and quotes", () => {
    const html = renderTimeline({
      items: [message({
        recalled: true,
        text: "不可再展示的内容",
        quote: { id: "quoted", authorLabel: "小林", text: "原引用" },
      })],
    });

    expect(html).toContain("此消息已撤回");
    expect(html).not.toContain("不可再展示的内容");
    expect(html).not.toContain("原引用");
  });

  it.each(["user", "assistant"] as const)(
    "preserves the %s context-menu callback and disables it after recall",
    (kind) => {
      // The row has no hooks; inspect the real root handler beneath React.memo.
      const renderRow = (RoomMessageRow as React.MemoExoticComponent<
        (props: React.ComponentProps<typeof RoomMessageRow>) =>
          React.ReactElement<React.HTMLAttributes<HTMLDivElement>>
      >).type;
      const item = message({ kind });
      const opened: unknown[] = [];
      let prevented = false;
      const props: React.ComponentProps<typeof RoomMessageRow> = {
        item,
        seat: agentSeat,
        selected: false,
        isMe: true,
        seats: [],
        mySeatId: null,
        onOpenMenu: (...args) => { opened.push(args); },
      };
      const row = renderRow(props);
      row.props.onContextMenu?.({
        clientX: 30,
        clientY: 60,
        preventDefault: () => { prevented = true; },
      } as React.MouseEvent<HTMLDivElement>);

      expect(prevented).toBe(true);
      expect(opened).toEqual([[item, 30, 60]]);
      expect(renderRow({ ...props, item: { ...item, recalled: true } })
        .props.onContextMenu).toBeUndefined();
    },
  );

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
