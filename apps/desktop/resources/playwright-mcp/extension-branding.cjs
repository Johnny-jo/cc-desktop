'use strict';

const extensionOrigin = 'chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm';

async function renameSessionTabGroup(context, label, { timeoutMs = 3000, pollMs = 50 } = {}) {
  const page = context.pages().find(candidate => {
    try {
      const url = new URL(candidate.url());
      return url.protocol === 'chrome-extension:' && url.host === extensionOrigin.slice('chrome-extension://'.length) && url.pathname === '/connect.html';
    } catch { return false; }
  });
  if (!page) return false;
  try {
    return await page.evaluate(async ({ origin, title, timeout, poll }) => {
      if (location.origin !== origin || location.pathname !== '/connect.html' ||
          typeof chrome?.tabs?.getCurrent !== 'function' || typeof chrome?.tabGroups?.update !== 'function') return false;
      const deadline = performance.now() + timeout;
      const expected = `Playwright · ${title}`;
      let currentTabId;
      do {
        const tab = await chrome.tabs.getCurrent();
        if (!Number.isInteger(tab?.id)) return false;
        currentTabId ??= tab.id;
        if (tab.id !== currentTabId) return false;
        if (Number.isInteger(tab.groupId) && tab.groupId >= 0) {
          const group = await chrome.tabGroups.get(tab.groupId);
          if (group.title === title) return true;
          const suffix = group.title?.startsWith(expected) ? group.title.slice(expected.length) : undefined;
          if (suffix === '' || /^ \((?:[2-9]|[1-9]\d+)\)$/.test(suffix ?? '')) {
            const current = await chrome.tabs.getCurrent();
            if (current?.id !== currentTabId || current.groupId !== tab.groupId) return false;
            await chrome.tabGroups.update(tab.groupId, { title });
            return true;
          }
        }
        await new Promise(resolve => setTimeout(resolve, poll));
      } while (performance.now() < deadline);
      return false;
    }, { origin: extensionOrigin, title: label, timeout: Math.max(0, Math.min(timeoutMs, 3000)), poll: Math.max(1, pollMs) });
  } catch { return false; }
}

module.exports = { renameSessionTabGroup };
