"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The app's own tooltips, in place of the browser's (a delay, its grey look, a site's habit): every `title` of the page
 * is shown in the app's look, under its element (over it near the bottom of the screen), after a short wait — and at
 * once while going from one to the next, as in software. The `title` is moved to `data-tip` the first time the element
 * is hovered (the browser then has none to show); an element without a name of its own keeps it as its `aria-label`.
 * Mouse only (a finger has no hover). Never one that only repeats the text shown (`saysAgain`); none when turned off.
 */
const WAIT = 450, WARM = 600;
/** Turned off in the account menu (this device): no tooltips at all. */
export const TIPS_KEY = "tktgen-tips";
export const tipsOff = () => { try { return localStorage.getItem(TIPS_KEY) === "off"; } catch { return false; } };
const flat = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
/** Some text of the element cut by "…" (its tooltip then shows it whole). */
const clipped = (el: HTMLElement) => [el, ...Array.from(el.querySelectorAll<HTMLElement>("*")).slice(0, 40)]
  .some((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).textOverflow === "ellipsis");
/**
 * A tooltip that says again what the element already shows (a lyric line's clip, its text written on it; a button's own
 * label): not shown, unless that text is cut by "…". Read twice, the lyrics were hard to follow.
 */
const saysAgain = (el: HTMLElement, tip: string) => {
  const shown = flat(el.innerText || el.textContent || ""), said = flat(tip);
  if (shown.length < 3) return false;
  // (a short label inside a longer tip is no repeat: "Video" and its explanation)
  return (said === shown || shown.includes(said) || (shown.length >= 12 && said.includes(shown))) && !clipped(el);
};

export default function Tooltips() {
  const [tip, setTip] = useState<{ text: string; x: number; top: number; bottom: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (matchMedia("(hover: none)").matches) return;
    let timer = 0, on: HTMLElement | null = null, warmUntil = 0, shown = false;
    const hide = () => {
      window.clearTimeout(timer);
      if (shown) warmUntil = performance.now() + WARM;
      shown = false; on = null;
      setTip(null);
    };
    const show = (el: HTMLElement) => {
      const text = el.dataset.tip;
      if (!text || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      shown = true;
      setTip({ text, x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      const el = (e.target instanceof Element ? e.target.closest<HTMLElement>("[title], [data-tip]") : null);
      if (el === on) return;
      const was = shown;
      window.clearTimeout(timer);
      if (was) warmUntil = performance.now() + WARM;
      shown = false; on = null; setTip(null);
      if (!el) return;
      const title = el.getAttribute("title");
      if (title !== null) {
        if (title) el.dataset.tip = title; else delete el.dataset.tip;
        el.removeAttribute("title");
        if (title && !el.getAttribute("aria-label") && !el.textContent?.trim()) el.setAttribute("aria-label", title);
      }
      if (!el.dataset.tip || tipsOff() || saysAgain(el, el.dataset.tip)) return;
      on = el;
      timer = window.setTimeout(() => { if (on === el) show(el); }, performance.now() < warmUntil ? 0 : WAIT);
    };
    const away = () => hide();
    window.addEventListener("pointerover", over, true);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", away, true);
    window.addEventListener("wheel", away, { capture: true, passive: true });
    window.addEventListener("blur", away);
    document.documentElement.addEventListener("pointerleave", away);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerover", over, true);
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", away, true);
      window.removeEventListener("wheel", away, { capture: true } as EventListenerOptions);
      window.removeEventListener("blur", away);
      document.documentElement.removeEventListener("pointerleave", away);
    };
  }, []);

  // Kept on the screen: under its element, over it when there is no room below, never past an edge.
  useLayoutEffect(() => {
    const b = box.current;
    if (!tip || !b) { setPlace(null); return; }
    const w = b.offsetWidth, h = b.offsetHeight;
    const below = tip.bottom + 6 + h <= window.innerHeight - 8;
    setPlace({ left: Math.max(8, Math.min(tip.x - w / 2, window.innerWidth - w - 8)), top: below ? tip.bottom + 6 : Math.max(8, tip.top - 6 - h) });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={box} className="tip" role="tooltip" style={place ? { left: place.left, top: place.top } : { left: -9999, top: -9999 }}>{tip.text}</div>,
    document.body,
  );
}
