'use strict';

// The bundled Playwright server supplies resolved viewport coordinates before it
// dispatches automated input. Native DOM pointer events cannot identify the source.
function observeAutomationPointer(context, { isActive = () => true } = {}) {
  const connection = context._connection;
  if (typeof connection?.toImpl !== 'function') throw new Error('AgentOS 自动化指针需要内置的本机浏览器连接。');
  const scope = connection.toImpl(context);
  let disposed = false;
  const listener = {
    async onBeforeInputAction(progress, source, point) {
      if (disposed || !isActive() || source?.attribution?.context !== scope ||
          !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
      try {
        const page = context.pages().find(candidate => connection.toImpl(candidate) === source.attribution.page);
        if (!page) return;
        const update = page.evaluate(value => {
          window.dispatchEvent(new CustomEvent('agentos-automation-pointer', { detail: value }));
        }, { x: point.x, y: point.y, pressed: /click|tap|mouseDown/i.test(progress.metadata?.method ?? '') });
        await (typeof progress.race === 'function' ? progress.race(update) : update);
      } catch { /* A navigation or cancellation may discard the decorative update. */ }
    },
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    scope.instrumentation.removeListener(listener);
    context.off('close', dispose);
  }
  scope.instrumentation.addListener(listener, scope);
  context.once('close', dispose);
  return dispose;
}

module.exports = { observeAutomationPointer };
