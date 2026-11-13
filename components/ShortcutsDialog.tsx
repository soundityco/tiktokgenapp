"use client";
import { useT } from "@/lib/i18n";
import { Modal } from "./ui";

/** Every keyboard shortcut of the app, by where it works ("mod": ⌘ on a Mac, Ctrl elsewhere). Several keys: either
 *  one ("or"), or with `pair` one for each half of "what" ("previous / next": ← / →). Keep in step with the
 *  handlers: Studio (carousel, undo), VideoStudio (video), FullView (full screen). */
const SHORTCUTS: { part: string; keys: string[][]; what: string; pair?: boolean }[] = [
  { part: "Both studios", keys: [["F"]], what: "Full screen" },
  { part: "Both studios", keys: [["G"]], what: "TikTok zones (the red grid) on or off" },
  { part: "Both studios", keys: [["mod", "Z"]], what: "Undo" },
  { part: "Both studios", keys: [["⇧", "mod", "Z"], ["mod", "Y"]], what: "Redo" },
  { part: "Both studios", keys: [["Esc"]], what: "Close a window or the full screen" },
  { part: "Both studios", keys: [["mod"]], what: "Held while dragging a text, a photo or the video: no snapping to the middle" },
  { part: "Carousel", keys: [["R"]], what: "Generate" },
  { part: "Carousel", keys: [["E"]], what: "Edit the selected slide's photo (exposure, contrast…)" },
  { part: "Carousel", keys: [["Space"]], what: "Full screen (Space again closes it)" },
  { part: "Carousel", keys: [["←"], ["→"]], what: "Full screen: previous / next slide", pair: true },
  { part: "Video", keys: [["Space"]], what: "Play / pause" },
  { part: "Video", keys: [["←"], ["→"]], what: "Previous / next lyric line", pair: true },
  { part: "Video", keys: [["⌥", "←"], ["⌥", "→"]], what: "Move the official audio by −0.1 s / +0.1 s (not linked)", pair: true },
  { part: "Video", keys: [["I"], ["O"]], what: "Start / end of the segment at the playhead", pair: true },
];

/** The shortcuts, from the account menu. */
export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  const key = (k: string) => (k === "mod" ? (mac ? "⌘" : "Ctrl") : k === "Space" ? t("Space") : k);
  const parts = [...new Set(SHORTCUTS.map((s) => s.part))];
  return (
    <Modal title={t("Shortcuts")} onClose={onClose}>
      {parts.map((part) => (
        <section key={part} className="keys-part">
          <h3 className="keys-k">{t(part)}</h3>
          {SHORTCUTS.filter((s) => s.part === part).map((s) => (
            <div key={s.what + part} className="keys-row">
              <span className="keys-what">{t(s.what)}</span>
              <span className="keys-keys">
                {/* Several: "or" between two ways to do it, "/" between the keys of a pair (keys side by side are pressed together). */}
                {s.keys.map((combo, i) => (
                  <span key={i} className="keys-combo">
                    {i > 0 && <span className="keys-or">{s.pair ? "/" : t("or")}</span>}
                    {combo.map((k) => <kbd key={k}>{key(k)}</kbd>)}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </section>
      ))}
      <p className="muted xs">{t("Not while typing in a field. On a phone, the same actions are in the buttons.")}</p>
    </Modal>
  );
}
