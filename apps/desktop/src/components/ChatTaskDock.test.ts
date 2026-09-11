import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatItem, SessionProgress, TaskPlan } from "@claude-desktop/shared";

type DockProps = { sessionId: string; progress?: SessionProgress; taskPlan?: TaskPlan; onSetPlanClosed?: (closed: boolean) => Promise<void> };
declare global {
  interface Window {
    dockFixture: {
      render: (props: DockProps, locale?: "en" | "zh") => void;
      renderMany: (props: DockProps[]) => void;
      reset: () => void;
      mountScroll: () => void;
      mountHistory: () => void;
      renderTurn: (items: ChatItem[]) => void;
      errors: string[];
    };
    scrollFixture?: { panel: HTMLElement; list: HTMLElement; body: HTMLElement; spacer: HTMLElement; composer: HTMLElement; controller: ReturnType<typeof import("../lib/chat-scroll-controller")["createChatScrollController"]> };
  }
}

const componentDir = dirname(fileURLToPath(import.meta.url));
const componentPath = join(componentDir, "ChatTaskDock.tsx");
const cssPath = join(componentDir, "ChatTaskDock.css");
const require = createRequire(import.meta.url);
// Reuse Vite's installed bundler and Electron's real DOM; no React/hook mocks or new dependencies.
const { build } = createRequire(require.resolve("vite"))("esbuild");
let electron: ChildProcessWithoutNullStreams | undefined;
let scratch: string | undefined;
let requestPath: string;
let boot: Promise<void> | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function request<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const deadline = setTimeout(() => { pending.delete(id); reject(new Error(`Electron request ${id} timed out`)); }, 3000);
    pending.set(id, { resolve: value => { clearTimeout(deadline); resolve(value as T); }, reject: error => { clearTimeout(deadline); reject(error); } });
    writeFileSync(requestPath, JSON.stringify({ ...message, id }), "utf8");
  });
}

async function startBrowser(): Promise<void> {
  expect(existsSync(componentPath), "Task 3 must provide ChatTaskDock.tsx").toBe(true);
  if (boot) return boot;
  boot = (async () => {
    const bundled = await build({
      stdin: {
        resolveDir: componentDir,
        loader: "tsx",
        contents: `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { flushSync } from "react-dom";
          import { ChatTaskDock } from "./ChatTaskDock";
          import { MessageList } from "./MessageList";
          import { useAppStore, __resetStoreForTests, __upsertSessionForTests, __applySessionEventForTests } from "../state/store";
          import { createChatScrollController } from "../lib/chat-scroll-controller";
          import "./ChatProgressLayout.css";
          const host = document.getElementById("root");
          let root = createRoot(host);
          const errors = [];
          console.error = (...args) => errors.push(args.map(String).join(" "));
          window.dockFixture = {
            errors,
            renderTurn(items) {
              flushSync(() => root.render(<div className="chat-panel"><MessageList items={items} sessionId="outcome" running={false} /></div>));
            },
            mountHistory() {
              __resetStoreForTests();
              __upsertSessionForTests({ id: "history", title: "History", cwd: "D:/project", updatedAt: 1, status: "running" });
              const items = [
                { kind: "tool", id: "hidden-tool", tool: { id: "hidden-tool", name: "Read", summary: "Previous work", status: "done" } },
                ...Array.from({ length: 16 }, (_, index) => ({ kind: "text", id: "user-" + index, role: "user", text: "History message " + index }))
              ];
              __applySessionEventForTests({ type: "items_replaced", sessionId: "history", items });
              window.desktop = { loadOlderMessages: async () => ({ items: Array.from({ length: 8 }, (_, index) => ({ kind: "tool", id: "older-" + index, tool: { id: "older-" + index, name: "Read", summary: "Earlier tool " + index, status: "done" } })), hasMore: false }) };
              function History() {
                const items = useAppStore(state => state.itemsBySession.history || []);
                return <div className="chat-panel" style={{ height: "520px" }}><MessageList items={items} sessionId="history" hasMore={items[0]?.id === "hidden-tool"} /></div>;
              }
              document.getElementById("root").closest("main").style.cssText = "position:fixed;top:0;left:1rem;right:1rem;height:520px";
              flushSync(() => root.render(<History />));
            },
            render(props, locale = "en") {
              Object.defineProperty(navigator, "language", { configurable: true, value: locale });
              flushSync(() => root.render(React.createElement(ChatTaskDock, props)));
            },
            renderMany(props) {
              flushSync(() => root.render(props.map((entry, key) => React.createElement(ChatTaskDock, { ...entry, key }))));
            },
            reset() {
              window.scrollFixture?.controller.dispose();
              window.scrollFixture?.panel.remove();
              delete window.scrollFixture;
              const main = document.getElementById("root").closest("main");
              main.style.cssText = "position:fixed;top:70%;left:1rem;right:1rem";
              document.body.appendChild(main);
              document.querySelectorAll(".dock-clip-fixture").forEach(node => node.remove());
              flushSync(() => root.unmount());
              root = createRoot(host);
              errors.length = 0;
              document.documentElement.dataset.theme = "dark";
              document.documentElement.style.fontSize = "16px";
              document.getElementById("outside").value = "";
            },
            mountScroll() {
              const panel = document.createElement("div");
              panel.className = "chat-panel";
              panel.style.cssText = "position:fixed;inset:0;height:100%;--composer-h:200px;background:var(--bg)";
              panel.innerHTML = '<div class="chat-body"><div class="chat-inner"><div class="message-list-shell"><div class="message-list main-chat-message-list"><div class="message-list-content"><div style="height:480px;position:relative;flex:none"><div data-current-turn-status style="position:absolute;top:440px">Processing</div></div></div><div class="turn-scroll-spacer"></div></div></div></div></div><div class="chat-composer" style="height:200px"></div>';
              document.body.appendChild(panel);
              const list = panel.querySelector(".message-list");
              const content = panel.querySelector(".message-list-content");
              const spacer = panel.querySelector(".turn-scroll-spacer");
              const controller = createChatScrollController(list, content, spacer);
              window.scrollFixture = { panel, list, body: content.firstElementChild, spacer, composer: panel.querySelector(".chat-composer"), controller };
              controller.update({ sessionId: "s", userId: "u", running: true, hasNewer: false });
            }
          };
        `,
      },
      bundle: true,
      write: false,
      outfile: "dock-fixture.js",
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
      logLevel: "silent",
    });
    const js = bundled.outputFiles.find((file: { path: string }) => file.path.endsWith(".js")).text;
    const css = bundled.outputFiles.find((file: { path: string }) => file.path.endsWith(".css"))?.text ?? "";
    const theme = readFileSync(join(componentDir, "../styles.css"), "utf8");
    scratch = mkdtempSync(join(tmpdir(), "chat-task-dock-test-"));
    requestPath = join(scratch, "request.json");
    const bootstrap = join(scratch, "main.cjs");
    writeFileSync(bootstrap, `
      const { app, BrowserWindow } = require("electron");
      const { readFileSync, writeFileSync } = require("node:fs");
      app.setPath("userData", ${JSON.stringify(join(scratch, "profile"))});
      app.disableHardwareAcceleration();
      const send = data => process.stdout.write("DOCK:" + JSON.stringify(data) + "\\n");
      app.whenReady().then(async () => {
        const win = new BrowserWindow({ show: false, width: 800, height: 640,
          webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
        await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(${JSON.stringify(`
          <!doctype html><html data-theme="dark"><head><style>${theme}\n${css}</style></head>
          <body><main style="position:fixed;top:70%;left:1rem;right:1rem">
          <div id="root"></div><textarea id="outside" aria-label="Message"></textarea></main></body></html>
        `)}));
        await win.webContents.executeJavaScript(${JSON.stringify(js)});
        let lastId = -1;
        setInterval(async () => {
          let message;
          try { message = JSON.parse(readFileSync(${JSON.stringify(requestPath)}, "utf8")); } catch { return; }
          if (message.id === lastId) return;
          lastId = message.id;
          try {
            if (message.close) { win.destroy(); app.quit(); return; }
            if (message.resize) {
              win.setContentSize(...message.resize);
              await new Promise(resolve => setTimeout(resolve, 40));
            }
            if (message.capture) {
              const screenshot = await win.webContents.capturePage();
              writeFileSync(${JSON.stringify(join(componentDir, "../../../../.superpowers/sdd/main-chat-tasklist.png"))}, screenshot.toPNG());
            }
            const value = message.script ? await win.webContents.executeJavaScript(message.script, true) : null;
            send({ id: message.id, value: value ?? null });
          } catch (error) { send({ id: message.id, error: String(error.stack || error) }); }
        }, 15);
        send({ id: 0 });
      }).catch(error => { send({ id: 0, error: String(error.stack || error) }); app.exit(1); });
    `, "utf8");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let stderr = "";
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Electron fixture startup timed out: ${stderr}`)), 5000);
      pending.set(0, { resolve: () => { clearTimeout(deadline); resolve(); }, reject: error => { clearTimeout(deadline); reject(error); } });
      electron = spawn(require("electron") as string, [bootstrap], { env, windowsHide: true, stdio: "pipe" });
      electron.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-4000); });
      electron.on("error", reject);
      electron.on("exit", code => {
        for (const waiter of pending.values()) waiter.reject(new Error(`Electron exited (${code}): ${stderr}`));
        pending.clear();
      });
      createInterface({ input: electron.stdout }).on("line", line => {
        if (!line.startsWith("DOCK:")) return;
        const reply = JSON.parse(line.slice(5));
        const waiter = pending.get(reply.id);
        if (!waiter) return;
        pending.delete(reply.id);
        if (reply.error) waiter.reject(new Error(reply.error));
        else waiter.resolve(reply.value);
      });
    });
  })();
  return boot;
}

async function evaluate<T, A = undefined>(fn: (argument: A) => T | Promise<T>, argument?: A): Promise<T> {
  await startBrowser();
  return request<T>({ script: `(${fn.toString()})(${JSON.stringify(argument) ?? "undefined"})` });
}

async function render(progress?: SessionProgress, sessionId = "session-a", locale: "en" | "zh" = "en") {
  await evaluate(({ props, locale }) => window.dockFixture.render(props, locale), { props: { sessionId, progress }, locale });
}

async function click(label: "TaskList" | "SubAgent") {
  await evaluate(label => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find(node => node.textContent?.includes(label))!;
    button.focus();
    button.click();
  }, label);
}

async function visible() {
  return evaluate(() => ({
    text: document.getElementById("root")!.textContent,
    buttons: Array.from(document.querySelectorAll<HTMLButtonElement>(".chat-task-dock-trigger")).map(button => ({
      text: button.textContent, title: button.title, label: button.getAttribute("aria-label"),
      expanded: button.getAttribute("aria-expanded"), controls: button.getAttribute("aria-controls"),
    })),
    panels: document.querySelectorAll('[role="region"]').length,
    focus: document.activeElement?.textContent,
    errors: [...window.dockFixture.errors],
  }));
}

const tasks: SessionProgress["tasks"] = Array.from({ length: 10 }, (_, index) => ({
  id: String(index), title: `Task ${index}`, status: index < 3 ? "completed" : index === 3 ? "in_progress" : "pending",
}));
const agents: SessionProgress["agents"] = [
  { id: "run", title: "Running worker", status: "running", background: true, elapsedSeconds: 65 },
  { id: "run-2", title: "Another worker", status: "running" },
  { id: "done", title: "Completed worker", status: "completed", summary: "Verified the result" },
  { id: "fail", title: "Failed worker", status: "failed" },
  { id: "stop", title: "Stopped worker", status: "stopped" },
  { id: "pause", title: "Paused worker", status: "paused" },
  { id: "unknown", title: "Restored worker", status: "unknown" },
];

beforeEach(async () => {
  await startBrowser();
  await request({ resize: [800, 640] });
  await evaluate(() => window.dockFixture.reset());
}, 30000);

afterAll(async () => {
  if (electron && electron.exitCode === null) {
    const exited = new Promise<void>(resolve => electron!.once("exit", () => resolve()));
    writeFileSync(requestPath, JSON.stringify({ close: true }), "utf8");
    await Promise.race([exited, new Promise<void>(resolve => setTimeout(() => { electron?.kill(); resolve(); }, 1500))]);
  }
  // Only remove this suite's generated fixture/profile directory, never workspace files.
  if (scratch && dirname(scratch) === tmpdir() && scratch.startsWith(join(tmpdir(), "chat-task-dock-test-"))) {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}, 10000);

describe("ChatTaskDock real React/DOM rendering", () => {
  it("renders nothing without progress or with an empty snapshot", async () => {
    for (const progress of [undefined, { tasks: [], agents: [] }]) {
      await render(progress);
      expect((await visible()).text).toBe("");
      expect((await visible()).buttons).toHaveLength(0);
    }
  });

  it("renders only the task entry, initially closed, with the real 3/10 count and accessible attributes", async () => {
    await render({ tasks, agents: [] });
    const state = await visible();
    expect(state.buttons).toHaveLength(1);
    expect(state.buttons[0]).toMatchObject({ text: "TaskList3/10 · In progress", expanded: "false" });
    expect(state.buttons[0].title).toBeTruthy();
    expect(state.buttons[0].label).toContain("3/10");
    expect(state.buttons[0].controls).toBeTruthy();
    expect(state.panels).toBe(0);
  });

  it("counts only actual running/completed agents and flags failure, stopped, paused and unknown records", async () => {
    await render({ tasks: [], agents });
    const state = await visible();
    expect(state.buttons).toHaveLength(1);
    expect(state.buttons[0].text).toContain("SubAgent");
    for (const label of ["3/7 ended", "1 failed", "1 stopped", "1 paused", "1 unknown"]) expect(state.buttons[0].text).toContain(label);
    for (const label of ["2 running", "1 completed", "1 failed", "1 stopped", "1 paused", "1 unknown"]) {
      expect(state.buttons[0].title).toContain(label);
    }
    expect(state.panels).toBe(0);
  });

  it("closes and reopens the plan without changing task states", async () => {
    await evaluate(progress => {
      const props: DockProps = { sessionId: "plan", progress };
      props.onSetPlanClosed = async closed => {
        props.taskPlan = closed ? { closedAt: 100, changedSinceClose: false } : undefined;
        window.dockFixture.render(props);
      };
      window.dockFixture.render(props);
    }, { tasks, agents: [] });
    await click("TaskList");
    await evaluate(() => document.querySelector<HTMLButtonElement>(".chat-task-dock-plan button")!.click());
    expect((await visible()).buttons[0].text).toContain("3/10 · Closed");
    expect((await visible()).text).toContain("7 unfinished tasks");
    expect((await visible()).text).toContain("Running tasks will continue");
    await evaluate(() => document.querySelector<HTMLButtonElement>(".chat-task-dock-plan button")!.click());
    expect((await visible()).buttons[0].text).toContain("3/10 · In progress");
  });

  it("keeps an empty closed plan accessible and flags updates after closure", async () => {
    await evaluate(() => window.dockFixture.render({ sessionId: "closed", progress: { tasks: [], agents: [] },
      taskPlan: { closedAt: 100, changedSinceClose: true } }));
    expect((await visible()).buttons[0].text).toContain("Closed · No tasks");
    expect((await visible()).buttons[0].text).toContain("Updated since closure");
    await click("TaskList");
    expect((await visible()).panels).toBe(1);
  });

  it("disables duplicate submissions and keeps the plan open if persistence fails", async () => {
    await evaluate(progress => {
      const props: DockProps = { sessionId: "failed", progress, onSetPlanClosed: () => new Promise((_resolve, reject) => {
        (window as any).rejectPlan = () => reject(new Error("Disk unavailable"));
      }) };
      window.dockFixture.render(props);
    }, { tasks, agents: [] });
    await click("TaskList");
    await evaluate(() => document.querySelector<HTMLButtonElement>(".chat-task-dock-plan button")!.click());
    expect(await evaluate(() => document.querySelector<HTMLButtonElement>(".chat-task-dock-plan button")!.disabled)).toBe(true);
    await evaluate(() => (window as any).rejectPlan());
    expect((await visible()).buttons[0].text).not.toContain("Closed");
    expect(await evaluate(() => document.querySelector('[role="alert"]')?.textContent)).toContain("Disk unavailable");
    expect(await evaluate(() => document.querySelector<HTMLButtonElement>(".chat-task-dock-plan button")!.disabled)).toBe(false);
  });

  it("shows task statuses, completion history and structured task context", async () => {
    await render({ tasks: tasks.map(task => task.id === "3" ? {
      ...task, description: "Inspect the code", activeForm: "Inspecting files", owner: "reviewer", scope: "branch-a",
    } : task), agents: [] });
    await click("TaskList");
    expect(await evaluate(() => Array.from(document.querySelectorAll("li")).map(row => row.textContent)))
      .toEqual(expect.arrayContaining([expect.stringContaining("Task 0"), expect.stringContaining("Task 9")]));
    const state = await visible();
    for (const label of ["Pending", "In progress", "Completed", "Inspect the code", "Inspecting files", "reviewer", "branch-a"]) {
      expect(state.text).toContain(label);
    }
    expect(await evaluate(() => document.querySelector('[role="region"]')?.getAttribute("aria-labelledby")))
      .toBe(await evaluate(() => document.querySelector('button[aria-expanded="true"]')?.id));
    if (process.env.CC_CHAT_UI_CAPTURE === "1") await request({ capture: true });
  });

  it("retains every agent status, background launch state, elapsed duration and completion summary", async () => {
    await render({ tasks: [], agents });
    await click("SubAgent");
    expect(await evaluate(() => document.querySelectorAll("li").length)).toBe(7);
    const state = await visible();
    for (const label of ["Running", "Completed", "Failed", "Stopped", "Paused", "Unknown", "Background", "1m 05s", "Verified the result"]) {
      expect(state.text).toContain(label);
    }
    expect(await evaluate(() => document.querySelector('[data-agent-id="run"]')?.textContent)).not.toContain("Completed");
  });

  it("opens only one panel and keeps focus on the newly selected trigger", async () => {
    await render({ tasks, agents });
    await click("TaskList");
    expect((await visible()).panels).toBe(1);
    await click("SubAgent");
    const state = await visible();
    expect(state.panels).toBe(1);
    expect(state.buttons.map(button => button.expanded)).toEqual(["false", "true"]);
    expect(state.text).not.toContain("Task 0");
    expect(state.focus).toContain("SubAgent");
    await click("SubAgent");
    expect((await visible()).panels).toBe(0);
  });

  it("closes on Escape from the panel and restores focus to its own trigger", async () => {
    await render({ tasks, agents });
    await click("SubAgent");
    const result = await evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[role="region"]')!;
      panel.focus();
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      panel.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(result).toBe(true);
    expect((await visible()).panels).toBe(0);
    expect((await visible()).focus).toContain("SubAgent");
  });

  it("does not consume an Escape already handled by another control", async () => {
    await render({ tasks, agents: [] });
    await click("TaskList");
    await evaluate(() => {
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      event.preventDefault();
      document.querySelector('[role="region"]')!.dispatchEvent(event);
    });
    expect((await visible()).panels).toBe(1);
  });

  it("closes on an outside click without taking the message input focus", async () => {
    await render({ tasks, agents: [] });
    await click("TaskList");
    await evaluate(() => {
      const input = document.getElementById("outside") as HTMLTextAreaElement;
      input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      input.focus();
      input.click();
      input.value = "continue typing";
    });
    expect((await visible()).panels).toBe(0);
    expect(await evaluate(() => document.activeElement?.id)).toBe("outside");
    expect(await evaluate(() => (document.activeElement as HTMLTextAreaElement).value)).toBe("continue typing");
  });

  it("keeps the panel open on inside clicks and lets Tab move focus freely", async () => {
    await render({ tasks, agents: [] });
    await click("TaskList");
    expect(await evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[role="region"]')!;
      panel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      panel.click();
      const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      panel.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(false);
    expect((await visible()).panels).toBe(1);
  });

  it("resets on session changes, including returning to the previous session", async () => {
    await render({ tasks, agents }, "a");
    await click("TaskList");
    await render({ tasks: [{ id: "b", title: "B task", status: "pending" }], agents: [] }, "b");
    expect((await visible()).panels).toBe(0);
    await render({ tasks, agents }, "a");
    expect((await visible()).panels).toBe(0);
    await click("TaskList");
    expect((await visible()).text).toContain("Task 0");
    expect((await visible()).text).not.toContain("B task");
  });

  it("updates snapshots without opening, closing, or moving focus", async () => {
    await render({ tasks, agents });
    const updated = { tasks: tasks.map(task => ({ ...task, status: "completed" as const })), agents };
    await render(updated);
    expect((await visible()).panels).toBe(0);
    await click("TaskList");
    await evaluate(() => document.querySelector<HTMLElement>('[role="region"]')!.focus());
    await render({ ...updated, agents: agents.map(agent => ({ ...agent, status: "completed" as const })) });
    expect((await visible()).panels).toBe(1);
    expect((await visible()).buttons[0].text).toContain("10/10");
    expect(await evaluate(() => document.activeElement?.getAttribute("role"))).toBe("region");
  });

  it("keeps records with equal task ids in different scopes distinct during reordering", async () => {
    const scoped: SessionProgress = { tasks: [
      { id: "same", scope: "a", title: "Scope A", status: "pending" },
      { id: "same", scope: "b", title: "Scope B", status: "completed" },
    ], agents: [] };
    await render(scoped);
    await click("TaskList");
    expect(await evaluate(progress => {
      const first = document.querySelector("li");
      window.dockFixture.render({ sessionId: "session-a", progress: { ...progress, tasks: [...progress.tasks].reverse() } });
      return first === document.querySelectorAll("li")[1];
    }, scoped)).toBe(true);
    expect((await visible()).errors).toEqual([]);
    expect((await visible()).text).toContain("Scope A");
    expect((await visible()).text).toContain("Scope B");
  });

  it("uses distinct stable accessibility ids for multiple mounted docks", async () => {
    await evaluate(progress => window.dockFixture.renderMany([
      { sessionId: "same", progress }, { sessionId: "same", progress },
    ]), { tasks, agents });
    const before = (await visible()).buttons.map(button => button.controls);
    expect(new Set(before).size).toBe(4);
    await evaluate(progress => window.dockFixture.renderMany([
      { sessionId: "same", progress }, { sessionId: "same", progress },
    ]), { tasks, agents });
    expect((await visible()).buttons.map(button => button.controls)).toEqual(before);
  });

  it("uses the existing locale and localized task/agent states", async () => {
    await render({ tasks, agents }, "session-a", "zh");
    await click("SubAgent");
    for (const label of ["运行中", "已完成", "失败", "已停止", "已暂停", "未知", "后台"]) {
      expect((await visible()).text).toContain(label);
    }
    await click("TaskList");
    for (const label of ["待开始", "进行中", "已完成"]) expect((await visible()).text).toContain(label);
  });

  it("floats above the entry without changing composer height and fits a narrow, short window after resize", async () => {
    await render({ tasks, agents });
    const closedHeight = await evaluate(() => document.getElementById("root")!.getBoundingClientRect().height);
    await click("TaskList");
    expect(await evaluate(() => document.getElementById("root")!.getBoundingClientRect().height)).toBe(closedHeight);
    await request({ resize: [320, 280] });
    const box = await evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[role="region"]')!;
      const rect = panel.getBoundingClientRect();
      const host = document.getElementById("root")!.getBoundingClientRect();
      return { position: getComputedStyle(panel).position, left: rect.left, right: rect.right, top: rect.top,
        bottom: rect.bottom, hostTop: host.top, viewportWidth: innerWidth,
        scrollable: panel.scrollHeight > panel.clientHeight, overflow: getComputedStyle(panel).overflowY };
    });
    expect(box.position).toBe("absolute");
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.viewportWidth);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(box.hostTop);
    expect(box.scrollable).toBe(true);
    expect(box.overflow).toBe("auto");
  });

  it("limits long previews, scales font sizes and follows light/dark theme tokens", async () => {
    await render({ tasks: [], agents: [{ ...agents[2], summary: "Long summary. ".repeat(500) }] });
    await click("SubAgent");
    const result = await evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[role="region"]')!;
      const preview = panel.querySelector<HTMLElement>(".chat-task-dock-preview")!;
      const initial = getComputedStyle(panel).backgroundColor;
      const before = parseFloat(getComputedStyle(preview).fontSize);
      const clamped = preview.scrollHeight > preview.clientHeight;
      document.documentElement.dataset.theme = "light";
      document.documentElement.style.fontSize = "20px";
      return { initial, light: getComputedStyle(panel).backgroundColor, before,
        after: parseFloat(getComputedStyle(preview).fontSize), clamped, overflow: getComputedStyle(preview).overflow };
    });
    expect(result.clamped).toBe(true);
    expect(result.overflow).toBe("hidden");
    expect(result.after / result.before).toBeCloseTo(1.25);
    expect(result.light).not.toBe(result.initial);
    const css = readFileSync(cssPath, "utf8");
    expect(css).not.toMatch(/font-size:\s*[\d.]+px\b/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).toMatch(/transition:\s*none/);
  });

  it("uses the existing success color and lets long agent results expand for inspection", async () => {
    await render({ tasks: [], agents: [{ ...agents[2], summary: "Detailed result. ".repeat(100) }] });
    await click("SubAgent");
    expect(await evaluate(() => {
      document.documentElement.style.setProperty("--ok", "rgb(12, 100, 80)");
      return getComputedStyle(document.querySelector(".is-completed .chat-task-dock-status-dot")!).color;
    })).toBe("rgb(12, 100, 80)");
    await evaluate(() => (document.querySelector(".chat-task-dock-more") as HTMLButtonElement).click());
    expect(await evaluate(() => {
      const preview = document.querySelector<HTMLElement>(".chat-task-dock-preview")!;
      return preview.scrollHeight <= preview.clientHeight;
    })).toBe(true);
  });

  it("lets short multiline results expand when line clamping hides content", async () => {
    await render({ tasks: [], agents: [{ ...agents[2], summary: "One\nTwo\nThree\nFour\nFive" }] });
    await click("SubAgent");
    expect(await evaluate(() => Boolean(document.querySelector(".chat-task-dock-more")))).toBe(true);
    await evaluate(() => (document.querySelector(".chat-task-dock-more") as HTMLButtonElement).click());
    expect(await evaluate(() => {
      const preview = document.querySelector<HTMLElement>(".chat-task-dock-preview")!;
      return preview.scrollHeight <= preview.clientHeight;
    })).toBe(true);
  });

  it("keeps its header inside the chat panel's clipping boundary below the app header", async () => {
    await evaluate(() => {
      const container = document.createElement("div");
      container.className = "chat-panel dock-clip-fixture";
      container.style.cssText = "position:fixed;top:64px;left:0;width:100%;height:calc(100% - 64px);overflow:hidden";
      document.body.appendChild(container);
      const main = document.getElementById("root")!.closest("main")!;
      main.style.position = "absolute";
      main.style.top = "50%";
      container.appendChild(main);
    });
    await render({ tasks, agents });
    await click("TaskList");
    expect(await evaluate(() => {
      const popup = document.querySelector('[role="region"]')!.getBoundingClientRect();
      const container = document.querySelector(".dock-clip-fixture")!.getBoundingClientRect();
      return popup.top - container.top;
    })).toBeGreaterThanOrEqual(0);
  });
});

describe("main transcript real Electron layout", () => {
  it.each(["cancelled", "interrupted", "failed", "completed"] as const)("shows the persisted %s outcome after remounting", async outcome => {
    await evaluate(items => window.dockFixture.renderTurn(items), [
      { kind: "text" as const, id: "u", role: "user" as const, text: "Work", turnOutcome: outcome },
      ...(outcome === "cancelled" ? [] : [{ kind: "tool" as const, id: "done-tool", tool: { id: "done-tool", name: "Read", summary: "Read", status: "done" as const } }]),
    ]);
    const expected = { cancelled: "Cancelled", interrupted: "Interrupted", failed: "Failed", completed: "Done" }[outcome];
    expect(await evaluate(() => document.querySelector(".turn-status-label")?.textContent)).toBe(expected);
    if (outcome === "interrupted") expect(await evaluate(() => document.querySelector(".activity-group-status")?.textContent)).toBe("Interrupted");
  });
  it("preserves the visible message while prepending history whose first item is a collapsed tool", async () => {
    await evaluate(() => window.dockFixture.mountHistory());
    await evaluate(() => document.querySelector<HTMLButtonElement>(".activity-group-toggle")!.click());
    const before = await evaluate(() => {
      const list = document.querySelector<HTMLElement>(".main-chat-message-list")!;
      list.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
      list.scrollTop = 100;
      const top = document.querySelector('[data-item-id="user-0"]')!.getBoundingClientRect().top;
      document.querySelector<HTMLButtonElement>(".message-load-older")!.click();
      return top;
    });
    const after = await evaluate(() => document.querySelector('[data-item-id="user-0"]')!.getBoundingClientRect().top);
    expect(await evaluate(() => document.querySelector(".activity-group-toggle")?.getAttribute("aria-expanded"))).toBe("true");
    expect(Math.abs(after - before)).toBeLessThan(2);
  });
  it("places a new response at 55% of the area above the composer and remeasures resize", async () => {
    await evaluate(() => window.dockFixture.mountScroll());
    const ratio = () => evaluate(() => {
      const f = window.scrollFixture!;
      const statusTop = f.list.querySelector("[data-current-turn-status]")!.getBoundingClientRect().top;
      return (statusTop - f.list.getBoundingClientRect().top) / (f.composer.getBoundingClientRect().top - f.list.getBoundingClientRect().top);
    });
    expect(await ratio()).toBeCloseTo(0.55, 2);
    await evaluate(() => {
      const f = window.scrollFixture!;
      f.composer.style.height = "250px";
      f.panel.style.setProperty("--composer-h", "250px");
      return new Promise(resolve => setTimeout(resolve, 80));
    });
    expect(await ratio()).toBeCloseTo(0.55, 2);
  });

  it("does not clamp on manual input, keeps reading position as text grows, and follows on explicit return", async () => {
    await evaluate(() => window.dockFixture.mountScroll());
    const before = await evaluate(() => window.scrollFixture!.list.scrollTop);
    await evaluate(() => {
      const f = window.scrollFixture!;
      f.list.dispatchEvent(new Event("touchstart"));
    });
    expect(await evaluate(() => window.scrollFixture!.list.scrollTop)).toBe(before);
    await evaluate(() => {
      const f = window.scrollFixture!;
      f.list.scrollTop -= 1;
      f.body.style.height = "1080px";
      f.controller.update({ sessionId: "s", userId: "u", running: true, hasNewer: false });
    });
    expect(Math.abs(await evaluate(() => window.scrollFixture!.list.scrollTop) - (before - 1))).toBeLessThan(1);
    expect(await evaluate(() => window.scrollFixture!.spacer.style.height)).toBe("0px");
    await evaluate(() => window.scrollFixture!.controller.followTail());
    expect(await evaluate(() => window.scrollFixture!.list.scrollTop)).toBeGreaterThan(before);
    await evaluate(() => window.scrollFixture!.controller.update({ sessionId: "s", userId: "u", running: false, hasNewer: false }));
    expect(await evaluate(() => window.scrollFixture!.spacer.style.height)).toBe("0px");
    expect(await evaluate(() => {
      const f = window.scrollFixture!;
      return f.composer.getBoundingClientRect().top - f.body.getBoundingClientRect().bottom;
    })).toBeCloseTo(24, 0);
  });
});
