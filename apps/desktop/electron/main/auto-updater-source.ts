/** Decision for whether / how electron-updater may check. */
export type UpdateSource =
  | { kind: "feed"; url: string }
  | { kind: "packaged-yml" }
  | { kind: "disabled"; message: string };

export const NO_UPDATE_FEED_MESSAGE =
  "未配置更新源。在设置里填写更新地址，或打包时设置 CLAUDE_DESKTOP_UPDATE_URL。";

/**
 * electron-updater reads resources/app-update.yml when no setFeedURL() was called.
 * Packaged builds no longer ship that file unless CLAUDE_DESKTOP_UPDATE_URL was
 * set at pack time — calling checkForUpdates() then throws ENOENT.
 */
export function resolveUpdateSource(opts: {
  envUrl?: string | null;
  settingsUrl?: string | null;
  packagedYmlExists: boolean;
}): UpdateSource {
  const env = (opts.envUrl ?? "").trim();
  const settings = (opts.settingsUrl ?? "").trim();
  const raw = env || settings;
  if (raw) {
    return { kind: "feed", url: raw.endsWith("/") ? raw : `${raw}/` };
  }
  if (opts.packagedYmlExists) return { kind: "packaged-yml" };
  return { kind: "disabled", message: NO_UPDATE_FEED_MESSAGE };
}

export function renderAppUpdateYml(url: string): string {
  const base = url.trim();
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return [
    "provider: generic",
    `url: ${normalized}`,
    "updaterCacheDirName: cc-desktop-updater",
    "",
  ].join("\n");
}
