import { useEffect, useState, type RefObject } from "react";
import { createDizzyDetector } from "../lib/agent-mascot-motion";

export type AgentExpression = "normal" | "dizzy" | "stars" | "blush";
type IdleExpression = "look" | "blink" | "double-blink";
const idleExpressions: IdleExpression[] = ["look", "blink", "double-blink"];
const idleClasses = ["is-idle-looking", "is-idle-blinking", "is-idle-double-blinking"];

export function useAgentMascot(mark: RefObject<HTMLButtonElement | null>) {
  const [expression, setExpression] = useState<AgentExpression>("normal");

  useEffect(() => {
    const button = mark.current;
    const panel = button?.closest<HTMLElement>(".chat-panel");
    const orbit = button?.querySelector<HTMLElement>(".agent-orbit");
    if (!button || !panel || !orbit) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const detector = createDizzyDetector();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let expressionTimer: ReturnType<typeof setTimeout> | undefined;
    let current: AgentExpression = "normal";
    let lastIdle: IdleExpression | undefined;
    let dizzyAfter = 0;
    // A visible window still has a little life when another app has focus.
    const enabled = () => !reduced.matches && !document.hidden;
    const center = () => {
      button.style.setProperty("--look-x", "0px");
      button.style.setProperty("--look-y", "0px");
    };
    const stopIdle = () => {
      clearTimeout(idleTimer);
      button.classList.remove(...idleClasses);
    };
    const change = (next: AgentExpression) => {
      current = next;
      setExpression(next);
    };
    const scheduleIdle = (delay = 4500 + Math.random() * 4000) => {
      clearTimeout(idleTimer);
      if (!enabled()) return;
      idleTimer = setTimeout(() => {
        const choices = idleExpressions.filter((item) => item !== lastIdle);
        const next = choices[Math.floor(Math.random() * choices.length)];
        lastIdle = next;
        show("normal", next === "look" ? 2400 : next === "blink" ? 850 : 1100);
        if (next === "look") button.classList.add("is-idle-looking");
        if (next === "blink") button.classList.add("is-idle-blinking");
        if (next === "double-blink") button.classList.add("is-idle-double-blinking");
      }, delay);
    };
    const show = (next: AgentExpression, duration: number) => {
      stopIdle();
      clearTimeout(expressionTimer);
      center();
      change(next);
      expressionTimer = setTimeout(() => {
        button.classList.remove(...idleClasses);
        change("normal");
        scheduleIdle();
      }, duration);
    };
    const reacting = () => current === "dizzy" || current === "stars" || current === "blush";
    const active = () => {
      stopIdle();
      if (reacting()) return;
      clearTimeout(expressionTimer);
      change("normal");
      scheduleIdle();
    };
    const follow = (event: PointerEvent) => {
      if (event.pointerType === "touch" || !enabled()) return;
      active();
      if (reacting()) return;
      const now = performance.now();
      if (now >= dizzyAfter && detector.sample(event.clientX, event.clientY, now)) {
        dizzyAfter = now + 5000;
        show("dizzy", 2400);
        return;
      }
      const face = orbit.getBoundingClientRect();
      const area = panel.getBoundingClientRect();
      const clamp = (value: number) => Math.max(-1, Math.min(1, value));
      const range = Math.min(5, face.width * 0.12);
      button.style.setProperty("--look-x", `${clamp((event.clientX - face.left - face.width / 2) / Math.max(1, area.width * 0.45)) * range}px`);
      button.style.setProperty("--look-y", `${clamp((event.clientY - face.top - face.height / 2) / Math.max(1, area.height * 0.45)) * range}px`);
    };
    const typing = (event: Event) => {
      const input = event.target;
      if (!(input instanceof HTMLTextAreaElement) || !input.matches(".composer-input") || !enabled()) return;
      detector.reset();
      if (!input.value.trim()) { reset(); return; }
      // Hold the star eyes through an input burst, including IME composition.
      show("stars", 1800);
    };
    const pet = (event: MouseEvent) => {
      if (!enabled() || !(event.target instanceof Element)) return;
      // Pointer clicks pet the mascot itself; keyboard activation stays accessible.
      if (!event.target.closest(".agent-orbit") && event.detail !== 0) return;
      detector.reset();
      show("blush", 2000);
    };
    const leave = () => { detector.reset(); center(); active(); };
    const reset = () => {
      stopIdle();
      clearTimeout(expressionTimer);
      detector.reset();
      center();
      change("normal");
      scheduleIdle();
    };
    const blur = () => {
      detector.reset();
      center();
      // Keep the current idle/reaction timer alive rather than restarting it.
    };
    panel.addEventListener("pointermove", follow, { capture: true, passive: true });
    panel.addEventListener("pointerdown", active, true);
    panel.addEventListener("pointerleave", leave);
    panel.addEventListener("keydown", active);
    panel.addEventListener("input", typing, true);
    button.addEventListener("click", pet);
    document.addEventListener("visibilitychange", reset);
    window.addEventListener("blur", blur);
    reduced.addEventListener("change", reset);
    scheduleIdle(4000);
    return () => {
      stopIdle();
      clearTimeout(expressionTimer);
      panel.removeEventListener("pointermove", follow, true);
      panel.removeEventListener("pointerdown", active, true);
      panel.removeEventListener("pointerleave", leave);
      panel.removeEventListener("keydown", active);
      panel.removeEventListener("input", typing, true);
      button.removeEventListener("click", pet);
      document.removeEventListener("visibilitychange", reset);
      window.removeEventListener("blur", blur);
      reduced.removeEventListener("change", reset);
    };
  }, [mark]);
  return expression;
}
