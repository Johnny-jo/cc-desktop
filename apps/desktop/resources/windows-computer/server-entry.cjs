// Bundled for Electron's Node mode; no user-installed runtime is needed.
const { spawn } = require("node:child_process");
const { basename, join, resolve } = require("node:path");
const { createTargetSession } = require("./target-session.cjs");
const { nativeConnection } = require("./native-connection.cjs");
const { windowDriver } = require("./window-driver.cjs");
const { clickWithObservation } = require("./click-after-hover.cjs");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const server = new McpServer({ name: "AgentOS Windows Computer", version: "1.0.0" }, {
  instructions: "For Windows desktop tasks use list_windows and inspect_window. Choose a target by its label, ancestors and bounds. Call act_on_target with sceneId, targetId and verifyText. For custom graphics request includeImage:true. Use observationId and absolute screen pixels for a coordinate click. If window capture fails, activate the target and call observe_display_visual with windowId. Re-observe after a window moves, changes, or the user grants administrator access. Input to higher-integrity windows requests user consent for the specific window. If Windows denies normal input and the requested app requires administrator access, use authorize_window_control, then activate and inspect the same window again. Respect a declined prompt and never work around desktop input errors using PowerShell or an external script. When finished, release_control. Esc stops the connection.",
});
// A production MCP lives beside app.asar. A development MCP lives in
// resources/windows-computer/dist. Both use the app's existing native OCR modules.
const visionWorker = basename(__dirname) === "dist"
  ? resolve(__dirname, "../../../out/main/desktop-vision-worker.js")
  : resolve(__dirname, "../app.asar/out/main/desktop-vision-worker.js");
const vision = nativeConnection(() => spawn(process.execPath, [visionWorker], {
  windowsHide: true, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
}), 45000, { idleMs: 60000 });
let activeOperation;
let latestVisual;
const nativeChild = args => spawn(join(__dirname, "AgentOS.Computer.exe"), args, {
  windowsHide: true, stdio: ["pipe", "pipe", "inherit"],
});
function forgetObservation() { latestVisual = undefined; session.invalidate(); }
function revoke() { activeOperation?.abort(); forgetObservation(); vision.close(); driver.close(); }
const standard = nativeConnection(() => nativeChild([String(process.pid)]), 15000, {onRevoke:revoke});
const driver = windowDriver(standard, (id, onExit) => {
  let launched = false;
  return nativeConnection(() => {
    if (launched) throw Error("窗口授权已结束。请重新观察目标窗口。");
    launched = true;
    return nativeChild(["--authorize-window",String(process.pid),id]);
  }, 15000, {onRevoke:revoke,onExit});
}, forgetObservation);

async function request(op, args, signal) {
  if (op !== "click") return driver.request(op,args,signal);
  let heldHover = false;
  async function clickRequest(name, params, token) {
    try { return await driver.request(name, params, token); }
    catch (err) {
      if (err.code === "hover_changed_before_press") heldHover = true;
      throw err;
    }
  }
  try {
    return await clickWithObservation({request:clickRequest,observePixels:readVisual}, args, latestVisual, signal);
  } finally {
    latestVisual = undefined;
    // Cleanup cannot turn an already delivered press into a retryable failure.
    if (heldHover && !signal.aborted)
      await driver.request("finish_pointer", {windowId:args.windowId}, signal).catch(() => {});
  }
}

const token = z.string().min(1).max(160);
const windowId = token.describe("Opaque windowId from list_windows");
const observationId = token.describe("Use the returned observationId from this window's observation. A coordinate click can use inspect_window with vision, observe_visual, or observe_display_visual with windowId.");
const controlId = token.describe("Control id from that observation");
const session = createTargetSession({ request, observePixels: readVisual });

function register(name, description, inputSchema, readOnly, execute) {
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly } }, async (args, extra) => {
    if (name === "release_control") activeOperation?.abort();
    else if (activeOperation) return { isError:true, content:[{type:"text", text:"Another desktop operation is in progress. Wait for its result."}] };
    const owner = new AbortController();
    activeOperation = owner;
    const signal = AbortSignal.any([owner.signal, extra.signal]);
    try {
      if (!["act_on_target", "click", "scroll", "drag", "list_windows", "list_displays"].includes(name)) session.invalidate();
      const {data, image} = await execute(args, signal);
      if (signal.aborted && ["act_on_target","scroll","drag"].includes(name) && data?.executed) {
        const receipt = {executed:true, windowId:data.windowId, targetId:data.targetId, via:data.via, verification:{status:"interrupted"}};
        return {content:[{type:"text", text:JSON.stringify(receipt)}]};
      }
      signal.throwIfAborted();
      const content = [{type:"text", text:JSON.stringify(data)}];
      if (image) content.push(image);
      return {content};
    } catch (error) {
      const detail = ["act_on_target","scroll","drag"].includes(name) && signal.aborted
        ? "Action interrupted without a confirmed result. Inspect the current state before retrying."
        : error.message;
      return { isError:true, content:[{ type:"text", text:detail }] };
    } finally {
      if (activeOperation === owner) activeOperation = undefined;
    }
  });
}

function tool(name, description, inputSchema, readOnly = false) {
  register(name, description, inputSchema, readOnly, async (args, signal) => ({
    data: await driver.request(name, args, signal),
  }));
}

tool("list_windows", "Enumerate visible Windows desktop windows with title, process, screen bounds and foreground state.", {}, true);
tool("list_displays", "List Windows displays and their physical screen bounds, without capturing pixels.", {}, true);
tool("observe_window", "Read the window's UI Automation controls, supported patterns and physical screen bounds. Use nextCursor for another page.", { windowId, cursor: token.optional() }, true);
const region = z.object({
  x: z.number().int().nonnegative(), y: z.number().int().nonnegative(),
  width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
}).strict().describe("Crop in physical pixels relative to the top-left of the selected window or display.");
const visualOptions = { region: region.optional(), includeImage: z.boolean().default(false) };
const captureSource = z.enum(["auto", "compositor"]).optional().describe("Window capture backend. Auto retries a failed or blank window print using Windows Graphics Capture.");
async function readVisual(operation, { includeImage, ...target }, signal) {
  const owner = activeOperation;
  latestVisual = undefined;
  const capture = await driver.request(operation, target, signal);
  try {
    const { pngBase64, ...frame } = capture;
    const { jpegBase64, ...regions } = await vision.request("analyze", { ...frame, pngBase64, includeImage }, signal);
    signal.throwIfAborted();
    const observed = {...frame,...regions};
    if (observed.windowId && observed.observationId) latestVisual = observed;
    const image = includeImage ? {type:"image", mimeType:jpegBase64 ? "image/jpeg" : "image/png", data:jpegBase64 ?? pngBase64} : undefined;
    return { frame:observed, image };
  } finally {
    // MCP cancellation still releases a successfully acquired frame; explicit
    // release_control, hotkey and EOF dispose the lease separately.
    if (!owner.signal.aborted) await driver.request("finish_visual", {}, AbortSignal.timeout(5000));
  }
}
const rawVisual = operation => async (args, signal) => {
  const {frame, image} = await readVisual(operation, args, signal);
  return {data:frame, image};
};
register("observe_visual", "Read one window or crop with local OCR, optionally including its image. Returns absolute screen points and an observationId for click. If window capture is unavailable, call observe_display_visual with the same windowId.", { windowId, captureSource, ...visualOptions }, true, rawVisual("capture_window"));
register("observe_display_visual", "Read visible display pixels, including overlapping windows. For a coordinate click supply windowId: this captures the window's visible area on its monitor and returns a window-bound observationId. Optional region is display-relative and must be inside the window. Without windowId this is a read-only screen overview.", {windowId:windowId.optional(), displayId:token.optional(), ...visualOptions}, true, rawVisual("capture_display"));

const action = z.enum(["activate", "select", "set_value"]);
const searchText = z.string().trim().min(1).max(256);
register("inspect_window", "Inspect UI Automation and visual targets. query matches a name or automationId. auto adds local OCR if an actionable native match is missing or ambiguous. region is window-relative; output bounds are absolute. Use sceneId and targetId with act_on_target. A visual result also includes observationId for click and imageBounds for mapping image pixels. includeImage attaches that capture. Use nextCursor for more native controls.", {
  windowId, query:searchText.optional(), action:action.optional(), cursor:token.optional(),
  vision:z.enum(["auto","always","never"]).default("auto"), captureSource, ...visualOptions,
}, true, async (args, signal) => {
  const {view, image} = await session.inspect(args, signal);
  return {data:view, image};
});
register("act_on_target", "Perform one action on a target from the latest scene in its original window. activate uses Invoke or SelectionItem if supported, otherwise a checked foreground click on the captured pixels. set_value replaces literal text. Supply verifyText to independently look for expected visible text or a field value after the action. A missing confirmation warrants a fresh observation; do not repeat an input blindly.", {
  windowId, sceneId:token, targetId:token, action, value:z.string().max(32767).optional(), verifyText:searchText.optional(),
}, false, async (args, signal) => ({data:await session.act(args, signal)}));

tool("activate_window", "Restore and activate a desktop window. Checks that it actually received foreground focus.", { windowId });
register("authorize_window_control", "Ask the user and Windows for temporary administrator input access to exactly this window. Only for a requested desktop task when normal input is denied. Windows may show UAC. After approval inspect the window again before clicking. A declined grant ends authorization attempts for this window in this connection. Do not work around denied input with shell commands.", {windowId}, false,
  async (args, signal) => ({data:await driver.request("authorize_window",args,signal)}));
tool("invoke_control", "Invoke a button or command that advertises InvokePattern.", { windowId, observationId, controlId });
tool("set_value", "Replace an editable control's value through ValuePattern.", { windowId, observationId, controlId, value: z.string().max(32767) });
tool("select_item", "Select a list item advertising SelectionItemPattern.", { windowId, observationId, controlId });
register("click", "Click a physical screen point belonging to the observed foreground window. Use absolute pixel coordinates, including negative monitor offsets. For image coordinates add the capture bounds' x and y. If the window moves, obtain a new observation before clicking.", {
  windowId, observationId, x: z.number().int(), y: z.number().int(), button: z.enum(["left", "right", "double"]).default("left"),
}, false, async (args, signal) => ({data:await session.click(args, signal)}));
const screenPixel = z.number().int().min(-2147483648).max(2147483647);
register("scroll", "Scroll at an absolute physical screen point in the latest inspected foreground window. sceneId is consumed once. deltaY uses wheel detents: positive up, negative down; deltaX positive right, negative left. Each axis is limited to 20 detents; supply a nonzero axis. Returns independent readback; inspect again before another action. Administrator windows are unsupported.", {
  windowId, sceneId:token, x:screenPixel, y:screenPixel,
  deltaX:z.number().int().min(-20).max(20).default(0), deltaY:z.number().int().min(-20).max(20).default(0), verifyText:searchText.optional(),
}, false, async (args,signal) => ({data:await session.scroll(args,signal)}));
register("drag", "Drag the left mouse button between absolute physical screen points in the latest inspected foreground window. Both endpoints and the entire straight path must stay inside that window. sceneId is consumed once; inspect again afterwards. Cancellation releases the held button and never replays the gesture. Returns independent readback. Administrator windows are unsupported.", {
  windowId, sceneId:token, startX:screenPixel, startY:screenPixel, endX:screenPixel, endY:screenPixel,
  durationMs:z.number().int().min(1).max(2000).default(500), verifyText:searchText.optional(),
}, false, async (args,signal) => ({data:await session.drag(args,signal)}));
tool("type_text", "Type literal Unicode text into the focused field of the foreground window, using the system keyboard.", { windowId, text: z.string().min(1).max(8192) });
tool("shortcut", "Press a key or a chord in the foreground window, e.g. [\"CTRL\",\"S\"].", { windowId, keys: z.array(z.string().min(1).max(24)).min(1).max(5) });
tool("release_control", "Release this session's foreground input ownership when finished.", {});

function close() { activeOperation?.abort(); session.invalidate(); vision.close(); driver.close(); }
process.once("exit", close);
server.connect(new StdioServerTransport()).catch(error => { console.error(error.message); process.exitCode = 1; });
process.stdin.once("end", close);
