// Only the real Windows worker can grant the scoped connection. It independently
// checks the destination of every request, including requests forwarded here.
const scopedWrites = new Set(["activate_window","click","invoke_control","select_item"]);
const scopedReads = new Set(["capture_window","observe_window","observe_target_tree","finish_pointer"]);
const discovery = new Set(["list_windows","list_displays"]);
const standardPointerWrites = new Set(["scroll","drag"]);

function windowDriver(standard, openWindow, invalidate) {
  let scope;
  let frameOwner;
  let closed = false;
  const declined = new Set();

  function forget(current) {
    if (scope !== current) return;
    scope = undefined;
    if (frameOwner === current.io) frameOwner = undefined;
    invalidate();
  }

  async function release(signal) {
    const current = scope;
    if (!current) {
      frameOwner = undefined;
      invalidate();
      return standard.request("release_control", {}, signal);
    }
    forget(current);
    try {
      if (current.authorized) await current.io.request("release_control", {}, signal);
    } finally { current.io.close(); }
    return {released:true};
  }

  async function authorize(windowId, signal, checkAccess = false) {
    if (!/^[1-9a-f][0-9a-f]{0,15}:[1-9][0-9]*$/.test(windowId))
      throw Error("Use a windowId returned by list_windows.");
    if (declined.has(windowId)) throw Error("本连接的窗口授权已取消或未完成。请结束本次尝试，需要授权时由用户重连桌面操控。");
    if (scope?.authorized && scope.windowId === windowId) return {authorized:true,windowId};
    if (checkAccess) {
      const access = await standard.request("input_access",{windowId},signal);
      if (access.level === "compatible") return {authorized:false,required:false,windowId,detail:"此窗口可使用普通权限的桌面操控。"};
    }
    // Discard the old worker's pictures and return its input mutex before UAC.
    await release(signal);
    signal.throwIfAborted();
    if (closed) throw Error("Desktop connection closed.");
    invalidate();
    const current = {windowId, authorized:false};
    current.io = openWindow(windowId, () => forget(current));
    scope = current;
    try {
      const grant = await current.io.request("authorize_window", {windowId}, signal, 120000);
      signal.throwIfAborted();
      if (scope !== current || grant?.authorized !== true || grant.windowId !== windowId)
        throw Error("The Windows authorization did not complete for the requested window.");
      current.authorized = true;
      return grant;
    } catch (error) {
      declined.add(windowId);
      forget(current);
      current.io.close();
      throw error;
    }
  }

  async function afterAuthorization(op, args, signal) {
    await authorize(args.windowId, signal);
    if (op === "activate_window")
      return {...await scope.io.request(op, args, signal), authorizationChanged:true};
    throw Error("此窗口的管理员操控已授权。请重新观察该窗口，使用授权后的新编号执行点击或控件操作。此次未发送点击。");
  }

  async function request(op, args, signal) {
    if (closed) throw Error("Desktop control was stopped. Reconnect to resume.");
    if (op === "release_control") return release(signal);
    if (op === "authorize_window") return authorize(args.windowId, signal, true);
    if (discovery.has(op)) return standard.request(op, args, signal);
    if (op === "finish_visual") {
      const io = frameOwner;
      frameOwner = undefined;
      return io ? io.request(op, args, signal) : {finished:true};
    }
    const capturing = op === "capture_window" || op === "capture_display";
    if (scope && scope.windowId !== args.windowId) {
      if (!args.windowId) throw Error("当前已为指定窗口授权。请用 observe_visual 读取该窗口，或先 release_control 再读取整屏。");
      await release(signal);
    }
    let io = standard;
    if (scope) {
      if (standardPointerWrites.has(op)) throw Error("管理员窗口的临时授权尚不支持滚动或拖拽。请勿绕过窗口授权。");
      if (op === "capture_display") throw Error("此授权仅限窗口自身的画面。请使用 observe_visual 和已授权的 windowId。");
      if (!scope.authorized || !(scopedWrites.has(op) || scopedReads.has(op)))
        throw Error("此窗口的临时授权仅支持观察、激活、点击或选择控件。");
      io = scope.io;
    } else if (scopedWrites.has(op) || standardPointerWrites.has(op)) {
      const access = await standard.request("input_access", {windowId:args.windowId}, signal);
      if (standardPointerWrites.has(op)) {
        if (access.level === "higher" || (access.level === "unknown" && access.messageAccessDenied === true))
          throw Error("管理员窗口尚不支持滚动或拖拽。此操作不能通过提升窗口授权执行。");
        return standard.request(op,args,signal);
      }
      if (access.level === "higher" || (access.level === "unknown" && access.messageAccessDenied === true))
        return afterAuthorization(op, args, signal);
      try { return await standard.request(op, args, signal); }
      catch (error) {
        // Only a confirmed failure *before the press* is eligible. Never retry
        // a submitted press, partial double-click or uncertain transport error.
        if (access.level === "unknown" && error.code === "input_access_blocked")
          return afterAuthorization(op, args, signal);
        throw error;
      }
    }
    const value = await io.request(op, args, signal);
    if (capturing) frameOwner = io;
    return value;
  }

  return {request, close() {
    closed = true;
    const current = scope;
    if (current) { forget(current); current.io.close(); }
    frameOwner = undefined;
    standard.close();
  }};
}
module.exports = {windowDriver};
