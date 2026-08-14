import { useAppStore } from "../state/store";
import { effectiveLocale, messagesFor, type Locale, type Messages } from "./index";

/**
 * Resolve the current UI locale and message dictionary from app settings.
 * Components read text via `t.section.key` so copy stays in one place.
 */
export function useI18n(): { locale: Locale; t: Messages } {
  const settings = useAppStore((s) => s.settings);
  const locale = effectiveLocale(settings?.locale);
  return { locale, t: messagesFor(locale) };
}
