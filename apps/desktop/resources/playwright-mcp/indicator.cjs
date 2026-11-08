// Serialized into controlled pages; it never moves the operating system cursor.
module.exports = function installControlIndicator({ label = "AgentOS：浏览器会话" } = {}) {
  window.__agentOSDisposeIndicator?.();
  if (window !== window.top) return;
  const host = document.createElement("div");
  host.style.cssText = "all:initial!important;position:fixed!important;inset:12px 12px auto auto!important;z-index:2147483647!important;width:max-content!important;max-width:calc(100vw - 24px)!important;pointer-events:auto!important;color-scheme:light!important;";
  const root = host.attachShadow({ mode: "closed" });
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:9px;padding:6px 7px 6px 12px;border-radius:12px;background:#17252c;color:white;box-shadow:0 2px 12px #0004;font:500 13px/20px system-ui,'Microsoft YaHei',sans-serif;white-space:nowrap;";
  const dot = document.createElement("span");
  dot.style.cssText = "width:7px;height:7px;background:#6ee7bb;border-radius:50%;";
  const title = document.createElement("span");
  title.textContent = label;
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "取消控制";
  button.style.cssText = "font:inherit;padding:3px 9px;color:#16272b;background:#fff;border:0;border-radius:7px;cursor:pointer;";
  bar.append(dot, title, status, button);
  root.append(bar);

  const pointer = document.createElement("div");
  pointer.setAttribute("aria-hidden", "true");
  pointer.style.cssText = "all:initial!important;position:fixed!important;left:48px!important;top:80px!important;width:22px!important;height:30px!important;z-index:2147483647!important;pointer-events:none!important;transition:left 80ms linear,top 80ms linear!important;";
  const pointerRoot = pointer.attachShadow({ mode: "closed" });
  const halo = document.createElement("div");
  halo.setAttribute("data-agentos-pointer-halo", "");
  halo.style.cssText = "position:absolute;left:-10px;top:-6px;width:38px;height:38px;border-radius:50%;pointer-events:none;background:radial-gradient(circle,rgba(255,255,255,.52) 0%,rgba(255,255,255,.24) 38%,rgba(0,0,0,.12) 60%,transparent 76%);filter:blur(3px);";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 32");
  svg.style.cssText = "position:relative;width:22px;height:30px;filter:drop-shadow(0 1px 1.5px #0006)";
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrow.setAttribute("d", "M2 1L21 19L12 20L8 29L2 1Z");
  arrow.setAttribute("fill", "#111111");
  arrow.setAttribute("stroke", "#fff");
  arrow.setAttribute("stroke-width", "1.25");
  svg.append(arrow);
  const tag = document.createElement("span");
  tag.textContent = "AgentOS";
  tag.style.cssText = "position:absolute;left:15px;top:23px;padding:1px 4px;border-radius:4px;background:#17252c;color:white;font:10px/14px system-ui,sans-serif;white-space:nowrap;";
  pointerRoot.append(halo, svg, tag);

  let frontDialog;
  let cancelled = false;
  let disposed = false;
  let running = false;
  let refreshTimer;
  let refreshing = false;
  let cancelRequested = false;
  let siteTitle = document.title;
  const prefix = `${label}｜`;

  function syncTitle() {
    if (disposed) return;
    const current = document.title;
    siteTitle = current.startsWith(prefix) ? current.slice(prefix.length) : current;
    const next = cancelled ? siteTitle : prefix + siteTitle;
    if (current !== next) document.title = next;
  }

  // Top-layer dialogs and fullscreen elements otherwise cover fixed overlays.
  function place() {
    if (disposed) return;
    if (!frontDialog?.matches("dialog:modal")) {
      const dialogs = document.querySelectorAll("dialog:modal");
      frontDialog = dialogs[dialogs.length - 1];
    }
    const parent = frontDialog || document.fullscreenElement || document.documentElement;
    if (!parent) return;
    if (host.parentNode !== parent) parent.append(host);
    if (!cancelled && pointer.parentNode !== parent) parent.append(pointer);
  }

  function show(active) {
    if (disposed) return;
    if (!active) cancelled = true;
    host.dataset.agentosBrowserControl = cancelled ? "cancelled" : "active";
    pointer.dataset.agentosBrowserPointer = cancelled ? "cancelled" : "active";
    status.textContent = cancelled ? "已取消控制" : cancelRequested ? "正在取消控制" : running ? "控制中" : "等待操作";
    dot.style.background = cancelled ? "#a9b2b7" : "#6ee7bb";
    button.hidden = cancelled;
    button.disabled = cancelRequested;
    host.style.setProperty("pointer-events", cancelled ? "none" : "auto", "important");
    if (cancelled) {
      clearTimeout(refreshTimer);
      pointer.remove();
    }
    place();
    syncTitle();
  }

  function scheduleRefresh(delay) {
    clearTimeout(refreshTimer);
    if (!cancelled && !disposed) refreshTimer = setTimeout(() => { void refresh(); }, delay);
  }

  async function refresh() {
    if (cancelled || disposed || refreshing) return;
    clearTimeout(refreshTimer);
    refreshing = true;
    const cancelling = cancelRequested;
    try {
      const state = await window.__agentOSBrowserControl(cancelling ? "cancel" : "status");
      if (typeof state?.active !== "boolean") throw new Error("Browser control status is unavailable");
      running = Boolean(state.running) && !cancelRequested;
      show(state.active);
      if (cancelRequested && state.active) scheduleRefresh(1000);
    } catch {
      // Transport gaps are not user cancellation. Keep the cursor parked while reconnecting.
      running = false;
      if (!cancelled && !disposed) {
        status.textContent = cancelRequested ? "正在取消，等待连接" : "等待连接";
        scheduleRefresh(1000);
      }
    } finally {
      refreshing = false;
      if (cancelRequested && !cancelling) scheduleRefresh(0);
    }
  }

  function draw(point) {
    if (cancelled || disposed || cancelRequested || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
    pointer.style.setProperty("left", `${point.x}px`, "important");
    pointer.style.setProperty("top", `${point.y}px`, "important");
    if (point.pressed) {
      void svg.animate([{ scale: "1" }, { scale: ".75" }, { scale: "1" }], { duration: 260 });
    }
  }
  const automationPointer = event => { draw(event.detail); };
  const agentAction = event => {
    running = Boolean(event.detail?.running) && !cancelRequested;
    if (!cancelled && !disposed) status.textContent = cancelRequested ? "正在取消控制" : running ? "控制中" : "等待操作";
  };
  window.addEventListener("agentos-automation-pointer", automationPointer);
  window.addEventListener("agentos-agent-action", agentAction);

  button.addEventListener("click", event => {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopPropagation();
    cancelRequested = true;
    running = false;
    show(true);
    void refresh();
  });
  const observer = new MutationObserver(() => { place(); syncTitle(); });
  observer.observe(document, {
    subtree: true, childList: true, characterData: true,
  });
  const toggle = event => {
    if (!(event.target instanceof HTMLDialogElement)) return;
    if (event.target.matches(":modal")) frontDialog = event.target;
    place();
  };
  document.addEventListener("toggle", toggle, true);
  window.addEventListener("pageshow", refresh);
  const controlChange = event => {
    if (event.detail?.active === false) show(false);
    else void refresh();
  };
  window.addEventListener("agentos-control-change", controlChange);
  document.addEventListener("fullscreenchange", place);
  const dispose = () => {
    show(false);
    disposed = true;
    observer.disconnect();
    document.removeEventListener("toggle", toggle, true);
    document.removeEventListener("fullscreenchange", place);
    window.removeEventListener("pageshow", refresh);
    window.removeEventListener("agentos-control-change", controlChange);
    window.removeEventListener("agentos-agent-action", agentAction);
    window.removeEventListener("agentos-automation-pointer", automationPointer);
    host.remove();
    pointer.remove();
    if (window.__agentOSDisposeIndicator === dispose) delete window.__agentOSDisposeIndicator;
  };
  window.__agentOSDisposeIndicator = dispose;
  show(true);
  void refresh();
};
