import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const { windowDriver } = createRequire(import.meta.url)("../../resources/windows-computer/window-driver.cjs");
const signal = new AbortController().signal;
const windowId = "1a0c46:24300";
function fixture(access: Record<string, unknown>) {
  const standard = {request:vi.fn(async (op: string): Promise<Record<string, unknown>> =>
    op === "input_access" ? {windowId,...access} : {op}), close:vi.fn()};
  const scoped = {request:vi.fn(async (op: string) => op === "authorize_window" ? {authorized:true,windowId} : {op}), close:vi.fn()};
  const open = vi.fn(() => scoped);
  const driver = windowDriver(standard, open, vi.fn());
  return {driver,standard,scoped,open};
}

describe("desktop clicks from a standard AgentOS session", () => {
  it("keeps screen reads and same-integrity clicks in the standard driver", async () => {
    const {driver,standard,open} = fixture({level:"compatible"});
    await driver.request("capture_window",{windowId},signal);
    await driver.request("finish_visual",{},signal);
    await driver.request("click",{windowId,observationId:"visual-a",x:4,y:5},signal);
    expect(standard.request.mock.calls.map(([op])=>op)).toEqual(["capture_window","finish_visual","input_access","click"]);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([{level:"higher"}, {level:"unknown",messageAccessDenied:true}])("requests target-bound consent before sending a press for %j", async access => {
    const {driver,scoped,standard} = fixture(access);
    const args = {windowId,observationId:"visual-before-uac",x:4,y:5};
    await expect(driver.request("click",args,signal)).rejects.toThrow(/重新观察|observe again/i);
    expect(standard.request.mock.calls.map(([op])=>op)).toEqual(["input_access","release_control"]);
    expect(scoped.request.mock.calls.map(([op])=>op)).toEqual(["authorize_window"]);
    await driver.request("capture_window",{windowId},signal);
    await driver.request("finish_visual",{},signal);
    await driver.request("click",{...args,observationId:"visual-after-uac"},signal);
    await driver.request("list_windows",{},signal);
    await driver.request("release_control",{},signal);
    expect(scoped.request.mock.calls.map(([op])=>op)).toEqual(["authorize_window","capture_window","finish_visual","click","release_control"]);
    expect(scoped.close).toHaveBeenCalledOnce();
  });

  it("surfaces an uncertain or already-sent input without prompting or replaying it", async () => {
    const {driver,standard,open} = fixture({level:"unknown"});
    standard.request.mockResolvedValueOnce({windowId,level:"unknown"}).mockRejectedValueOnce(Error("First click was already sent."));
    await expect(driver.request("click",{windowId},signal)).rejects.toThrow(/already sent/);
    expect(open).not.toHaveBeenCalled();
  });

  it("upgrades after an inconclusive access probe only for a diagnosed pre-press rejection", async () => {
    const {driver,standard,scoped} = fixture({level:"unknown"});
    standard.request.mockResolvedValueOnce({windowId,level:"unknown"})
      .mockRejectedValueOnce(Object.assign(Error("Pointer move denied"),{code:"input_access_blocked"}));
    await expect(driver.request("click",{windowId},signal)).rejects.toThrow(/重新观察/);
    expect(scoped.request.mock.calls.map(([op])=>op)).toEqual(["authorize_window"]);
    expect(standard.request.mock.calls.filter(([op])=>op==="click")).toHaveLength(1);
  });

  it("does not pass keyboard input or an unbound screen capture to the elevated worker and releases it on a window change", async () => {
    const {driver,standard,scoped} = fixture({level:"higher"});
    await driver.request("authorize_window",{windowId},signal);
    await expect(driver.request("shortcut",{windowId,keys:["Win","R"]},signal)).rejects.toThrow();
    await expect(driver.request("capture_display",{},signal)).rejects.toThrow();
    await driver.request("observe_window",{windowId:"2:726"},signal);
    expect(scoped.request.mock.calls.map(([op])=>op)).toEqual(["authorize_window","release_control"]);
    expect(scoped.close).toHaveBeenCalledOnce();
    expect(standard.request).toHaveBeenLastCalledWith("observe_window",{windowId:"2:726"},signal);
  });

  it("does not re-prompt after the user declines, including an explicit tool retry", async () => {
    const {driver,open,scoped} = fixture({level:"higher"});
    scoped.request.mockRejectedValueOnce(Error("User cancelled UAC"));
    await expect(driver.request("activate_window",{windowId},signal)).rejects.toThrow(/cancelled/);
    await expect(driver.request("activate_window",{windowId},signal)).rejects.toThrow(/重连|reconnect/i);
    await expect(driver.request("authorize_window",{windowId},signal)).rejects.toThrow(/重连|reconnect/i);
    await expect(driver.request("authorize_window",{windowId:windowId.toUpperCase()},signal)).rejects.toThrow(/list_windows/);
    expect(open).toHaveBeenCalledOnce();
  });
});

it("uses only a unique OCR label in the same captured window and frame for pixel checks", () => {
  const {observedLabel} = createRequire(import.meta.url)("../../resources/windows-computer/observed-label.cjs");
  const bounds={x:-120,y:440,width:86,height:28}, click={x:-77,y:454,windowId,observationId:"visual-original"};
  const frame={windowId,observationId:click.observationId,texts:[{bounds}]};
  expect(observedLabel(frame,click)).toEqual(bounds);
  expect(observedLabel(frame,{...click,observationId:"stale"})).toBeUndefined();
  expect(observedLabel(frame,{...click,windowId:"3:5"})).toBeUndefined();
  expect(observedLabel(frame,{...click,x:-34})).toBeUndefined();
  expect(observedLabel({...frame,texts:[...frame.texts,{bounds}]},click)).toBeUndefined();
});
