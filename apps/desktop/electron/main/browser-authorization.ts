import path from "node:path";
import { createRequire } from "node:module";
import { app } from "electron";
import type { BrowserAuthorizationStatus, PlaywrightBrowser } from "@claude-desktop/shared";

type AuthorizationModule = {
  hasBrowserAuthorization(store: string, browser: PlaywrightBrowser, profile: string): boolean;
  saveBrowserAuthorization(store: string, browser: PlaywrightBrowser, profile: string, token: string): Promise<unknown>;
  removeBrowserAuthorization(store: string, browser: PlaywrightBrowser, profile: string): Promise<void>;
};

function authorizationScope(browser: PlaywrightBrowser, profile?: string) {
  const resources = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "../../resources");
  const requireResource = createRequire(__filename);
  const data = requireResource(path.join(resources, "playwright-mcp", "browser-data.cjs")) as {
    resolveBrowserProfile(browser: PlaywrightBrowser, options: { profileName?: string }): { profileName: string };
  };
  return {
    store: path.join(app.getPath("userData"), "browser-auth.json"),
    profileName: data.resolveBrowserProfile(browser, { profileName: profile }).profileName,
    auth: requireResource(path.join(resources, "playwright-mcp", "browser-auth.cjs")) as AuthorizationModule,
  };
}

export async function getBrowserAuthorizationStatus(browser: PlaywrightBrowser, profile?: string): Promise<BrowserAuthorizationStatus> {
  const { store, profileName, auth } = authorizationScope(browser, profile);
  return { browser, profileName, configured: auth.hasBrowserAuthorization(store, browser, profileName) };
}

export async function saveBrowserAuthorization(browser: PlaywrightBrowser, profile: string | undefined, token: string): Promise<BrowserAuthorizationStatus> {
  const { store, profileName, auth } = authorizationScope(browser, profile);
  await auth.saveBrowserAuthorization(store, browser, profileName, token);
  return { browser, profileName, configured: true };
}

export async function clearBrowserAuthorization(browser: PlaywrightBrowser, profile?: string): Promise<BrowserAuthorizationStatus> {
  const { store, profileName, auth } = authorizationScope(browser, profile);
  await auth.removeBrowserAuthorization(store, browser, profileName);
  return { browser, profileName, configured: false };
}
