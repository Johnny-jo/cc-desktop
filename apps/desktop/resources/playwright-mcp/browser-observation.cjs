'use strict';

const { withTimeout } = require('./control-runtime.cjs');

const normalizeText = value => value.replace(/\s+/g, ' ').trim();

async function verifyPage(page, input, { isActive = () => true, signal } = {}) {
  const expectedText = typeof input.text === 'string' ? normalizeText(input.text) : undefined;
  const deadline = Date.now() + Math.min(10000, Math.max(0, input.timeoutMs ?? 2000));
  const base = () => ({ page: page?._guid ?? null, url: page?.url() ?? null, observedAt: new Date().toISOString() });
  if (!page || page.isClosed() || (!input.url && !expectedText)) return { ...base(), status: 'unavailable' };
  while (true) {
    if (!isActive() || signal?.aborted) return { ...base(), status: 'unavailable' };
    let timer;
    try {
      const sample = await Promise.race([
        page.evaluate(() => {
          const parts = [];
          const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const parent = node.parentElement;
            if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) continue;
            if (!parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            if ([...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) parts.push(node.textContent);
          }
          return { url: location.href, title: document.title, text: parts.join(' ') };
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Observation timed out')), 1000); }),
      ]);
      if (!isActive() || signal?.aborted) return { ...base(), status: 'unavailable' };
      const conditions = {
        ...(input.url ? { url: sample.url === input.url } : {}),
        ...(expectedText ? { text: normalizeText(sample.text).includes(expectedText) } : {}),
      };
      const result = { ...base(), url: sample.url, title: sample.title, conditions,
        status: Object.values(conditions).every(Boolean) ? 'observed' : 'not_observed' };
      if (result.status === 'observed' || Date.now() >= deadline) return result;
    } catch {
      return { ...base(), status: 'unavailable' };
    } finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  }
}

function imageDimensions(data) {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    for (let at = 2; at + 8 < data.length;) {
      if (data[at++] !== 0xff) break;
      const marker = data[at++];
      if (marker >= 0xc0 && marker <= 0xc3) return { width: data.readUInt16BE(at + 5), height: data.readUInt16BE(at + 3) };
      at += data.readUInt16BE(at);
    }
  }
  if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const type = data.toString('ascii', 12, 16);
    if (type === 'VP8X') return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (type === 'VP8 ') return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (type === 'VP8L') {
      const bits = data.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

function withScreenshotMetadata(tool) {
  if (tool.schema.name !== 'browser_take_screenshot') return tool;
  return { ...tool, handle: async (context, input, response, ...rest) => {
    let pixels;
    const page = context.currentTab()?.page;
    const readMetadata = async () => {
      try {
        return await withTimeout(() => page?.evaluate(() => ({ url: location.href, document: performance.timeOrigin,
          width: innerWidth, height: innerHeight, devicePixelRatio })));
      } catch { return undefined; }
    };
    const before = await readMetadata();
    const decorated = new Proxy(response, { get(target, key) {
      if (key === 'addFileResult') return async (file, data, ...args) => {
        if (Buffer.isBuffer(data)) pixels = imageDimensions(data);
        return target.addFileResult(file, data, ...args);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await tool.handle(context, input, decorated, ...rest);
    const after = await readMetadata();
    const stable = before && after && before.url === after.url && before.document === after.document &&
      before.width === after.width && before.height === after.height && before.devicePixelRatio === after.devicePixelRatio;
    response.addTextResult(JSON.stringify({ screenshot: {
      status: stable ? 'available' : 'unavailable', page: page?._guid ?? null,
      ...(stable ? { url: before.url, viewport: { width: before.width, height: before.height }, devicePixelRatio: before.devicePixelRatio } : {}),
      pixels, scale: input.scale ?? 'css', observedAt: new Date().toISOString(),
    } }));
  } };
}

module.exports = { verifyPage, withScreenshotMetadata };
