import React, { useEffect, useRef, useState } from "react";
import { createPhotoFlowMotion, createPhotoFlowPath, photoFlowImageIndex } from "../lib/photo-flow";
import { PHOTO_FLOW_IMAGES as photographs } from "../lib/photo-flow-images";
import type { PhotoFlowImage } from "@claude-desktop/shared";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";
import "./PhotoFlow.css";

/** Daytime new-chat backdrop. The composer stays in its own foreground layer. */
export function PhotoFlow({ english = false }: { english?: boolean }) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  const refreshRef = useRef<() => void>(() => {});
  const poolRef = useRef<PhotoFlowImage[]>(photographs);

  useEffect(() => {
    if (!hasDesktopApi("getPhotoFlowImages")) return;
    let disposed = false;
    let revision = 0;
    const load = async () => {
      const request = ++revision;
      try {
        const cached = await getDesktop().getPhotoFlowImages();
        if (disposed || request !== revision) return;
        const decoded = await Promise.all(cached.map(async photo => {
          if (!photo.src.startsWith("data:image/jpeg;base64,")) return null;
          try {
            const image = new Image();
            image.src = photo.src;
            await image.decode();
            return photo;
          } catch { return null; }
        }));
        if (!disposed && request === revision) {
          const ready = decoded.filter((photo): photo is PhotoFlowImage => photo !== null);
          poolRef.current = ready.length ? [...ready, ...photographs] : photographs;
        }
      } catch { /* Old preload, offline cache or decode failure: keep bundled photos. */ }
    };
    const unsubscribe = hasDesktopApi("onPhotoFlowUpdated") ? getDesktop().onPhotoFlowUpdated(() => { void load(); }) : undefined;
    void load();
    return () => { disposed = true; revision++; unsubscribe?.(); };
  }, []);

  useEffect(() => {
    pausedRef.current = paused;
    refreshRef.current();
  }, [paused]);

  useEffect(() => {
    const scene = sceneRef.current;
    const panel = scene?.parentElement;
    if (!scene || !panel || !photographs.length) return;
    const cards = Array.from(scene.querySelectorAll<HTMLElement>(".photo-flow-card"));
    const images = cards.map(card => card.querySelector("img")!);
    const displayed = cards.map((_, i) => photographs[i % photographs.length].id);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const systemLight = window.matchMedia("(prefers-color-scheme: light)");
    const motion = createPhotoFlowMotion();
    let width = 0;
    let height = 0;
    let cardWidth = 0;
    let path = createPhotoFlowPath(1, 1);
    let offset = 0;
    let lightElapsed = 0;
    let frame = 0;
    let previous = 0;
    let active = false;
    let disposed = false;
    let count = cards.length;
    let titleBounds = { x: 0, y: 0, width: 0, height: 0 };

    const draw = () => {
      cards.forEach((card, i) => {
        if (i >= count) return;
        const distance = i * path.length / count + offset;
        const point = path.at(distance);
        const depth = Math.max(0, Math.min(1, point.y / height));
        const scale = 0.78 + depth * 0.35;
        // Quiet the stretch passing behind the heading, including its caption.
        const dx = Math.max(0, Math.abs(point.x - titleBounds.x) - titleBounds.width / 2);
        const dy = Math.max(0, Math.abs(point.y - titleBounds.y) - titleBounds.height / 2);
        const clearance = Math.min(1, Math.hypot(dx / (cardWidth * 0.8), dy / (cardWidth * 0.55)));
        const fade = Math.max(0, Math.min(1, (point.y + cardWidth) / cardWidth, (height + cardWidth - point.y) / cardWidth));
        // Change only fully faded, offscreen cards; updates never replace a
        // photo in the middle of its visible lap (including reverse scrolling).
        const pool = poolRef.current;
        const photograph = pool[photoFlowImageIndex(i, Math.floor(distance / path.length), count, pool.length)];
        if (displayed[i] !== photograph.id && fade === 0) {
          images[i].src = photograph.src;
          images[i].style.objectPosition = photograph.position;
          card.style.aspectRatio = photograph.portrait ? "0.88" : "";
          images[i].title = photograph.author ? `Photo: ${photograph.author}` : "";
          displayed[i] = photograph.id;
        }
        // Each photo breathes independently over 48–64 seconds. The staggered
        // phases keep light and shade interleaved without a synchronized flash.
        const illumination = 0.74 + 0.14 * Math.sin(
          lightElapsed * Math.PI * 2 / (48 + (i % 3) * 8) + i * 2.399963,
        );
        // Keep subpixel precision at the slow idle speed; coarse scale/angle
        // rounding makes a card hold still and then visibly snap to a new size.
        card.style.transform = `translate3d(${point.x.toFixed(4)}px, ${point.y.toFixed(4)}px, 0) translate(-50%, -50%) rotate(${(point.tilt + (i % 3 - 1) * 3).toFixed(5)}deg) scale(${scale.toFixed(6)})`;
        card.style.opacity = ((0.7 + depth * 0.24) * illumination * (0.12 + clearance * 0.88) * fade).toFixed(5);
        card.style.zIndex = String(Math.round(depth * 100));
      });
    };
    const autoplay = () => !pausedRef.current && !reduced.matches;
    const tick = (now: number) => {
      frame = 0;
      if (disposed || !active || document.hidden) return;
      const dt = previous ? Math.min((now - previous) / 1000, 0.05) : 0;
      previous = now;
      if (autoplay()) lightElapsed += dt;
      // Keep completed laps so every bundled image can enter the ribbon, even
      // when the collection is larger than the number of visible card slots.
      offset += motion.step(dt, autoplay());
      draw();
      if (autoplay() || motion.moving()) frame = requestAnimationFrame(tick);
      else previous = 0;
    };
    const start = () => {
      if (!frame && active && !document.hidden) frame = requestAnimationFrame(tick);
    };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; previous = 0; };
    const resize = () => {
      const bounds = panel.getBoundingClientRect();
      const progress = offset / path.length;
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      path = createPhotoFlowPath(width, height);
      offset = progress * path.length;
      cardWidth = Math.max(88, Math.min(174, width * 0.145));
      count = Math.max(8, Math.min(cards.length, Math.round(path.length / (cardWidth * 1.6))));
      scene.style.setProperty("--photo-width", `${cardWidth}px`);
      cards.forEach((card, i) => { card.hidden = i >= count; });
      const title = panel.querySelector(".agent-welcome")?.getBoundingClientRect();
      const mark = panel.querySelector(".agent-wordmark")?.getBoundingClientRect();
      if (title && mark) titleBounds = { x: mark.left + mark.width / 2 - bounds.left,
        y: title.top + title.height / 2 - bounds.top, width: mark.width, height: title.height };
      draw();
    };
    const refresh = () => {
      stop();
      motion.reset();
      const theme = document.documentElement.dataset.theme;
      active = theme === "light" || (theme !== "dark" && systemLight.matches);
      panel.classList.toggle("has-photo-flow", active);
      scene.dataset.active = String(active);
      scene.dataset.reducedMotion = String(reduced.matches);
      if (active && !document.hidden) { resize(); if (autoplay()) start(); }
    };
    const wheel = (event: WheelEvent) => {
      if (!active || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
      // Preserve native scrolling and selection inside all chat controls/menus.
      if (event.target instanceof Element && event.target.closest(
        ".composer-shell, .agent-wordmark, button, input, textarea, select, [role='menu'], [role='listbox'], [contenteditable='true']",
      )) return;
      const bounds = panel.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      // Only the photo ribbon captures the wheel; the remaining pane stays native.
      if (!path.samples.some(point => Math.hypot(point.x - x, point.y - y) < cardWidth * 0.8)) return;
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (!delta) return;
      event.preventDefault();
      const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
      if (reduced.matches) {
        // Manual navigation remains available without inertia or ambient animation.
        offset += Math.max(-80, Math.min(80, pixels * 0.35));
        draw();
      } else { motion.push(pixels); start(); }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(panel);
    const heading = panel.querySelector(".agent-welcome");
    const composer = panel.querySelector(".chat-composer");
    if (heading) observer.observe(heading);
    if (composer) observer.observe(composer);
    const themeObserver = new MutationObserver(refresh);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    panel.addEventListener("wheel", wheel, { passive: false });
    document.addEventListener("visibilitychange", refresh);
    reduced.addEventListener("change", refresh);
    systemLight.addEventListener("change", refresh);
    refreshRef.current = refresh;
    refresh();
    return () => {
      disposed = true;
      stop();
      observer.disconnect();
      themeObserver.disconnect();
      panel.removeEventListener("wheel", wheel);
      document.removeEventListener("visibilitychange", refresh);
      reduced.removeEventListener("change", refresh);
      systemLight.removeEventListener("change", refresh);
      panel.classList.remove("has-photo-flow");
      refreshRef.current = () => {};
    };
  }, []);

  return <div ref={sceneRef} className="photo-flow">
    <div className="photo-flow-track" aria-hidden="true">
      {Array.from({ length: 13 }, (_, i) => {
        const photograph = photographs[i % photographs.length];
        return <div className={`photo-flow-card photo-flow-card-${i % 4}`} key={i}
          style={{ aspectRatio: photograph.portrait ? "0.88" : undefined }}>
          <img src={photograph.src} style={{ objectPosition: photograph.position }} alt="" draggable={false} decoding="async" />
        </div>;
      })}
    </div>
    <button type="button" className="photo-flow-toggle" aria-pressed={paused}
      aria-label={english ? (paused ? "Resume photo flow" : "Pause photo flow") : (paused ? "继续照片流动" : "暂停照片流动")}
      onClick={() => setPaused(value => !value)}>
      <svg viewBox="0 0 16 16" aria-hidden="true">{paused
        ? <path d="m6 3 7 5-7 5z" fill="currentColor" />
        : <path d="M5 4v8M11 4v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}</svg>
      <span>{english ? (paused ? "Resume flow" : "Pause flow") : (paused ? "继续流动" : "暂停流动")}</span>
    </button>
  </div>;
}
