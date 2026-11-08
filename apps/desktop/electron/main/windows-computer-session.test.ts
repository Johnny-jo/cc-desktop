import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const { createTargetSession } = createRequire(import.meta.url)("../../resources/windows-computer/target-session.cjs");
const signal = new AbortController().signal;
const bounds = { x: -200, y: 40, width: 180, height: 100 };
const box = { x: -170, y: 55, width: 60, height: 25 };
const control = { id: "7", name: "Save", enabled: true, controlType: "Button", bounds: box, patterns: ["invoke"] };
const ui = { windowId: "W", observationId: "u1", bounds, controls: [control] };
const pixels = { windowId: "W", observationId: "v1", bounds, windowBounds: bounds, texts: [
  { text: "Send", confidence: 0.99, bounds: box, point: {x: -140, y: 64} },
], shapes: [] };

describe("unified computer use session", () => {
  it("binds the image and a mistaken scene-ID coordinate click to the same window capture", async () => {
    const request = vi.fn().mockResolvedValue(ui);
    const observePixels = vi.fn().mockResolvedValue({ frame: { ...pixels, captureSource: "compositor" } });
    const session = createTargetSession({request, observePixels});
    const { view } = await session.inspect({windowId: "W", includeImage: true}, signal);
    expect(view).toMatchObject({observationId:"v1", captureSource:"compositor", imageBounds:bounds});
    const args = {windowId:"W", observationId:view.sceneId, x:-140, y:64, button:"left"};
    await session.click(args, signal);
    expect(request).toHaveBeenLastCalledWith("click", {...args, observationId:"v1"}, signal);
    await expect(session.click(args, signal)).rejects.toThrow(/expired/i);
    expect(request.mock.calls.filter(([op]) => op === "click")).toHaveLength(1);
  });

  it("reads the result of a compositor click from the same window backend", async () => {
    const request = vi.fn().mockResolvedValue({...ui, controls:[]});
    const observePixels = vi.fn().mockResolvedValue({frame:{...pixels, captureSource:"compositor"}});
    const session = createTargetSession({request, observePixels});
    const {view} = await session.inspect({windowId:"W",query:"Send"},signal);
    await session.act({windowId:"W", sceneId:view.sceneId, targetId:view.targets[0].id, action:"activate"},signal);
    expect(observePixels).toHaveBeenLastCalledWith("capture_window",{windowId:"W",captureSource:"compositor"},signal);
  });

  it("refuses a scene-ID coordinate click with no visual capture or on another window", async () => {
    const request = vi.fn().mockResolvedValue(ui);
    const session = createTargetSession({request, observePixels:vi.fn().mockResolvedValue({frame:pixels})});
    const args = {windowId:"W",x:-140,y:64,button:"left"};
    const native = await session.inspect({windowId:"W",vision:"never"}, signal);
    expect(native.view.observationId).toBeUndefined();
    await expect(session.click({...args,observationId:native.view.sceneId}, signal)).rejects.toThrow(/visual|image/i);
    const visual = await session.inspect({windowId:"W",includeImage:true}, signal);
    await expect(session.click({...args,windowId:"other",observationId:visual.view.sceneId}, signal)).rejects.toThrow(/window/i);
    expect(request.mock.calls.some(([op]) => op === "click")).toBe(false);
  });

  it("avoids OCR for a named native action and consumes the scene before invoking", async () => {
    const request = vi.fn().mockResolvedValue(ui);
    const observePixels = vi.fn();
    const session = createTargetSession({request, observePixels});
    const { view } = await session.inspect({windowId: "W", query: "Save", action: "activate"}, signal);
    expect(view.visionUsed).toBe(false);
    const args = {windowId: "W", sceneId: view.sceneId, targetId: view.targets[0].id, action: "activate"};
    request.mockResolvedValueOnce({ok:true}).mockResolvedValue({...ui, controls:[{...control, name:"Done"}]});
    expect(await session.act({...args, verifyText:"Done"}, signal)).toMatchObject({executed:true, via:"invoke", verification:{status:"observed"}});
    await expect(session.act(args, signal)).rejects.toThrow(/inspect|expired/i);
    expect(observePixels).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([op]) => op === "invoke_control")).toHaveLength(1);
  });

  it("can operate a visual target when the accessibility provider is unavailable", async () => {
    const request = vi.fn(async (op: string) => {
      if (op === "observe_target_tree") throw Error("UIA provider unavailable");
      return {ok:true};
    });
    const observePixels = vi.fn().mockResolvedValue({frame:pixels});
    const session = createTargetSession({request, observePixels});
    const {view} = await session.inspect({windowId:"W",query:"Send"}, signal);
    expect(view.targets).toHaveLength(1);
    expect(view.visionUsed).toBe(true);
    const args = {windowId:"W", sceneId:view.sceneId, targetId:view.targets[0].id, action:"activate"};
    await expect(session.act({...args, windowId:"other"}, signal)).rejects.toThrow();
    const result = await session.act(args, signal);
    expect(result).toMatchObject({executed:true, via:"click"});
    expect(request).toHaveBeenCalledWith("click", expect.objectContaining({windowId:"W",observationId:"v1", x:expect.any(Number), y:expect.any(Number)}), signal);
  });

  it("rejects mixed geometry and does not expose a prior scene after a failed refresh", async () => {
    const request = vi.fn().mockResolvedValue(ui);
    const observePixels = vi.fn().mockResolvedValue({frame:{...pixels, windowBounds:{...bounds,x:0}}});
    const session = createTargetSession({request,observePixels});
    const {view} = await session.inspect({windowId:"W",query:"Save"}, signal);
    await expect(session.inspect({windowId:"W",vision:"always"}, signal)).rejects.toThrow(/moved|geometry|changed/i);
    await expect(session.act({windowId:"W",sceneId:view.sceneId,targetId:view.targets[0].id,action:"activate"},signal)).rejects.toThrow();
  });

  it("reports failed readback without repeating a successfully submitted input", async () => {
    const request = vi.fn().mockResolvedValueOnce(ui).mockResolvedValueOnce({ok:true}).mockRejectedValue(Error("Window closed"));
    const observePixels = vi.fn().mockRejectedValue(Error("Window closed"));
    const session = createTargetSession({request,observePixels});
    const {view} = await session.inspect({windowId:"W", query:"Save"}, signal);
    const result = await session.act({windowId:"W",sceneId:view.sceneId,targetId:view.targets[0].id,action:"activate",verifyText:"Saved"},signal);
    expect(result).toMatchObject({executed:true,verification:{status:"unavailable"}});
    expect(request.mock.calls.filter(([op])=>op==="invoke_control")).toHaveLength(1);
  });

  it("uses vision for an exact visual label when the only native match is a longer command", async () => {
    const request = vi.fn().mockResolvedValue({...ui, controls:[{...control, name:"Send feedback", bounds:null}]});
    const observePixels = vi.fn().mockResolvedValue({frame:pixels});
    const { view } = await createTargetSession({request,observePixels}).inspect({windowId:"W",query:"Send",action:"activate"},signal);
    expect(view.visionUsed).toBe(true);
    expect(view.targets.map((t: {name:string}) => t.name).sort()).toEqual(["Send", "Send feedback"]);
  });

  it("finds a native control on the next chunk without losing the observation used for the action", async () => {
    const fullPage = Array.from({length:256}, (_, i) => ({...control,id:"other-" + i,name:"Other " + i}));
    const request = vi.fn().mockResolvedValueOnce({...ui, controls:fullPage, truncated:true, nextCursor:"page2"})
      .mockResolvedValueOnce({...ui, observationId:"second-page"})
      .mockResolvedValueOnce({ok:true}).mockResolvedValueOnce(ui);
    const observePixels = vi.fn();
    const session = createTargetSession({request,observePixels});
    const {view} = await session.inspect({windowId:"W", query:"Save"},signal);
    expect(view).toMatchObject({pagesRead:2, visionUsed:false});
    await session.act({windowId:"W",sceneId:view.sceneId,targetId:view.targets[0].id,action:"activate"},signal);
    expect(request).toHaveBeenCalledWith("invoke_control", {windowId:"W",observationId:"second-page",controlId:"7"}, signal);
  });

  it("does not retry an uncertain native action through a visual click", async () => {
    const request = vi.fn().mockResolvedValueOnce(ui).mockRejectedValue(new Error("Provider timed out"));
    const observePixels = vi.fn().mockResolvedValue({frame:{...pixels,texts:[{...pixels.texts[0],text:"Save"}]}});
    const session = createTargetSession({request,observePixels});
    const {view} = await session.inspect({windowId:"W", query:"Save", vision:"always"},signal);
    const args = {windowId:"W",sceneId:view.sceneId,targetId:view.targets[0].id,action:"activate"};
    await expect(session.act(args,signal)).rejects.toThrow("timed out");
    await expect(session.act(args,signal)).rejects.toThrow(/expired/i);
    expect(request.mock.calls.map(([op]) => op)).toEqual(["observe_target_tree","invoke_control"]);
  });

  it("carries disabled-control evidence across a chunk boundary so OCR cannot make it actionable", async () => {
    const request = vi.fn().mockResolvedValueOnce({...ui, controls:[{...control, name:"Send", enabled:false}], nextCursor:"more"})
      .mockResolvedValueOnce({...ui, observationId:"p2", controls:[]});
    const session = createTargetSession({request,observePixels:vi.fn().mockResolvedValue({frame:pixels})});
    const {view} = await session.inspect({windowId:"W", query:"Send", action:"activate"},signal);
    expect(request.mock.calls[1][1]).toMatchObject({cursor:"more", extendObservationId:"u1"});
    expect(view.targets).toHaveLength(0);
  });

  it("acknowledges an executed action if verification is cancelled and never returns the interrupted observation", async () => {
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValueOnce(ui).mockResolvedValueOnce({ok:true}).mockImplementationOnce(async () => {
      controller.abort();
      throw Error("Verification cancelled");
    });
    const session = createTargetSession({request, observePixels:vi.fn()});
    const {view} = await session.inspect({windowId:"W",query:"Save"},controller.signal);
    const result = await session.act({windowId:"W",sceneId:view.sceneId,targetId:view.targets[0].id,action:"activate",verifyText:"Saved"},controller.signal);
    expect(result).toMatchObject({executed:true, verification:{status:"interrupted"}});
  });

  it("does not verify hidden names or OCR inside a known password field", async () => {
    const after = {...ui, controls:[{...control, name:"Saved", isOffscreen:true}, {...control, id:"pwd",isPassword:true,value:"Saved"}]};
    const request = vi.fn().mockResolvedValueOnce(ui).mockResolvedValueOnce({ok:true}).mockResolvedValue(after);
    const observePixels = vi.fn().mockResolvedValue({frame:{...pixels, texts:[{...pixels.texts[0],text:"Saved"}]}});
    const session = createTargetSession({request,observePixels});
    const {view} = await session.inspect({windowId:"W",query:"Save"},signal);
    const result = await session.act({windowId:"W",sceneId:view.sceneId,targetId:view.targets[0].id,action:"activate",verifyText:"Saved"},signal);
    expect(result.verification.status).toBe("not_observed");
  });
});
