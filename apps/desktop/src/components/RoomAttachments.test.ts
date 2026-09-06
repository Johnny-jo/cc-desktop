import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomAttachmentRef } from "@claude-desktop/shared";
import { RoomAttachments } from "./RoomAttachments";

type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
type HookRun = {
  slots: unknown[]; effects: Map<number, Effect>; cursor: number; writes: number; dirty: boolean;
  pending: Array<() => void>;
};
// Match the repository's Node hook runner, retaining real React for static renders.
// Only hooks and the preload boundary need adapters; assertions inspect real UI/handlers.
const harness = vi.hoisted(() => ({ current: null as HookRun | null }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  function effect(setup: () => void | (() => void), deps?: readonly unknown[]) {
    const run = harness.current!;
    const index = run.cursor++;
    const previous = run.effects.get(index);
    if (previous?.deps && deps && previous.deps.length === deps.length && deps.every((v, i) => Object.is(v, previous.deps![i]))) return;
    run.pending.push(() => {
      previous?.cleanup?.();
      run.effects.set(index, { deps, cleanup: setup() || undefined });
    });
  }
  return {
    ...actual,
    useState: (initial: unknown) => {
      const run = harness.current;
      if (!run) return actual.useState(initial);
      const index = run.cursor++;
      if (!(index in run.slots)) run.slots[index] = typeof initial === "function" ? initial() : initial;
      return [run.slots[index], (value: unknown) => {
        const next = typeof value === "function" ? value(run.slots[index]) : value;
        run.writes++;
        if (!Object.is(next, run.slots[index])) { run.slots[index] = next; run.dirty = true; }
      }];
    },
    useRef: (initial: unknown) => {
      const run = harness.current;
      if (!run) return actual.useRef(initial);
      const index = run.cursor++;
      if (!(index in run.slots)) run.slots[index] = { current: initial };
      return run.slots[index];
    },
    useLayoutEffect: (setup: () => void | (() => void), deps?: readonly unknown[]) => harness.current ? effect(setup, deps) : actual.useLayoutEffect(setup, deps),
    useEffect: (setup: () => void | (() => void), deps?: readonly unknown[]) => harness.current ? effect(setup, deps) : actual.useEffect(setup, deps),
  };
});

type Result = { ok: boolean; error?: string; dataUrl?: string; saved?: boolean; cancelled?: boolean };
type Request = [roomId: string, itemId: string, attachmentId: string, action: "preview" | "save"];
const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=";
const attachment: RoomAttachmentRef = {
  id: "9e2cd485-2b96-4cde-a4b3-6efe1d03c96c", name: "@Johnny 设计稿.png",
  size: Buffer.from(imageUrl.split(",")[1], "base64").length, mimeType: "image/png", kind: "image", sha256: "a".repeat(64),
};
const defaultProps = { roomId: "room-1", itemId: "message-1", attachments: [attachment] };
type Props = React.ComponentProps<typeof RoomAttachments>;
type Element = React.ReactElement<Record<string, unknown>>;
function nodes(element: React.ReactNode): Element[] {
  return React.Children.toArray(element).flatMap(child => React.isValidElement<Record<string, unknown>>(child)
    ? [child, ...nodes(child.props.children as React.ReactNode)] : []);
}
const mounted: Array<() => void> = [];
function mount(initial: Props = defaultProps) {
  const run: HookRun = { slots: [], effects: new Map(), cursor: 0, writes: 0, dirty: false, pending: [] };
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  let props = initial;
  let tree: React.ReactNode;
  function render(next = props) {
    props = next;
    let attempts = 0;
    do {
      run.cursor = 0; run.dirty = false; run.pending = []; harness.current = run;
      try { tree = RoomAttachments(props); } finally { harness.current = null; }
      for (const node of nodes(tree)) {
        if (node.type === "dialog" && node.props.ref) (node.props.ref as React.RefObject<unknown>).current = dialog;
      }
      for (const flush of run.pending) flush();
      if (++attempts > 10) throw new Error("Attachment render did not settle");
    } while (run.dirty);
    return tree;
  }
  function unmount() { for (const value of run.effects.values()) value.cleanup?.(); run.effects.clear(); }
  mounted.push(unmount);
  render();
  return {
    render, unmount, run,
    html: () => renderToStaticMarkup(render()),
    nodes: () => nodes(render()),
    click: (label: string) => {
      const button = nodes(render()).find(node => node.type === "button" && node.props["aria-label"] === label);
      expect(button, `button ${label}`).toBeDefined();
      expect(button!.props.disabled).not.toBe(true);
      return Promise.resolve((button!.props.onClick as ((event: unknown) => unknown) | undefined)?.({ currentTarget: undefined }));
    },
  };
}
function deferred() {
  let resolve!: (result: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let calls: Request[];
let respond: (...args: Request) => Promise<Result>;
beforeEach(() => {
  calls = [];
  respond = async () => ({ ok: true, saved: true });
  vi.stubGlobal("window", { desktop: { roomAttachment: (...args: Request) => { calls.push(args); return respond(...args); } } });
});
afterEach(() => { for (const unmount of mounted.splice(0)) unmount(); vi.unstubAllGlobals(); });

describe("RoomAttachments metadata", () => {
  it("renders escaped names, actual sizes and MIME types without fetching bytes", () => {
    const html = renderToStaticMarkup(React.createElement(RoomAttachments, { ...defaultProps,
      attachments: [{ ...attachment, name: '<img src=x> @Johnny.png', size: 1536 }],
    }));
    expect(html).toContain("&lt;img src=x&gt; @Johnny.png");
    expect(html).toContain("1.5 KiB");
    expect(html).toContain("1536 B");
    expect(html).toContain("image/png");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data:");
    expect(html).not.toContain("room-mention");
    expect(html).not.toContain(attachment.sha256);
    expect(calls).toEqual([]);
  });
  it.each([[0, "0 B"], [1023, "1023 B"], [1024, "1 KiB"], [5242880, "5 MiB"]])("formats %s bytes", (size, label) => {
    const html = renderToStaticMarkup(React.createElement(RoomAttachments, { ...defaultProps, attachments: [{ ...attachment, size }] }));
    expect(html).toContain(label);
    expect(html).toContain(`${size} B`);
  });
  it("renders nothing for an empty list", () => {
    expect(renderToStaticMarkup(React.createElement(RoomAttachments, { ...defaultProps, attachments: [] }))).toBe("");
  });
  it.each(["image/png", "image/jpeg", "image/webp", "image/gif"])("offers explicit preview for %s at exactly 5 MiB", mimeType => {
    const view = mount({ ...defaultProps, attachments: [{ ...attachment, mimeType, size: 5 * 1024 * 1024 }] });
    expect(view.nodes().filter(node => node.type === "button").map(node => node.props["aria-label"])).toEqual([
      `预览 ${attachment.name}`, `保存 ${attachment.name}`,
    ]);
    expect(calls).toEqual([]);
  });
  it.each([
    { mimeType: "image/svg+xml" }, { mimeType: "text/html" }, { mimeType: "image/avif" },
    { mimeType: "application/octet-stream", kind: "binary" as const }, { kind: "text" as const },
    { size: 5 * 1024 * 1024 + 1 },
  ])("offers only Save for unsupported metadata %j", change => {
    const view = mount({ ...defaultProps, attachments: [{ ...attachment, ...change }] });
    expect(view.nodes().filter(node => node.type === "button").map(node => node.props["aria-label"])).toEqual([`保存 ${attachment.name}`]);
  });
  it("disables actions when there is no originating room", () => {
    const view = mount({ ...defaultProps, roomId: "" });
    expect(view.nodes().filter(node => node.type === "button").every(node => node.props.disabled)).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("RoomAttachments actions", () => {
  it("downloads only on Preview and shows an indeterminate state until verified bytes arrive", async () => {
    const pending = deferred(); respond = () => pending.promise;
    const view = mount();
    expect(calls).toEqual([]);
    const action = view.click(`预览 ${attachment.name}`);
    expect(view.html()).toContain("正在下载并校验");
    expect(view.html()).toContain('role="status"');
    expect(view.html()).not.toMatch(/\d+%|Agent 可读|AI 已读|<img/);
    expect(view.nodes().filter(node => node.type === "button").every(node => node.props.disabled)).toBe(true);
    expect(calls).toEqual([["room-1", "message-1", attachment.id, "preview"]]);
    pending.resolve({ ok: true, dataUrl: imageUrl }); await action;
    expect(view.html()).not.toContain("正在下载并校验");
    expect(view.html()).toContain(`src="${imageUrl}"`);
    expect(view.html()).toContain(`alt="${attachment.name}"`);
    expect(view.html()).not.toContain("已保存");
  });
  it("saves through the exact room/item/attachment API and reports only confirmed saves", async () => {
    const pending = deferred(); respond = () => pending.promise;
    const view = mount();
    const action = view.click(`保存 ${attachment.name}`);
    expect(view.html()).toContain("正在下载并校验");
    expect(view.html()).not.toContain("已保存");
    pending.resolve({ ok: true, saved: true }); await action;
    expect(calls).toEqual([["room-1", "message-1", attachment.id, "save"]]);
    expect(view.html()).toContain("已保存");
    expect(view.html()).not.toContain("<img");
  });
  it.each([{ ok: true }, { ok: true, saved: false }, { ok: false, saved: true }])("does not call an unconfirmed Save successful (%j)", async result => {
    respond = async () => result;
    const view = mount(); await view.click(`保存 ${attachment.name}`);
    expect(view.html()).not.toContain("已保存");
    expect(view.html()).toContain('role="alert"');
    expect(view.html()).toContain(`aria-label="重试保存 ${attachment.name}"`);
  });
  it.each([true, false])("keeps cancellation quiet, including ok=%s", async ok => {
    respond = async () => ({ ok, cancelled: true, saved: true, error: "cancelled" });
    const view = mount(); await view.click(`保存 ${attachment.name}`);
    expect(calls).toEqual([["room-1", "message-1", attachment.id, "save"]]);
    expect(view.html()).not.toMatch(/已保存|正在下载|重试|role="alert"|cancelled/);
  });
  it("shows a failure inline and retries the same user action", async () => {
    respond = async () => ({ ok: false, error: "校验失败" });
    const view = mount(); await view.click(`预览 ${attachment.name}`);
    expect(view.html()).toContain("校验失败");
    expect(view.html()).toContain('role="alert"');
    const pending = deferred(); respond = () => pending.promise;
    const retry = view.click(`重试预览 ${attachment.name}`);
    expect(view.html()).not.toContain("校验失败");
    expect(view.html()).toContain("正在下载并校验");
    pending.resolve({ ok: true, dataUrl: imageUrl }); await retry;
    expect(view.html()).toContain(`src="${imageUrl}"`);
    expect(calls.map(call => call[3])).toEqual(["preview", "preview"]);
  });
  it("handles rejected requests and stale preloads as retryable inline errors", async () => {
    respond = async () => { throw new Error("连接中断"); };
    const view = mount(); await view.click(`保存 ${attachment.name}`);
    expect(view.html()).toContain("连接中断");
    expect(view.html()).not.toContain("已保存");
    vi.stubGlobal("window", { desktop: {} });
    await view.click(`重试保存 ${attachment.name}`);
    expect(view.html()).toContain("重启应用");
  });
  it("keeps parallel attachment operations independent", async () => {
    const second = { ...attachment, id: "second", name: "说明.txt", kind: "text" as const, mimeType: "text/plain" };
    const pending = deferred(); respond = async (...args) => args[2] === attachment.id ? pending.promise : { ok: true, saved: true };
    const view = mount({ ...defaultProps, attachments: [attachment, second] });
    const preview = view.click(`预览 ${attachment.name}`);
    await view.click(`保存 ${second.name}`);
    expect(view.html()).toContain("已保存");
    expect(view.html()).toContain("正在下载并校验");
    pending.resolve({ ok: false, error: "图片校验失败" }); await preview;
    expect(view.html()).toContain("图片校验失败");
    expect(view.html()).toContain("已保存");
  });
});

describe("RoomAttachments previews and lifetime", () => {
  it.each(["button", "Escape", "cancel"])("closes the accessible modal using %s", async method => {
    respond = async () => ({ ok: true, dataUrl: imageUrl });
    const view = mount(); await view.click(`预览 ${attachment.name}`);
    const dialog = view.nodes().find(node => node.type === "dialog")!;
    expect(dialog).toBeDefined();
    expect(dialog.props["aria-modal"]).toBe("true");
    expect(dialog.props["aria-label"]).toBe(`预览 ${attachment.name}`);
    expect(view.nodes().find(node => node.props["aria-label"] === "关闭预览")?.props.autoFocus).toBe(true);
    if (method === "button") await view.click("关闭预览");
    else {
      const event = { key: "Escape", preventDefault() {}, stopPropagation() {} };
      (dialog.props[method === "Escape" ? "onKeyDown" : "onCancel"] as (event: unknown) => void)(event);
    }
    expect(view.html()).not.toContain("<dialog");
    expect(view.html()).not.toContain(imageUrl);
  });
  it.each([
    undefined, "https://example.com/secret.png", "file:///secret.png", "blob:unsafe", "data:text/html;base64,YQ==",
    "data:image/svg+xml;base64,YQ==", "data:image/jpeg;base64,YQ==", "data:image/png;base64,not-base64!",
    "data:image/png;base64,YQ==", // size disagrees with the attachment reference
  ])("rejects an unsafe or mismatched preview response (%s)", async dataUrl => {
    respond = async () => ({ ok: true, dataUrl });
    const view = mount(); await view.click(`预览 ${attachment.name}`);
    expect(view.html()).not.toContain("<img");
    expect(view.html()).not.toContain("<dialog");
    expect(view.html()).toContain('role="alert"');
  });
  it("rejects actual preview bytes larger than 5 MiB even with a small reference", async () => {
    respond = async () => ({ ok: true, dataUrl: `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64")}` });
    const view = mount(); await view.click(`预览 ${attachment.name}`);
    expect(view.html()).not.toContain("<img");
    expect(view.html()).toContain('role="alert"');
  });
  it("turns an image decode failure into an inline retry and removes the preview", async () => {
    respond = async () => ({ ok: true, dataUrl: imageUrl });
    const view = mount(); await view.click(`预览 ${attachment.name}`);
    const image = view.nodes().find(node => node.type === "img");
    expect(image).toBeDefined();
    (image!.props.onError as () => void)();
    expect(view.html()).not.toContain("<dialog");
    expect(view.html()).toContain(`aria-label="重试预览 ${attachment.name}"`);
  });
  it.each(["preview", "save"] as const)("ignores pending %s completion after unmount", async action => {
    const pending = deferred(); respond = () => pending.promise;
    const view = mount(); const request = view.click(`${action === "preview" ? "预览" : "保存"} ${attachment.name}`);
    expect(view.html()).toContain("正在下载并校验");
    view.unmount(); const writes = view.run.writes;
    pending.resolve({ ok: true, dataUrl: imageUrl, saved: true }); await request;
    expect(view.run.writes).toBe(writes);
  });
  it.each([
    { roomId: "room-2" }, { itemId: "message-2" }, { attachments: [] },
    { attachments: [{ ...attachment, sha256: "b".repeat(64) }] },
  ])("ignores pending results when the room, item or references change (%j)", async change => {
    for (const action of ["preview", "save"] as const) {
      const pending = deferred(); respond = () => pending.promise;
      const view = mount(); const request = view.click(`${action === "preview" ? "预览" : "保存"} ${attachment.name}`);
      expect(view.html()).toContain("正在下载并校验");
      view.render({ ...defaultProps, ...change });
      pending.resolve({ ok: true, dataUrl: imageUrl, saved: true }); await request;
      expect(view.html()).not.toMatch(/已保存|正在下载|<img|<dialog/);
      view.unmount();
    }
  });
  it("does not revive an old image when switching away and back to the same room/item", async () => {
    const pending = deferred(); respond = () => pending.promise;
    const view = mount(); const request = view.click(`预览 ${attachment.name}`);
    view.render({ ...defaultProps, roomId: "room-2" }); view.render(defaultProps);
    pending.resolve({ ok: true, dataUrl: imageUrl }); await request;
    expect(view.html()).not.toContain("<img");
    respond = async () => ({ ok: true, dataUrl: imageUrl });
    await view.click(`预览 ${attachment.name}`);
    expect(view.html()).toContain("<img");
    view.render({ ...defaultProps, itemId: "message-2" }); view.render(defaultProps);
    expect(view.html()).not.toContain("<img");
  });
});
