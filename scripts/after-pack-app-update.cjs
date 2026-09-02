/**
 * electron-builder afterPack: bake a resolved app-update.yml into the
 * unpacked app when CLAUDE_DESKTOP_UPDATE_URL is set at pack time.
 *
 * electron-builder only emits this file when `publish` is configured.
 * We keep publish blank in electron-builder.yml so a missing/unexpanded
 * env var cannot ship as a literal "${env.CLAUDE_DESKTOP_UPDATE_URL}".
 *
 * If the env is unset, do nothing — runtime treats a missing yml as
 * "updates disabled" instead of ENOENT.
 */
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
  const raw = (process.env.CLAUDE_DESKTOP_UPDATE_URL ?? "").trim();
  if (!raw) {
    console.log(
      "afterPack: CLAUDE_DESKTOP_UPDATE_URL unset — not writing app-update.yml",
    );
    return;
  }
  const url = raw.endsWith("/") ? raw : `${raw}/`;
  const dest = path.join(context.appOutDir, "resources", "app-update.yml");
  const body = [
    "provider: generic",
    `url: ${url}`,
    "updaterCacheDirName: cc-desktop-updater",
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body, "utf8");
  console.log(`afterPack: wrote ${dest}`);
  console.log(`  url: ${url}`);
};
