import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createTargetSession } = require("../../resources/windows-computer/target-session.cjs");
const { windowDriver } = require("../../resources/windows-computer/window-driver.cjs");
const { nativeConnection } = require("../../resources/windows-computer/native-connection.cjs");
const signal = new AbortController().signal;
const windowId = "ab:123";
const bounds = {x:-200,y:40,width:180,height:100};
const ui = {windowId, observationId:"u1", bounds, controls:[]};
const scroll = {windowId,x:-100,y:70,deltaX:0,deltaY:-2};
const drag = {windowId,startX:-150,startY:70,endX:-50,endY:90,durationMs:100};
function fixture() {
  const request = vi.fn(async (op: string, _args: Record<string,unknown>, _signal: AbortSignal) => op === "observe_target_tree" ? ui : {windowId});
  const observePixels = vi.fn().mockRejectedValue(Error("No OCR in this fixture"));
  return {request, observePixels, session:createTargetSession({request, observePixels})};
}

describe("observed Windows scroll and drag", () => {
  it.each(["scroll", "drag"])("rejects %s before inspection or after invalidation", async operation => {
    const {session,request} = fixture();
    expect(typeof session[operation]).toBe("function");
    const args = {...(operation === "scroll" ? scroll : drag),sceneId:"missing"};
    await expect(session[operation](args,signal)).rejects.toThrow(/scene|inspect/i);
    const {view} = await session.inspect({windowId,vision:"never"},signal);
    session.invalidate();
    await expect(session[operation]({...args,sceneId:view.sceneId},signal)).rejects.toThrow(/scene|inspect/i);
    expect(request.mock.calls.filter(([op]) => op === operation)).toHaveLength(0);
  });

  it.each(["scroll", "drag"])("consumes the %s scene and independently reads the resulting state", async operation => {
    const {session,request} = fixture();
    expect(typeof session[operation]).toBe("function");
    const {view} = await session.inspect({windowId,vision:"never"},signal);
    const args = {...(operation === "scroll" ? scroll : drag),sceneId:view.sceneId};
    const result = await session[operation](args,signal);
    expect(result).toMatchObject({executed:true,windowId,via:operation,verification:{status:"read_back",source:"uia"}});
    expect(request.mock.calls.map(([op]) => op)).toEqual(["observe_target_tree",operation,"observe_target_tree"]);
    expect(request.mock.calls[1][1]).toMatchObject({observationId:"u1"});
    await expect(session[operation](args,signal)).rejects.toThrow(/scene|inspect/i);
  });

  it.each(["scroll", "drag"])("rejects cross-window and out-of-bounds %s input before sending it", async operation => {
    const {session,request} = fixture();
    expect(typeof session[operation]).toBe("function");
    const {view} = await session.inspect({windowId,vision:"never"},signal);
    const args = {...(operation === "scroll" ? scroll : drag),sceneId:view.sceneId};
    await expect(session[operation]({...args,windowId:"cd:456"},signal)).rejects.toThrow(/window|scene/i);
    await expect(session[operation]({...args,...(operation === "scroll" ? {x:-20} : {endX:-20})},signal)).rejects.toThrow(/outside|bounds/i);
    expect(request.mock.calls.filter(([op]) => op === operation)).toHaveLength(0);
  });

  it.each([{deltaY:Infinity},{deltaY:NaN},{deltaY:21},{deltaY:0},{deltaX:0.5},{x:2 ** 40}])("rejects malformed wheel values %j", async invalid => {
    const {session,request} = fixture();
    expect(typeof session.scroll).toBe("function");
    const {view} = await session.inspect({windowId,vision:"never"},signal);
    await expect(session.scroll({...scroll,...invalid,sceneId:view.sceneId},signal)).rejects.toThrow(/delta|coordinate|integer|bounds|outside/i);
    expect(request.mock.calls.filter(([op]) => op === "scroll")).toHaveLength(0);
  });

  it.each([{durationMs:0},{durationMs:2001},{endY:NaN},{startX:1.2}])("rejects malformed drag values %j", async invalid => {
    const {session,request} = fixture();
    expect(typeof session.drag).toBe("function");
    const {view} = await session.inspect({windowId,vision:"never"},signal);
    await expect(session.drag({...drag,...invalid,sceneId:view.sceneId},signal)).rejects.toThrow(/duration|coordinate|integer/i);
    expect(request.mock.calls.filter(([op]) => op === "drag")).toHaveLength(0);
  });

  it("does not replay a wheel event when result verification is unavailable", async () => {
    const {session,request} = fixture();
    expect(typeof session.scroll).toBe("function");
    const {view} = await session.inspect({windowId,vision:"never"},signal);
    request.mockImplementation(async op => {
      if (op === "observe_target_tree") throw Error("Window closed");
      return {windowId};
    });
    const result = await session.scroll({...scroll,sceneId:view.sceneId,verifyText:"Next page"},signal);
    expect(result).toMatchObject({executed:true,verification:{status:"unavailable"}});
    expect(request.mock.calls.filter(([op]) => op === "scroll")).toHaveLength(1);
    await expect(session.scroll({...scroll,sceneId:view.sceneId},signal)).rejects.toThrow(/scene|inspect/i);
  });

  it("consumes the drag scene on an uncertain native failure", async () => {
    const {session,request} = fixture();
    expect(typeof session.drag).toBe("function");
    const {view} = await session.inspect({windowId,vision:"never"},signal);
    request.mockRejectedValueOnce(Error("Interrupted after press"));
    const args = {...drag,sceneId:view.sceneId};
    await expect(session.drag(args,signal)).rejects.toThrow(/Interrupted/);
    await expect(session.drag(args,signal)).rejects.toThrow(/scene|inspect/i);
    expect(request.mock.calls.filter(([op]) => op === "drag")).toHaveLength(1);
  });

  it.each(["scroll","drag"])("preserves the %s receipt when readback is cancelled after native acknowledgement", async operation => {
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValueOnce(ui).mockResolvedValueOnce({windowId}).mockImplementationOnce(async () => {
      controller.abort(); throw Error("Readback cancelled");
    });
    const session = createTargetSession({request,observePixels:vi.fn()});
    const {view} = await session.inspect({windowId,vision:"never"},controller.signal);
    const args = {...(operation === "scroll" ? scroll : drag),sceneId:view.sceneId};
    await expect(session[operation](args,controller.signal)).resolves.toMatchObject({executed:true,via:operation,verification:{status:"interrupted"}});
    expect(request.mock.calls.filter(([op]) => op === operation)).toHaveLength(1);
  });
});

describe("Windows scroll and drag permissions", () => {
  it.each(["scroll","drag"])("rejects higher-integrity %s without opening an unsupported broker", async operation => {
    const standard = {request:vi.fn().mockResolvedValue({level:"higher"}),close:vi.fn()};
    const open = vi.fn();
    const driver = windowDriver(standard,open,vi.fn());
    await expect(driver.request(operation,{windowId},signal)).rejects.toThrow(/支持|unavailable|administrator/i);
    expect(standard.request.mock.calls.map(([op]) => op)).toEqual(["input_access"]);
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["scroll","drag"])("checks access then executes same-integrity %s only once", async operation => {
    const standard = {request:vi.fn().mockResolvedValue({level:"compatible"}),close:vi.fn()};
    const driver = windowDriver(standard,vi.fn(),vi.fn());
    await driver.request(operation,{windowId},signal);
    expect(standard.request.mock.calls.map(([op]) => op)).toEqual(["input_access",operation]);
    driver.close();
    await expect(driver.request(operation,{windowId},signal)).rejects.toThrow(/stopped|closed/i);
  });

  it.each(["scroll","drag"])("refuses %s even when a window-scoped grant already exists", async operation => {
    const standard = {request:vi.fn().mockResolvedValue({level:"higher"}),close:vi.fn()};
    const scoped = {request:vi.fn().mockResolvedValue({authorized:true,windowId}),close:vi.fn()};
    const driver = windowDriver(standard,() => scoped,vi.fn());
    await driver.request("authorize_window",{windowId},signal);
    await expect(driver.request(operation,{windowId},signal)).rejects.toThrow(/支持|unavailable/i);
    expect(scoped.request.mock.calls.map(([op]) => op)).toEqual(["authorize_window"]);
    driver.close();
  });
});

class Worker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  kill = vi.fn();
}
describe("native drag cancellation", () => {
  it("revokes an ordinary drag whose native finally could not confirm mouse release", async () => {
    const child = new Worker();
    const driver = nativeConnection(() => child);
    const active = driver.request("drag",drag,signal).catch((error: Error) => error);
    child.stdout.write('{"error":"Mouse release failed","errorCode":"pointer_release_unconfirmed"}\n');
    expect((await active).message).toMatch(/release.*(unconfirmed|unknown)/i);
    await expect(driver.request("release_control",{},signal)).rejects.toThrow(/stopped|revoked|reconnect/i);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("retires a blocked main thread after an independent cancellation acknowledgement", async () => {
    const child = new Worker();
    child.kill.mockImplementation(() => child.emit("exit",0));
    const driver = nativeConnection(() => child);
    const controller = new AbortController();
    const active = driver.request("drag",drag,controller.signal).catch((error: Error) => error);
    controller.abort();
    child.stdout.write('{"cancel_ack":true,"pointerReleased":true}\n');
    expect((await active).message).toMatch(/interrupted/i);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("bounds cancellation when the helper never responds and refuses to confirm release", async () => {
    vi.useFakeTimers();
    try {
      const child = new Worker();
      child.kill.mockImplementation(() => child.emit("exit",0));
      const driver = nativeConnection(() => child);
      const controller = new AbortController();
      let actionError: Error | undefined, releaseResult: unknown;
      const active = driver.request("drag",drag,controller.signal).catch((error: Error) => { actionError=error; });
      controller.abort();
      const release = driver.request("release_control",{},signal).catch((error: Error) => error).then((result: unknown) => { releaseResult=result; });
      await vi.advanceTimersByTimeAsync(2500);
      expect(actionError?.message).toMatch(/release.*(unconfirmed|unknown)|unconfirmed.*release/i);
      expect(releaseResult).toBeInstanceOf(Error);
      expect((releaseResult as Error).message).toMatch(/release.*(unconfirmed|unknown)|unconfirmed.*release/i);
      expect(child.kill).not.toHaveBeenCalled();
      await expect(driver.request("list_windows",{},signal)).rejects.toThrow(/stopped|revoked|reconnect/i);
      await Promise.all([active,release]);
      // A late independent cleanup acknowledgement may retire this same helper.
      child.stdout.write('{"cancel_ack":true,"pointerReleased":true}\n');
      expect(child.kill).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("does not treat an unsuccessful cancellation acknowledgement as confirmed mouse release", async () => {
    const child = new Worker();
    child.kill.mockImplementation(() => child.emit("exit",0));
    const driver = nativeConnection(() => child);
    const controller = new AbortController();
    const active = driver.request("drag",drag,controller.signal).catch((error: Error) => error);
    controller.abort();
    const release = driver.request("release_control",{},signal).catch((error: Error) => error);
    child.stdout.write('{"cancel_ack":true,"pointerReleased":false}\n');
    expect((await active).message).toMatch(/release.*(unconfirmed|unknown)/i);
    expect((await release).message).toMatch(/release.*(unconfirmed|unknown)/i);
  });

  it("waits for drag cleanup and worker exit when release_control interrupts a drag", async () => {
    const child = new Worker();
    const sent: string[] = [];
    child.stdin.on("data",chunk => sent.push(String(chunk)));
    child.kill.mockImplementation(() => child.emit("exit",0));
    const driver = nativeConnection(() => child);
    const active = driver.request("drag",drag,signal).catch((error: Error) => error);
    let released = false;
    const release = driver.request("release_control",{},signal).then((result: unknown) => { released=true; return result; });
    const releaseError = release.catch((error: Error) => error);
    await Promise.resolve();
    expect(sent.map(line => JSON.parse(line).operation)).toEqual(["drag","cancel_current"]);
    expect(released).toBe(false);
    child.stdout.write('{"error":"Drag cancelled after releasing its button."}\n');
    expect((await active).message).toMatch(/interrupted/i);
    await expect(releaseError).resolves.toEqual({released:true});
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it.each(["abort","close"])("lets native drag release its button before retiring the helper on %s", async mode => {
    const child = new Worker();
    const sent: string[] = [];
    child.stdin.on("data", chunk => sent.push(String(chunk)));
    const driver = nativeConnection(() => child);
    const controller = new AbortController();
    const active = driver.request("drag",drag,controller.signal);
    const settled = active.catch((error: Error) => error);
    if (mode === "abort") controller.abort(); else driver.close();
    expect(sent.map(line => JSON.parse(line).operation)).toEqual(["drag","cancel_current"]);
    expect(child.kill).not.toHaveBeenCalled();
    await expect(driver.request("observe_window",{},signal)).rejects.toThrow(/running|closed|stopped/i);
    child.stdout.write('{"error":"Drag interrupted after mouse release."}\n');
    expect((await settled).message).toMatch(/interrupted|closed/i);
    expect(child.kill).toHaveBeenCalledOnce();
    driver.close();
  });
});
