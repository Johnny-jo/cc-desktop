import { getTranscriptFollowTarget, getTurnAnchorLayout, getTurnTrailingSpace } from "./chat-scroll";

type TurnState = { sessionId: string | null; userId: string | null; running: boolean; hasNewer: boolean };
type PagingDirection = "older" | "newer";
const PAGING_INPUT_TTL_MS = 500;

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
  let pagingDirection: PagingDirection | null = null;
  let pagingInputListener: ((direction: PagingDirection) => void) | null = null;
  let pagingUntil = 0;
  let touchY: number | null = null;
  let draggingScrollbar = false;
  let scrollbarArmed = false;
  let scrollbarUntil = 0;
  let pointerY = 0;
  let pointerScrollTop = 0;

  const recordPagingInput = (delta: number, notify = true) => {
    if (!delta) return;
    pagingDirection = delta < 0 ? "older" : "newer";
    pagingUntil = performance.now() + PAGING_INPUT_TTL_MS;
    if (notify) pagingInputListener?.(pagingDirection);
  };
  const clearPagingInput = () => {
    pagingDirection = null;
    scrollbarArmed = false;
  };
  const inputReachesList = (event: Event, delta: number) => {
    // A nested tool output/code block may consume the gesture itself.
    for (let node = event.target as HTMLElement | null; node && node !== list; node = node.parentElement) {
      if (node.scrollHeight <= node.clientHeight + 1) continue;
      const style = getComputedStyle(node);
      if (!/^(auto|scroll|overlay)$/.test(style.overflowY)) continue;
      if (style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none"
        || (delta < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1)) return false;
    }
    return true;
  };

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
    clearPagingInput();
    following = false;
    anchor = null;
    if (state?.hasNewer) setTail(0);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const onWheel = (event: Event) => {
    const wheel = event as WheelEvent;
    if (wheel.ctrlKey || wheel.deltaY === 0) return;
    pause();
    if (inputReachesList(event, wheel.deltaY)) recordPagingInput(wheel.deltaY);
  };
  const onKey = (event: Event) => {
    const key = event as KeyboardEvent;
    const target = key.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable=true]")) return;
    if (key.key === " " && target?.closest?.("button, summary, a[href], [role=button]")) return;
    if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(key.key)) return;
    if (key.defaultPrevented) return;
    pause();
    const delta = ["ArrowUp", "PageUp", "Home"].includes(key.key) || (key.key === " " && key.shiftKey) ? -1 : 1;
    if (inputReachesList(event, delta)) recordPagingInput(delta);
  };
  const onPointer = (event: Event) => {
    // A scrollbar drag targets the scroller itself; clicking a tool does not.
    if (event.target !== list) return;
    pause();
    const pointer = event as PointerEvent;
    const bounds = list.getBoundingClientRect();
    const gutter = Math.max(12, list.offsetWidth - list.clientWidth);
    if (pointer.clientX < bounds.right - gutter || pointer.clientX > bounds.right || !Number.isFinite(pointer.clientX)) return;
    draggingScrollbar = true;
    scrollbarArmed = true;
    scrollbarUntil = performance.now() + PAGING_INPUT_TTL_MS;
    pointerY = pointer.clientY;
    pointerScrollTop = list.scrollTop;
  };
  const onPointerMove = (event: Event) => {
    if (!draggingScrollbar) return;
    const nextY = (event as PointerEvent).clientY;
    const delta = nextY - pointerY;
    pointerY = nextY;
    scrollbarArmed = true;
    recordPagingInput(delta);
  };
  const onPointerEnd = () => {
    draggingScrollbar = false;
    // Native track clicks may start their smooth scroll after pointerup.
    scrollbarUntil = performance.now() + PAGING_INPUT_TTL_MS;
  };
  const onPointerCancel = () => { draggingScrollbar = false; scrollbarArmed = false; };
  const onTouchStart = (event: Event) => {
    pause();
    touchY = (event as TouchEvent).touches?.[0]?.clientY ?? null;
  };
  const onTouchMove = (event: Event) => {
    const nextY = (event as TouchEvent).touches?.[0]?.clientY;
    if (touchY !== null && nextY !== undefined && inputReachesList(event, touchY - nextY)) recordPagingInput(touchY - nextY);
    touchY = nextY ?? null;
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
  list.addEventListener("touchstart", onTouchStart, { passive: true });
  list.addEventListener("touchmove", onTouchMove, { passive: true });
  list.addEventListener("pointerdown", onPointer, { passive: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerup", onPointerEnd, { passive: true });
  window.addEventListener("pointercancel", onPointerCancel, { passive: true });
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
    onPagingInput(listener: (direction: PagingDirection) => void) {
      pagingInputListener = listener;
      return () => { if (pagingInputListener === listener) pagingInputListener = null; };
    },
    getPagingDirection() {
      // Pagination corrections and browser scroll anchoring also emit scroll.
      // Only a fresh user gesture may request another page; pause() consumes it
      // before loading so the corrected position cannot bounce to the other edge.
      const delta = list.scrollTop - pointerScrollTop;
      pointerScrollTop = list.scrollTop;
      if (disposed) return null;
      const now = performance.now();
      if (scrollbarArmed && (draggingScrollbar || now <= scrollbarUntil) && delta) recordPagingInput(delta, false);
      return performance.now() <= pagingUntil ? pagingDirection : null;
    },
    followTail(smooth = false) {
      if (disposed || state?.hasNewer) return;
      clearPagingInput();
      following = true;
      anchor = null;
      setTail(0);
      list.scrollTo({ top: Math.max(0, naturalHeight() - list.clientHeight), behavior: smooth ? "smooth" : "auto" });
    },
    dispose() {
      disposed = true;
      pagingInputListener = null;
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      list.removeEventListener("wheel", onWheel);
      list.removeEventListener("touchstart", onTouchStart);
      list.removeEventListener("touchmove", onTouchMove);
      list.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerCancel);
      list.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", resize);
      content.style.paddingTop = originalLead;
      spacer.style.height = originalTail;
    },
  };
}
