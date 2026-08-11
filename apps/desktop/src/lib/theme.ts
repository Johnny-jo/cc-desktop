import type { PublicSettings } from "@claude-desktop/shared";

type ThemeChoice = NonNullable<PublicSettings["theme"]>;

function systemIsLight(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  );
}

/**
 * Apply the theme to the document root. "system" clears the attribute so the
 * CSS prefers-color-scheme media query decides.
 */
export function applyTheme(choice: ThemeChoice | undefined): void {
  const root = document.documentElement;
  if (choice === "dark" || choice === "light") {
    root.dataset.theme = choice;
    return;
  }
  // system / unset → follow OS, react to OS changes
  delete root.dataset.theme;
  root.dataset.theme = systemIsLight() ? "light" : "dark";
}

/** Titlebar toggle: flip the *effective* theme (system resolves first). */
export function nextTheme(current: ThemeChoice | undefined): ThemeChoice {
  const c = current ?? "system";
  const effective =
    c === "system" ? (systemIsLight() ? "light" : "dark") : c;
  return effective === "dark" ? "light" : "dark";
}

/** Theme shown right now (resolving system). */
export function effectiveTheme(
  choice: ThemeChoice | undefined,
): "dark" | "light" {
  if (choice === "dark" || choice === "light") return choice;
  return systemIsLight() ? "light" : "dark";
}

/** Listen to OS theme changes (used when choice is system). */
export function onSystemThemeChange(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const handler = () => cb();
  mq.addEventListener?.("change", handler);
  return () => mq.removeEventListener?.("change", handler);
}
