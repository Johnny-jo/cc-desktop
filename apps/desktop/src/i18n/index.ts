import type { PublicSettings } from "@claude-desktop/shared";
import { en, type Messages } from "./en";
import { zh } from "./zh";

export type Locale = "zh" | "en";

function systemLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  const lang = (navigator.language || "").toLowerCase();
  return lang.startsWith("zh") ? "zh" : "en";
}

/** Resolve the effective locale from settings (system falls back to OS). */
export function effectiveLocale(
  choice: PublicSettings["locale"] | undefined,
): Locale {
  if (choice === "zh" || choice === "en") return choice;
  return systemLocale();
}

export function messagesFor(locale: Locale): Messages {
  return locale === "zh" ? zh : en;
}

export type { Messages };
export { en, zh };
