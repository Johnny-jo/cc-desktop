import { toProjectRel } from "./project-path";

/** Resolve an assistant's document reference against the session's workspace. */
export function markdownFileLink(root: string | null | undefined, href: string) {
  if (!root || !href || href.startsWith("#") || href.startsWith("?")) return null;
  let target = href.split(/[?#]/, 1)[0];
  try {
    if (/^file:/i.test(target)) {
      const url = new URL(target);
      if (url.hostname && url.hostname !== "localhost") return null;
      target = url.pathname;
    }
    target = decodeURIComponent(target).replace(/\\/g, "/");
  } catch { return null; }
  if (!target || target.startsWith("//") || /[\x00-\x1f]/.test(target)) return null;
  if (/^[a-z][\w+.-]*:/i.test(target) && !/^[a-z]:\//i.test(target)) return null;
  const fragment = href.match(/#L(\d+)(?:C\d+|-L?\d+)?$/i);
  const suffix = target.match(/:(\d+)(?::\d+)?$/);
  if (suffix) target = target.slice(0, -suffix[0].length);
  if (root.startsWith("/") && target.startsWith("/")) {
    const prefix = root.replace(/\/+$/, "") + "/";
    if (!target.startsWith(prefix)) return null;
    target = target.slice(prefix.length);
  }
  const rel = toProjectRel(root, target);
  if (!rel) return null;
  const line = Number(fragment?.[1] ?? suffix?.[1]);
  return { rel, line: Number.isSafeInteger(line) && line > 0 ? line : undefined };
}
