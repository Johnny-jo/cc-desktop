import path from "node:path";
import { createRequire } from "node:module";
import { app } from "electron";
import type { BrowserExtensionSetupStatus, PlaywrightBrowser } from "@claude-desktop/shared";

type SetupModule = {
  prepareBrowserExtension(browser: PlaywrightBrowser, profile?: string): Promise<BrowserExtensionSetupStatus>;
  getBrowserExtensionStatus(browser: PlaywrightBrowser, profile?: string): Promise<BrowserExtensionSetupStatus>;
};

function setupModule(): SetupModule {
  const resources = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "../../resources");
  return createRequire(__filename)(path.join(resources, "playwright-mcp", "extension-setup.cjs")) as SetupModule;
}

export function prepareBrowserExtension(browser: PlaywrightBrowser, profile?: string): Promise<BrowserExtensionSetupStatus> {
  return setupModule().prepareBrowserExtension(browser, profile);
}

export function getBrowserExtensionStatus(browser: PlaywrightBrowser, profile?: string): Promise<BrowserExtensionSetupStatus> {
  return setupModule().getBrowserExtensionStatus(browser, profile);
}
