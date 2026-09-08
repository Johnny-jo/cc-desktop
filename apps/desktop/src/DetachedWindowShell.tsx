import React, { lazy, Suspense, useEffect, useState } from "react";
import { ErrorBanner } from "./components/ErrorBanner";
import { SettingsPresence } from "./components/SettingsPresence";
import { WindowControls } from "./components/WindowControls";
import { ThemeToggle } from "./components/LayoutChrome";
import { OnboardingModal } from "./components/OnboardingModal";
import { RoomPermAskModal } from "./components/RoomPermAskModal";
import { getDesktop } from "./lib/desktop-api";
import {
  applyTheme,
  effectiveTheme,
  nextTheme,
  onSystemThemeChange,
} from "./lib/theme";
import {
  bootstrapStore,
  flushAllTranscripts,
  setTheme,
  useAppStore,
} from "./state/store";

const SettingsDrawer = lazy(() =>
  import("./components/SettingsDrawer").then((module) => ({
    default: module.SettingsDrawer,
  })),
);

export function DetachedWindowShell({
  children,
}: {
  children: (openSettings: () => void) => React.ReactNode;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settings = useAppStore((state) => state.settings);
  const needsOnboarding = settings != null && !settings.hasToken;

  useEffect(() => {
    void bootstrapStore();
  }, []);

  useEffect(() => {
    const syncTheme = () => {
      applyTheme(settings?.theme);
      try {
        getDesktop()
          .notifyTheme(effectiveTheme(settings?.theme))
          .catch(() => undefined);
      } catch {
        // Browser/unit-test fallback.
      }
    };
    syncTheme();
    if (settings?.theme && settings.theme !== "system") return;
    return onSystemThemeChange(syncTheme);
  }, [settings?.theme]);

  useEffect(() => {
    const size = settings?.uiFontSize ?? 13;
    document.documentElement.style.setProperty("--ui-font-size", `${size}px`);
  }, [settings?.uiFontSize]);

  useEffect(() => {
    const locale =
      settings?.locale === "zh" || settings?.locale === "en"
        ? settings.locale
        : navigator.language?.toLowerCase().startsWith("zh")
          ? "zh"
          : "en";
    document.documentElement.dataset.locale = locale;
  }, [settings?.locale]);

  useEffect(() => {
    const flush = () => flushAllTranscripts();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, []);

  return (
    <div className="app app-detached">
      <div className="app-titlebar">
        <div className="titlebar-drag" aria-hidden />
        <ThemeToggle
          isLight={effectiveTheme(settings?.theme) === "light"}
          onToggle={() => void setTheme(nextTheme(settings?.theme))}
        />
        <WindowControls />
      </div>
      <ErrorBanner />

      <div className="workspace">
        <div className="main-row">
          <main className="panel panel-chat">
            {children(() => setSettingsOpen(true))}
          </main>
        </div>
      </div>

      <RoomPermAskModal />
      <OnboardingModal open={needsOnboarding} />
      <SettingsPresence open={settingsOpen}>
        <Suspense fallback={null}>
          <SettingsDrawer
            open
            onClose={() => setSettingsOpen(false)}
          />
        </Suspense>
      </SettingsPresence>
    </div>
  );
}
