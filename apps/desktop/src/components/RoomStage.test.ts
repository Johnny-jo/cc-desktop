import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment, RoomMember, RoomRole, RoomSeat, RoomTask } from "@claude-desktop/shared";

// A small hook runner exercises the real composer handlers in the node test environment.
// Children and the desktop boundary are not mounted; no browser/IPC is required.
const harness = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useEffect: () => {}, useCallback: (fn: unknown) => fn,
    useState: (initial: unknown) => {
      const index = harness.cursor++;
      if (!(index in harness.slots)) harness.slots[index] = typeof initial === "function" ? initial() : initial;
      return [harness.slots[index], (value: unknown) => { harness.slots[index] = typeof value === "function" ? value(harness.slots[index]) : value; }];
    },
    useRef: (initial: unknown) => {
      const index = harness.cursor++;
      if (!(index in harness.slots)) harness.slots[index] = { current: initial };
      return harness.slots[index];
    },
  };
});
const state = vi.hoisted(() => ({
  room: { roomId: "r", status: "open", localUserId: "me", name: "群", memberCount: 1, items: [], modChecksum: "",
    encrypt: true, tasks: [] as RoomTask[],
    members: [{ userId: "me", name: "本人", role: "host" }] as RoomMember[],
    seats: [
      { id: "human", kind: "human", occupantUserId: "me", name: "本人" },
      { id: "agent", kind: "agent", occupantUserId: null, name: "开发" },
    ] as RoomSeat[],
  }, selected: "agent", send: vi.fn(async (..._args: unknown[]) => ({ ok: true })), stop: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
  offline: false, role: "host" as RoomRole,
}));
vi.mock("../state/store", () => ({ useAppStore: () => ({}) }));
vi.mock("../state/room-store", () => ({
  useRoomStore: (select: (s: unknown) => unknown) => select({ activeRoom: state.room, selectedSeatId: state.selected, rooms: [{ roomId: "r", role: state.role, offline: state.offline }] }),
  selectSeat: (id: string) => { state.selected = id; }, sendToSeat: state.send, stopRoomSeat: state.stop,
  askRoomAiShare: vi.fn(), recallRoomMessage: vi.fn(), rejoinRoom: vi.fn(), setRoomAiShare: vi.fn(), controlRoomTask: vi.fn(),
}));
vi.mock("../i18n/useI18n", () => ({ useI18n: () => ({ t: { room: { peopleOnline: "在线 {n}", modBadge: "", memberOffline: "离线" }, common: { cancel: "取消" } } }) }));
vi.mock("react-dom", async original => ({ ...await original<typeof import("react-dom")>(), createPortal: (node: unknown) => node }));
import { RoomStage } from "./RoomStage";
import { RoomTimeline } from "./RoomTimeline";
import { ModPlayPanel } from "./ModPlayPanel";
import { RoomSettingsModal } from "./RoomSettingsModal";
import { RoomInviteModal } from "./RoomInviteModal";

const initialRoom = structuredClone(state.room);
const savedImage: Attachment = { name: "clipboard.png", path: "D:/cache/clipboard.png", size: 3, mimeType: "image/png", kind: "image" };
const fileReaderCreated = vi.fn();
async function readDiskAttachment(path: string): Promise<Attachment> {
  if (!path) throw new Error("没有文件路径");
  return { ...savedImage, path };
}
const desktop = {
  getRoomInvite: vi.fn(async (_roomId: string) => ({ ok: true, secret: "test-invite", port: 18765, listening: true })),
  getPathForFile: vi.fn((_file: File) => ""),
  readAttachment: vi.fn(readDiskAttachment),
  saveClipboardImage: vi.fn(async (_base64: string, _mime: string) => savedImage),
};

function nodes(element: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  return React.Children.toArray(element).flatMap(child => {
    if (!React.isValidElement<Record<string, unknown>>(child)) return [];
    // The collaboration shell is stateless; exercise its real tabs with the Stage's state.
    if (typeof child.type === "function" && child.type.name === "RoomCollaborationSidebar") {
      return nodes((child.type as (props: Record<string, unknown>) => React.ReactNode)(child.props));
    }
    return [child, ...nodes(child.props.children as React.ReactNode)];
  });
}
function render() { harness.cursor = 0; return nodes(RoomStage()); }
function textarea() { return render().find(node => node.type === "textarea")!; }
type InputTarget = { value: string; selectionStart: number; selectionEnd: number };
type InputHandler = ((event: unknown) => void) | undefined;
function dispatchInput(input: ReturnType<typeof textarea>, target: InputTarget, inputType = "insertText", isComposing = false) {
  const event = { target, currentTarget: target, nativeEvent: { inputType, isComposing } };
  // React always dispatches onInput, but gates onChange on a changed DOM value.
  // Both handlers belong to the same render/event, even if onInput updates state.
  (input.props.onInput as InputHandler)?.(event);
  if (target.value !== input.props.value) (input.props.onChange as InputHandler)?.(event);
}
function type(text: string) {
  dispatchInput(textarea(), { value: text, selectionStart: text.length, selectionEnd: text.length });
}
function replaceText(start: number, end: number, inserted: string, inputType = "insertText", isComposing = false) {
  const input = textarea();
  const target = { value: input.props.value as string, selectionStart: start, selectionEnd: end };
  (input.props.onBeforeInput as InputHandler)?.({ currentTarget: target, nativeEvent: { inputType, isComposing } });
  target.value = target.value.slice(0, start) + inserted + target.value.slice(end);
  target.selectionStart = target.selectionEnd = start + inserted.length;
  dispatchInput(input, target, inputType, isComposing);
}
function selectText(start: number, end: number) {
  const input = textarea();
  const target = { value: input.props.value, selectionStart: start, selectionEnd: end,
    focus: vi.fn(), setSelectionRange: vi.fn() };
  (input.props.ref as React.RefObject<HTMLTextAreaElement | null>).current = target as unknown as HTMLTextAreaElement;
  (input.props.onSelect as (event: unknown) => void)({ currentTarget: target });
  return target;
}
function pickAgent() { const button = render().find(node => node.type === "button" && (node.props.className as string)?.includes("slash-item"))!; (button.props.onClick as () => void)(); }
async function send() { const button = render().find(node => node.props["aria-label"] === "发送")!; await (button.props.onClick as () => Promise<void>)(); await Promise.resolve(); }

beforeEach(() => {
  harness.slots = []; harness.cursor = 0; state.selected = "agent";
  state.room = structuredClone(initialRoom); state.offline = false; state.role = "host";
  state.send.mockReset().mockResolvedValue({ ok: true }); state.stop.mockReset().mockResolvedValue({ ok: true });
  desktop.getPathForFile.mockReset().mockReturnValue("");
  desktop.getRoomInvite.mockReset().mockResolvedValue({ ok: true, secret: "test-invite", port: 18765, listening: true });
  desktop.readAttachment.mockReset().mockImplementation(readDiskAttachment);
  desktop.saveClipboardImage.mockReset().mockResolvedValue(savedImage);
  fileReaderCreated.mockClear();
  vi.stubGlobal("window", { innerWidth: 1440, desktop });
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => { cb(); return 0; });
  vi.stubGlobal("FileReader", class {
    constructor() { fileReaderCreated(); }
    result: string | null = null;
    onload?: () => void;
    readAsDataURL(file: File) {
      void file.arrayBuffer().then(buffer => {
        this.result = `data:${file.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload?.();
      });
    }
  });
});

function textContent(element: React.ReactNode): string {
  return React.Children.toArray(element).map(child => React.isValidElement<{ children?: React.ReactNode }>(child)
    ? textContent(child.props.children) : String(child)).join("");
}
function button(label: string) { return render().find(node => node.type === "button" && node.props["aria-label"] === label)!; }
function tab(label: string) { return render().find(node => node.props.role === "tab" && node.props["aria-label"] === label)!; }
function click(node: ReturnType<typeof button>) { expect(node).toBeDefined(); (node.props.onClick as () => void)(); }
function task(id: string, status: RoomTask["status"], initiatorUserId = "me"): RoomTask {
  return { id, seatId: "agent", initiatorUserId, rootTaskId: id, status, text: id, readOnly: true, createdAt: 1,
    ...(status === "awaiting-approval" ? { approvalRequestId: `request-${id}`, approvalKind: "delegation" as const } : {}) };
}

describe("RoomStage collaboration workspace", () => {
  it("does not reopen a dismissed invitation request after settings closes and reopens", async () => {
    const request = deferred<{ ok: boolean; secret: string; port: number; listening: boolean }>();
    desktop.getRoomInvite.mockReturnValueOnce(request.promise);
    click(button("群聊设置"));
    const oldSettings = render().find(node => node.type === RoomSettingsModal)!;
    const inviting = (oldSettings.props.onInvite as () => Promise<unknown>)();
    (oldSettings.props.onClose as () => void)();
    click(button("群聊设置"));
    request.resolve({ ok: true, secret: "stale-invite", port: 18765, listening: true });
    await inviting;
    expect(render().some(node => node.type === RoomInviteModal)).toBe(false);
    expect(render().find(node => node.type === RoomSettingsModal)?.props.suspended).toBe(false);
  });
  it("opens invitation from settings and suspends the settings dialog without discarding its draft", async () => {
    click(button("群聊设置"));
    const settings = () => render().find(node => node.type === RoomSettingsModal)!;
    await (settings().props.onInvite as () => Promise<unknown>)();
    expect(desktop.getRoomInvite).toHaveBeenCalledWith("r");
    expect(settings().props.suspended).toBe(true);
    const invite = render().find(node => node.type === RoomInviteModal)!;
    expect(invite.props.code).toBe("test-invite");
    (invite.props.onClose as () => void)();
    expect(settings().props.suspended).toBe(false);
  });
  it("passes the active room identity explicitly to the timeline across room switches", () => {
    for (const roomId of ["r", "another-room", "r"]) {
      state.room = { ...state.room, roomId };
      const timeline = render().find(node => node.type === RoomTimeline)!;
      expect(timeline.props.roomId).toBe(roomId);
    }
  });
  it("defaults to Tasks with accessible links to Members and Activity panels", () => {
    const tabs = render().filter(node => node.props.role === "tab");
    expect(tabs.map(node => node.props["aria-label"])).toEqual(["任务", "成员", "活动"]);
    expect(tab("任务").props["aria-selected"]).toBe(true);
    for (const label of ["任务", "成员", "活动"]) {
      const control = tab(label);
      const panel = render().find(node => node.props.id === control.props["aria-controls"]);
      expect(panel?.props.role).toBe("tabpanel");
      expect(panel?.props["aria-labelledby"]).toBe(control.props.id);
      expect(panel?.props.hidden).toBe(label !== "任务");
      expect(control.props.tabIndex).toBe(label === "任务" ? 0 : -1);
    }
  });
  it("switches tabs while preserving a single member list and Mod panel", () => {
    state.room.modChecksum = "active-mod";
    for (const label of ["活动", "成员", "任务", "活动"]) {
      click(tab(label));
      expect(tab(label).props["aria-selected"]).toBe(true);
      expect(render().filter(node => node.type === ModPlayPanel)).toHaveLength(1);
      expect(render().filter(node => node.props["aria-label"] === "席位")).toHaveLength(1);
    }
    const activity = render().find(node => node.props.id === tab("活动").props["aria-controls"])!;
    expect(nodes(activity).some(node => node.type === ModPlayPanel)).toBe(true);
  });
  it("supports keyboard arrows, Home and End with roving tab focus", () => {
    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    const preventDefault = vi.fn();
    for (const [key, target] of [["ArrowRight", "成员"], ["End", "活动"], ["ArrowRight", "任务"], ["ArrowLeft", "活动"], ["Home", "任务"]]) {
      const active = render().find(node => node.props.role === "tab" && node.props["aria-selected"])!;
      expect(active).toBeDefined();
      (active.props.onKeyDown as (event: unknown) => void)({ key, preventDefault, currentTarget: { parentElement: { querySelector } } });
      expect(tab(target).props["aria-selected"]).toBe(true);
    }
    expect(focus).toHaveBeenCalledTimes(5);
    expect(preventDefault).toHaveBeenCalledTimes(5);
  });
  it("can collapse and reopen the sidebar without resetting the selected tab", () => {
    click(tab("成员"));
    click(button("收起协作侧栏"));
    const expand = button("展开协作侧栏");
    expect(expand.props["aria-expanded"]).toBe(false);
    expect(render().find(node => node.props.id === expand.props["aria-controls"])?.props.hidden).toBe(true);
    click(expand);
    expect(tab("成员").props["aria-selected"]).toBe(true);
  });
  it("starts collapsed in a narrow window and can still open Tasks", () => {
    window.innerWidth = 680;
    const expand = button("展开协作侧栏");
    expect(expand?.props["aria-expanded"]).toBe(false);
    click(expand);
    expect(tab("任务").props["aria-selected"]).toBe(true);
  });
  it("keeps the header name-only while retaining task counts and an approval cue on the sidebar toggle", () => {
    state.room.seats[1].running = true;
    state.room.tasks = [task("one", "running"), task("two", "running"), task("queue", "queued"),
      task("own", "awaiting-approval"), task("other", "awaiting-approval", "other"), task("done", "completed")];
    const header = render().find(node => node.type === "header")!;
    expect(textContent(header)).toBe("群");
    expect(nodes(header).filter(node => node.type === "button").map(node => node.props["aria-label"])).toEqual(["收起协作侧栏", "群聊设置"]);
    expect(button("收起协作侧栏").props.title).toContain("1 项待我确认");
    expect(textContent(tab("任务"))).toContain("5");
    click(tab("成员"));
    click(button("收起协作侧栏"));
    click(button("展开协作侧栏"));
    expect(tab("任务").props["aria-selected"]).toBe(true);
    expect(render().find(node => node.type === "aside")?.props.hidden).toBe(false);
  });
  it("moves connection details into group settings and retains a truthful empty Activity panel", () => {
    state.offline = true;
    const header = render().find(node => node.type === "header")!;
    expect(textContent(header)).toBe("群");
    expect(nodes(header).find(node => (node.props.className as string)?.includes("room-dot"))).toBeUndefined();
    click(button("群聊设置"));
    const settings = render().find(node => node.type === RoomSettingsModal)!;
    expect(settings.props.offline).toBe(true);
    expect(settings.props.room).toBe(state.room);
    expect(settings.props.onInvite).toBeTypeOf("function");
    click(tab("活动"));
    const panel = render().find(node => node.props.id === tab("活动").props["aria-controls"])!;
    expect(textContent(panel)).toContain("本群暂无活动");
    expect(nodes(panel).filter(node => node.type === "button")).toHaveLength(0);
    expect(render().filter(node => node.type === ModPlayPanel)).toHaveLength(0);
  });
  it("retains real member context usage and seat mention selection", async () => {
    state.room.seats[1].contextUsage = { usedTokens: 16000, limitTokens: 20000, ratio: 0.8 };
    click(tab("成员"));
    const memberPanel = render().find(node => node.props.id === tab("成员").props["aria-controls"])!;
    expect(textContent(memberPanel)).toContain("ctx 80%");
    type("前后");
    selectText(1, 1);
    click(render().find(node => node.props["aria-label"] === "提及 开发")!);
    await send();
    expect(state.send).toHaveBeenCalledWith("前 @开发 后", undefined, "human", [], [{ seatId: "agent", start: 2, end: 5 }]);
  });
  it("distinguishes compressed context awaiting usage from unknown context without inventing zero", () => {
    state.room.seats[1].contextUsage = null;
    click(tab("成员"));
    const contextTags = () => render().filter(node => (node.props.className as string)?.includes("room-seat-tag ctx"));
    expect(contextTags().map(node => textContent(node))).toEqual(["已压缩，待新用量"]);
    expect(contextTags().some(node => textContent(node).includes("0%"))).toBe(false);
    state.room.seats[1].contextUsage = undefined;
    expect(contextTags()).toHaveLength(0);
    state.room.seats[1].contextUsage = { ratio: .2, usedTokens: 4000, limitTokens: 20000 };
    expect(contextTags().map(node => textContent(node))).toEqual(["ctx 20%"]);
  });
});

async function pasteFiles(files: File[]) {
  const input = textarea();
  const target = selectText(0, 3);
  await (input.props.onPaste as (event: unknown) => Promise<void>)({ preventDefault: () => {}, currentTarget: target, clipboardData: { files, getData: () => "" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type SendResult = { ok: boolean; error?: string };
function switchRoom(roomId: string) { state.room = { ...state.room, roomId }; render(); }
function sendingStatus() { return render().find(node => node.props.role === "status" && textContent(node) === "正在发送并等待确认"); }
function preparationStatus() { return render().find(node => node.props.role === "status" && textContent(node) === "正在准备附件…"); }
function composerError() { return textContent(render().find(node => node.props.className === "room-err")); }

describe("RoomStage pending submissions", () => {
  it("announces the network wait separately from preparation while retaining the Send label", async () => {
    const request = deferred<SendResult>();
    state.send.mockReturnValueOnce(request.promise);
    type("请检查");
    await send();
    expect(sendingStatus()?.props["aria-live"]).toBe("polite");
    expect(preparationStatus()).toBeUndefined();
    expect(button("发送").props.title).toBe("发送");
    expect(button("发送").props.disabled).toBe(true);
    request.resolve({ ok: true });
    await request.promise;
    expect(sendingStatus()).toBeUndefined();
  });
  it("permits a new room to send while the previous room still awaits confirmation", async () => {
    const old = deferred<SendResult>();
    state.send.mockReturnValueOnce(old.promise);
    type("A 的消息"); await send();
    switchRoom("b"); type("B 的消息");
    expect(button("发送").props.disabled).toBe(false);
    expect(sendingStatus()).toBeUndefined();
    await send();
    expect(state.send).toHaveBeenCalledTimes(2);
    expect(state.send).toHaveBeenLastCalledWith("B 的消息", undefined, "human", [], []);
    old.resolve({ ok: true }); await old.promise;
  });
  it.each(["success", "failure", "throw"])("ignores an old %s including its finally while a new room is sending", async outcome => {
    const old = deferred<SendResult>();
    const current = deferred<SendResult>();
    state.send.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    type("A 的消息"); await send();
    switchRoom("b"); type("B 的消息"); await send();
    expect(state.send).toHaveBeenCalledTimes(2);
    type("B 的新草稿");
    if (outcome === "throw") old.reject(new Error("旧群聊的网络错误"));
    else old.resolve(outcome === "success" ? { ok: true } : { ok: false, error: "旧群聊的网络错误" });
    await old.promise.catch(() => {});
    expect(textarea().props.value).toBe("B 的新草稿");
    expect(composerError()).toBe("");
    expect(button("发送").props.disabled).toBe(true);
    expect(sendingStatus()).toBeDefined();
    await send();
    expect(state.send).toHaveBeenCalledTimes(2);
    current.resolve({ ok: false, error: "当前群聊的错误" }); await current.promise;
    expect(composerError()).toBe("当前群聊的错误");
    expect(sendingStatus()).toBeUndefined();
    expect(button("发送").props.disabled).toBe(false);
  });
  it("uses a new generation when returning to the same room before the old reply arrives", async () => {
    const old = deferred<SendResult>();
    const current = deferred<SendResult>();
    state.send.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    type("旧消息"); await send();
    switchRoom("b"); switchRoom("r");
    type("重新进入后的消息"); await send();
    expect(state.send).toHaveBeenCalledTimes(2);
    old.resolve({ ok: false, error: "旧代次错误" }); await old.promise;
    expect(composerError()).toBe("");
    expect(button("发送").props.disabled).toBe(true);
    current.resolve({ ok: true }); await current.promise;
    expect(textarea().props.value).toBe("");
  });
  it("preserves edits and a dismissed mention popup when the sent draft is confirmed", async () => {
    const request = deferred<SendResult>();
    state.send.mockReturnValueOnce(request.promise);
    type("@开"); pickAgent(); await send();
    replaceText(4, 4, "新草稿 @");
    (textarea().props.onKeyDown as (event: unknown) => void)({ key: "Escape", nativeEvent: {}, preventDefault: () => {} });
    const edited = textarea().props.value;
    request.resolve({ ok: true }); await request.promise;
    expect(textarea().props.value).toBe(edited);
    expect(render().some(node => node.props.role === "listbox")).toBe(false);
    await send();
    expect(state.send).toHaveBeenLastCalledWith(edited, undefined, "human", [], [{ seatId: "agent", start: 0, end: 3 }]);
  });
  it("retains a new attachment error when a previous message is confirmed", async () => {
    const request = deferred<SendResult>();
    state.send.mockReturnValueOnce(request.promise);
    type("消息"); await send();
    await pasteFiles([new File(["text"], "note.txt", { type: "text/plain" })]);
    expect(textContent(render().find(node => node.props.className === "composer-attachment-error"))).toContain("文件路径");
    request.resolve({ ok: true }); await request.promise;
    expect(textContent(render().find(node => node.props.className === "composer-attachment-error"))).toContain("文件路径");
  });
});

describe("RoomStage clipboard attachments", () => {
  it("waits for a screenshot to finish saving before sending the draft", async () => {
    let finish!: (attachment: Attachment) => void;
    desktop.saveClipboardImage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    type("@开"); pickAgent();
    const saving = pasteFiles([new File(["png"], "image.png", { type: "image/png" })]);
    await vi.waitFor(() => expect(desktop.saveClipboardImage).toHaveBeenCalled());
    expect(preparationStatus()?.props["aria-live"]).toBe("polite");
    expect(sendingStatus()).toBeUndefined();
    expect(button("发送").props.disabled).toBe(true);
    await send();
    expect(state.send).not.toHaveBeenCalled();
    finish(savedImage);
    await saving;
    expect(button("发送").props.disabled).toBe(false);
    await send();
    expect(state.send).toHaveBeenCalledWith("@开发 ", undefined, "human", [savedImage], [{ seatId: "agent", start: 0, end: 3 }]);
  });
  it("does not add an old room's pending screenshot to a newly selected room", async () => {
    let finish!: (attachment: Attachment) => void;
    desktop.saveClipboardImage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const saving = pasteFiles([new File(["png"], "image.png", { type: "image/png" })]);
    await vi.waitFor(() => expect(desktop.saveClipboardImage).toHaveBeenCalled());
    state.room.roomId = "another-room";
    render();
    finish(savedImage);
    await saving;
    expect(render().some(node => node.props["aria-label"] === "移除 clipboard.png")).toBe(false);
  });
  it("saves pathless screenshot bytes through the existing API and keeps mention selection", async () => {
    type("@开"); pickAgent();
    await pasteFiles([new File(["png"], "image.png", { type: "image/png" })]);
    await vi.waitFor(() => expect(render().some(node => node.props["aria-label"] === "移除 clipboard.png")).toBe(true));
    await send();
    expect(desktop.saveClipboardImage).toHaveBeenCalledWith("cG5n", "image/png");
    expect(desktop.readAttachment).not.toHaveBeenCalled();
    expect(state.send).toHaveBeenCalledWith("@开发 ", undefined, "human", [savedImage], [{ seatId: "agent", start: 0, end: 3 }]);
  });
  it("keeps the normal file path flow even for an image pasted from disk", async () => {
    desktop.getPathForFile.mockReturnValue("D:/pictures/local.png");
    await pasteFiles([new File(["png"], "local.png", { type: "image/png" })]);
    await send();
    expect(desktop.readAttachment).toHaveBeenCalledWith("D:/pictures/local.png");
    expect(desktop.saveClipboardImage).not.toHaveBeenCalled();
    expect(state.send).toHaveBeenCalledWith("", undefined, "human", [{ ...savedImage, path: "D:/pictures/local.png" }], []);
  });
  it("reports screenshot save failures without changing the draft or its metadata", async () => {
    desktop.saveClipboardImage.mockRejectedValueOnce(new Error("图片保存失败"));
    type("@开"); pickAgent();
    await pasteFiles([new File(["png"], "image.png", { type: "image/png" })]);
    await vi.waitFor(() => expect(render().some(node => node.props.children === "图片保存失败")).toBe(true));
    await send();
    expect(state.send).toHaveBeenCalledWith("@开发 ", undefined, "human", [], [{ seatId: "agent", start: 0, end: 3 }]);
  });
  it("does not treat a pathless non-image as a screenshot or read an empty path", async () => {
    await pasteFiles([new File(["text"], "note.txt", { type: "text/plain" })]);
    expect(desktop.saveClipboardImage).not.toHaveBeenCalled();
    expect(desktop.readAttachment).not.toHaveBeenCalled();
    expect(textContent(render().find(node => node.props.className === "composer-attachment-error"))).toContain("文件路径");
  });
});

const MiB = 1024 * 1024;
function fileWithSize(name: string, size: number, type: string) {
  // Exercise File metadata limits without allocating an oversized test payload.
  return Object.defineProperty(new File(["bytes"], name, { type }), "size", { value: size });
}
async function dropFiles(files: File[]) {
  const composer = render().find(node => node.props.className === "room-composer")!;
  await (composer.props.onDrop as (event: unknown) => void)({ preventDefault: () => {}, dataTransfer: { files } });
  await Promise.resolve();
}
function attachmentError() { return textContent(render().find(node => node.props.className === "composer-attachment-error")); }
function attachmentCount() { return render().filter(node => node.props.className === "composer-attachment").length; }

describe("RoomStage attachment preflight", () => {
  it.each([5 * MiB + 1, 50 * MiB])("rejects a %s-byte pathless screenshot before constructing FileReader", async size => {
    await pasteFiles([fileWithSize("large.png", size, "image/png")]);
    expect(fileReaderCreated).not.toHaveBeenCalled();
    expect(desktop.saveClipboardImage).not.toHaveBeenCalled();
    expect(attachmentError()).toContain("5 MiB");
    expect(attachmentCount()).toBe(0);
  });
  it.each(["image/svg+xml", "image/bmp", "image/avif"])("rejects unsupported screenshot MIME %s before constructing FileReader", async mime => {
    await pasteFiles([fileWithSize("image", 20, mime)]);
    expect(fileReaderCreated).not.toHaveBeenCalled();
    expect(desktop.saveClipboardImage).not.toHaveBeenCalled();
    expect(attachmentError()).toContain("PNG、JPEG、WebP、GIF");
  });
  it("rejects an empty screenshot before reading its bytes", async () => {
    await pasteFiles([fileWithSize("empty.png", 0, "image/png")]);
    expect(fileReaderCreated).not.toHaveBeenCalled();
    expect(attachmentError()).toContain("图片为空");
  });
  it.each(["image/png", "image/jpeg", "image/webp", "image/gif"])("accepts %s at the 5 MiB clipboard boundary", async mime => {
    await pasteFiles([fileWithSize("image", 5 * MiB, mime)]);
    expect(desktop.saveClipboardImage).toHaveBeenCalledWith("Ynl0ZXM=", mime);
    expect(attachmentCount()).toBe(1);
    expect(attachmentError()).toBe("");
  });
  it.each(["paste", "drop"])("rejects a regular file over 10 MiB before attachment IPC via %s", async source => {
    desktop.getPathForFile.mockReturnValue("D:/files/large.pdf");
    const files = [fileWithSize("large.pdf", 10 * MiB + 1, "application/pdf")];
    await (source === "paste" ? pasteFiles(files) : dropFiles(files));
    expect(desktop.readAttachment).not.toHaveBeenCalled();
    expect(attachmentError()).toContain("10 MiB");
  });
  it.each(["paste", "drop"])("keeps the regular 10 MiB disk file path via %s", async source => {
    desktop.getPathForFile.mockReturnValue("D:/files/image.png");
    const files = [fileWithSize("image.png", 10 * MiB, "image/png")];
    await (source === "paste" ? pasteFiles(files) : dropFiles(files));
    expect(desktop.readAttachment).toHaveBeenCalledWith("D:/files/image.png");
    expect(fileReaderCreated).not.toHaveBeenCalled();
    expect(attachmentCount()).toBe(1);
  });
  it("limits a clipboard batch to five images before reading or saving excess files", async () => {
    await pasteFiles(Array.from({ length: 6 }, (_, i) => fileWithSize(`image-${i}.png`, 20, "image/png")));
    expect(fileReaderCreated).toHaveBeenCalledTimes(5);
    expect(desktop.saveClipboardImage).toHaveBeenCalledTimes(5);
    expect(attachmentCount()).toBe(5);
    expect(attachmentError()).toContain("最多 5 个附件");
  });
  it("includes already attached files in the preparation limit", async () => {
    desktop.getPathForFile.mockImplementation(file => `D:/files/${file.name}`);
    await pasteFiles(Array.from({ length: 4 }, (_, i) => fileWithSize(`old-${i}.txt`, 20, "text/plain")));
    await pasteFiles(Array.from({ length: 3 }, (_, i) => fileWithSize(`new-${i}.txt`, 20, "text/plain")));
    expect(desktop.readAttachment).toHaveBeenCalledTimes(5);
    expect(attachmentCount()).toBe(5);
    expect(attachmentError()).toContain("最多 5 个附件");
  });
  it("reserves pending files so overlapping preparations cannot read a sixth attachment", async () => {
    const ready = deferred<void>();
    desktop.getPathForFile.mockImplementation(file => `D:/files/${file.name}`);
    desktop.readAttachment.mockImplementation(async path => { await ready.promise; return readDiskAttachment(path); });
    const preparing = pasteFiles(Array.from({ length: 5 }, (_, i) => fileWithSize(`file-${i}.txt`, 20, "text/plain")));
    const excess = pasteFiles([fileWithSize("excess.txt", 20, "text/plain")]);
    await Promise.resolve();
    expect(desktop.readAttachment).toHaveBeenCalledTimes(1);
    expect(attachmentError()).toContain("最多 5 个附件");
    ready.resolve(); await Promise.all([preparing, excess]);
    expect(desktop.readAttachment).toHaveBeenCalledTimes(5);
    expect(attachmentCount()).toBe(5);
    expect(attachmentError()).toContain("最多 5 个附件");
  });
});

describe("RoomStage composer handlers", () => {
  const quoted = { id: "quoted", at: 0, kind: "user", seatId: "agent", authorUserId: "me", authorLabel: "本人", text: "@开发 请看" };
  function openMenu() {
    const timeline = render().find(node => node.type === RoomTimeline)!;
    (timeline.props.onOpenMenu as (item: unknown, x: number, y: number) => void)(quoted, 0, 0);
  }
  it("quoting a message does not create an executable mention", async () => {
    type("收到"); openMenu();
    (render().find(node => node.props.role === "menuitem" && node.props.children === "引用")!.props.onClick as () => void)();
    await send();
    expect(state.send).toHaveBeenCalledWith("收到", { id: quoted.id, authorLabel: "本人", text: quoted.text }, "human", [], []);
  });
  it("the explicit mention menu resolves the human author rather than the target Agent", async () => {
    openMenu();
    (render().find(node => node.props.role === "menuitem" && node.props.children === "提及")!.props.onClick as () => void)();
    await send();
    expect(state.send).toHaveBeenCalledWith("@本人 ", undefined, "human", [], [{ seatId: "human", start: 0, end: 3 }]);
  });
  it("does not send typed @ as metadata and sends from my human seat", async () => {
    type("@开发 请看");
    await send();
    expect(state.send).toHaveBeenCalledWith("@开发 请看", undefined, "human", [], []);
  });
  it("candidate selection sends metadata and the untrimmed trailing space", async () => {
    type("@开"); pickAgent();
    await send();
    expect(state.send).toHaveBeenCalledWith("@开发 ", undefined, "human", [], [{ seatId: "agent", start: 0, end: 3 }]);
  });
  it.each(["click", "Tab", "Enter"])("replaces the selected candidate suffix via %s and preserves following text", async action => {
    type("@开X后文");
    const target = selectText(2, 3);
    if (action === "click") pickAgent();
    else (textarea().props.onKeyDown as (event: unknown) => void)({ key: action, nativeEvent: { isComposing: false }, preventDefault: () => {} });
    await send();
    expect(state.send).toHaveBeenCalledWith("@开发 后文", undefined, "human", [], [{ seatId: "agent", start: 0, end: 3 }]);
    expect(target.setSelectionRange).toHaveBeenCalledWith(4, 4);
  });
  it("pasting the same name over a selected mention clears its metadata", async () => {
    type("@开"); pickAgent();
    const input = textarea();
    const paste = input.props.onPaste as ((e: unknown) => void) | undefined;
    expect(paste).toBeTypeOf("function");
    paste!({ preventDefault: () => {}, currentTarget: { selectionStart: 0, selectionEnd: 3 }, clipboardData: { files: [], getData: () => "@开发" } });
    await send();
    expect(state.send).toHaveBeenCalledWith("@开发 ", undefined, "human", [], []);
  });
  it.each([
    [3, 4, " ", "insertText", false],
    [1, 2, "开", "insertCompositionText", true],
    [0, 3, "@开发", "insertReplacementText", false],
  ] as const)("invalidates identical replacement %s..%s through input without a change event", async (start, end, inserted, inputType, isComposing) => {
    type("@开"); pickAgent();
    replaceText(start, end, inserted, inputType, isComposing);
    await send();
    expect(state.send).toHaveBeenCalledWith("@开发 ", undefined, "human", [], []);
  });
  it("handles input plus change once when shifting a mention", async () => {
    type("@开"); pickAgent();
    replaceText(0, 0, "前文 ");
    await send();
    expect(state.send).toHaveBeenCalledWith("前文 @开发 ", undefined, "human", [], [{ seatId: "agent", start: 3, end: 6 }]);
  });
  it("does not resurrect a mention after removing and retyping its trailing space via input", async () => {
    type("@开"); pickAgent();
    replaceText(3, 4, "", "deleteContentBackward");
    replaceText(3, 3, " ");
    await send();
    expect(state.send).toHaveBeenCalledWith("@开发 ", undefined, "human", [], []);
  });
  it("does not choose a candidate or send on an IME Enter, or mark unselected Chinese input", async () => {
    type("@开");
    const preventDefault = vi.fn();
    (textarea().props.onKeyDown as (event: unknown) => void)({ key: "Enter", nativeEvent: { isComposing: true }, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
    expect(textarea().props.value).toBe("@开");
    replaceText(1, 2, "开发", "insertCompositionText", true);
    replaceText(3, 3, " ");
    await send();
    expect(state.send).toHaveBeenCalledWith("@开发 ", undefined, "human", [], []);
  });
  it("preserves a chosen mention during IME edits to the following body", async () => {
    type("@开"); pickAgent();
    replaceText(4, 4, "ni", "insertCompositionText", true);
    replaceText(4, 6, "你", "insertCompositionText", true);
    replaceText(4, 5, "你", "insertCompositionText", false);
    await send();
    expect(state.send).toHaveBeenCalledWith("@开发 你", undefined, "human", [], [{ seatId: "agent", start: 0, end: 3 }]);
  });
  it("uses a human mention without masking the selected Agent for /stop", async () => {
    type("@本"); pickAgent();
    type("@本人 /stop");
    await send();
    expect(state.stop).toHaveBeenCalledWith("agent");
    expect(state.send).not.toHaveBeenCalled();
  });
  it("shifts the chosen mark using the pre-edit caret range when inserting body text", async () => {
    type("@开"); pickAgent();
    (textarea().props.onBeforeInput as (event: unknown) => void)({ currentTarget: { selectionStart: 0, selectionEnd: 0 }, nativeEvent: { inputType: "insertText" } });
    type("请看 @开发 ");
    await send();
    expect(state.send).toHaveBeenCalledWith("请看 @开发 ", undefined, "human", [], [{ seatId: "agent", start: 3, end: 6 }]);
  });
  it("mentioning a human avatar keeps the selected Agent available to /stop", async () => {
    const timeline = render().find(node => node.type === RoomTimeline)!;
    (timeline.props.onMentionSeat as (seat: unknown) => void)(state.room.seats[0]);
    type("@本人 /stop");
    await send();
    expect(state.stop).toHaveBeenCalledWith("agent");
  });
});
