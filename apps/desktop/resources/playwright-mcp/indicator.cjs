// Serialized by Playwright into each document in this isolated browser context.
module.exports = function installControlIndicator() {
  if (window !== window.top) return;
  const host = document.createElement("div");
  host.setAttribute("data-agentos-browser-control", "");
  host.style.cssText = "all:initial!important;position:fixed!important;inset:12px 12px auto auto!important;z-index:2147483647!important;width:max-content!important;max-width:calc(100vw - 24px)!important;pointer-events:auto!important;color-scheme:light!important;";
  const root = host.attachShadow({ mode: "closed" });
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:9px;padding:6px 7px 6px 12px;border-radius:12px;background:#17252c;color:white;box-shadow:0 2px 12px #0004;font:500 13px/20px system-ui,'Microsoft YaHei',sans-serif;white-space:nowrap;";
  const dot = document.createElement("span");
  dot.style.cssText = "width:7px;height:7px;background:#6ee7bb;border-radius:50%;";
  const label = document.createElement("span");
  label.setAttribute("role", "status");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "取消控制";
  button.style.cssText = "font:inherit;padding:3px 9px;color:#16272b;background:#fff;border:0;border-radius:7px;cursor:pointer;";
  bar.append(dot, label, button);
  root.append(bar);

  // A modal dialog makes controls outside it inert, regardless of z-index.
  let frontDialog;
  function place() {
    if (!frontDialog?.matches("dialog:modal")) {
      const dialogs = document.querySelectorAll("dialog:modal");
      frontDialog = dialogs[dialogs.length - 1];
    }
    const parent = frontDialog || document.fullscreenElement || document.documentElement;
    if (parent && host.parentNode !== parent) parent.append(host);
  }
  let cancelled = false;
  function show(controlling) {
    if (!controlling) cancelled = true;
    const active = !cancelled;
    host.dataset.agentosBrowserControl = active ? "active" : "cancelled";
    label.textContent = active ? "AgentOS 正在控制中" : "AgentOS 已取消控制";
    dot.style.background = active ? "#6ee7bb" : "#a9b2b7";
    button.hidden = !active;
    host.style.setProperty("pointer-events", active ? "auto" : "none", "important");
    place();
  }
  async function refresh() {
    const active = await window.__agentOSBrowserControl("status");
    show(active);
  }
  button.addEventListener("click", async (event) => {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopPropagation();
    await window.__agentOSBrowserControl("cancel");
    show(false);
  });
  new MutationObserver(() => {
    if (!host.isConnected && label.textContent) place();
  }).observe(document, { subtree: true, childList: true });
  document.addEventListener("toggle", event => {
    if (!(event.target instanceof HTMLDialogElement)) return;
    if (event.target.matches(":modal")) frontDialog = event.target;
    place();
  }, true);
  void refresh();
  window.addEventListener("pageshow", refresh);
  window.addEventListener("agentos-control-change", refresh);
  document.addEventListener("fullscreenchange", place);
};
