import { getTranscriptFollowTarget, getTurnAnchorLayout, getTurnTrailingSpace } from "./chat-scroll";

type TurnState = { sessionId: string | null; userId: string | null; running: boolean; hasNewer: boolean };

/** Owns only the main transcript's reading position and two temporary spacers. */
export function createChatScrollController(list: HTMLElement, content: HTMLElement, spacer: HTMLElement) {
  const originalLead = content.style.paddingTop;
  const originalTail = spacer.style.height;
  const composer = list.closest(".chat-panel")?.querySelector<HTMLElement>(".chat-composer");
  let state: TurnState | null = null;
  let following = true;
  let anchor: number | null = null;
  let leading = 0;
  let frame: number | null = null;
  let disposed = false;

  const naturalHeight = () => {
    const style = getComputedStyle(list);
    return content.offsetHeight + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  };
  const setTail = (height: number) => { spacer.style.height = `${height}px`; };
  const setLead = (height: number) => {
    leading = height;
    content.style.paddingTop = `${height}px`;
  };
  const pin = () => {
    if (disposed || !state || state.hasNewer) return;
    const height = naturalHeight();
    if (!following) {
      // Release only reserve that is no longer needed to preserve the reader's
      // current position. Removing it all would make the browser clamp upward.
      setTail(state.running ? getTurnTrailingSpace(list.scrollTop, list.clientHeight, height) : 0);
      return;
    }
    const target = getTranscriptFollowTarget({
      following, anchorScrollTop: anchor, viewportHeight: list.clientHeight, naturalHeight: height,
    });
    if (target === null) return;
    if (anchor !== null && target > anchor + 1) anchor = null;
    setTail(state.running && anchor !== null ? getTurnTrailingSpace(target, list.clientHeight, height) : 0);
    if (Math.abs(list.scrollTop - target) > 0.5) list.scrollTo({ top: target });
  };
  const schedulePin = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = null; pin(); });
  };
  const pause = () => {
    following = false;
    anchor = null;
    if (state?.hasNewer) setTail(0);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const onWheel = (event: Event) => {
    const wheel = event as WheelEvent;
    if (wheel.deltaY !== 0) pause();
  };
  const onKey = (event: Event) => {
    const key = event as KeyboardEvent;
    const target = key.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable=true]")) return;
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(key.key)) pause();
  };
  const onPointer = (event: Event) => {
    // A scrollbar drag targets the scroller itself; clicking a tool does not.
    if (event.target === list) pause();
  };
  const resize = () => {
    if (disposed || !following || !state || state.hasNewer) return;
    // The overlay may grow (attachments, progress buttons, multi-line draft).
    // Reposition only while still holding the original new-turn anchor.
    if (anchor !== null && state.running) alignTurn();
    schedulePin();
  };
  const alignTurn = () => {
    const status = list.querySelector<HTMLElement>("[data-current-turn-status]");
    if (!status) { anchor = null; return; }
    const top = list.getBoundingClientRect().top;
    const composerTop = composer?.getBoundingClientRect().top ?? top + list.clientHeight;
    const layout = getTurnAnchorLayout({
      viewportHeight: list.clientHeight,
      composerHeight: Math.max(0, top + list.clientHeight - composerTop),
      statusTop: list.scrollTop + status.getBoundingClientRect().top - top - leading,
      naturalHeight: naturalHeight() - leading,
    });
    setLead(layout.leadingSpace);
    setTail(layout.trailingSpace);
    anchor = layout.scrollTop;
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  observer?.observe(list);
  observer?.observe(content);
  if (composer) observer?.observe(composer);
  list.addEventListener("wheel", onWheel, { passive: true });
  list.addEventListener("touchstart", pause, { passive: true });
  list.addEventListener("pointerdown", onPointer, { passive: true });
  list.addEventListener("keydown", onKey);
  window.addEventListener("resize", resize);

  return {
    update(next: TurnState) {
      if (disposed) return;
      const previous = state;
      state = next;
      if (previous?.sessionId !== next.sessionId) {
        following = !next.hasNewer;
        anchor = null;
        setLead(0);
        setTail(0);
      }
      if (next.hasNewer) { pause(); return; }
      if (next.running && next.userId && (!previous?.running || previous.userId !== next.userId || previous.sessionId !== next.sessionId)) {
        following = true;
        alignTurn();
      } else if (!next.running) {
        anchor = null;
        setTail(0);
        // Keep the short turn's initial position; removing its top lead here
        // would throw the just-finished answer back to the top of the screen.
      }
      pin();
      schedulePin();
    },
    pause,
    followTail(smooth = false) {
      if (disposed || state?.hasNewer) return;
      following = true;
      anchor = null;
      setTail(0);
      list.scrollTo({ top: Math.max(0, naturalHeight() - list.clientHeight), behavior: smooth ? "smooth" : "auto" });
    },
    dispose() {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      list.removeEventListener("wheel", onWheel);
      list.removeEventListener("touchstart", pause);
      list.removeEventListener("pointerdown", onPointer);
      list.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", resize);
      content.style.paddingTop = originalLead;
      spacer.style.height = originalTail;
    },
  };
}
