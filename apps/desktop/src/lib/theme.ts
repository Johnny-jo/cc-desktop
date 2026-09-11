import type { PublicSettings } from "@claude-desktop/shared";

type ThemeChoice = NonNullable<PublicSettings["theme"]>;
let themeTransition: ReturnType<Document["startViewTransition"]> | undefined;
let themeRevision = 0;

function systemIsLight(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  );
}

/**
 * Reveal the new theme from the bottom-left corner. Initial load and reduced
 * motion apply immediately; a newer choice supersedes any pending snapshot.
 */
export function applyTheme(choice: ThemeChoice | undefined): void {
  const root = document.documentElement;
  const next = effectiveTheme(choice);
  const revision = ++themeRevision;
  themeTransition?.skipTransition();
  themeTransition = undefined;
  root.classList.remove("theme-reveal");
  const update = () => {
    if (revision === themeRevision) root.dataset.theme = next;
  };
  if (!root.dataset.theme || root.dataset.theme === next ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
      typeof document.startViewTransition !== "function") {
    update();
    return;
  }
  root.style.setProperty("--theme-reveal-radius", `${Math.ceil(Math.hypot(window.innerWidth, window.innerHeight))}px`);
  root.classList.add("theme-reveal");
  try {
    const transition = document.startViewTransition(update);
    themeTransition = transition;
    // Snapshot capture can be skipped (hidden windows or rapid toggles).
    void transition.ready.catch(() => undefined);
    void transition.finished.catch(update).finally(() => {
      if (revision !== themeRevision) return;
      themeTransition = undefined;
      root.classList.remove("theme-reveal");
      root.style.removeProperty("--theme-reveal-radius");
    });
  } catch {
    root.classList.remove("theme-reveal");
    root.style.removeProperty("--theme-reveal-radius");
    update();
  }
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
