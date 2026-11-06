"use client";
import { useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { uid } from "@/lib/defaults";
import { splitSong } from "@/lib/lyricsSections";
import type { LyricSection } from "@/lib/types";
import Icon from "./Icon";
import { Modal } from "./ui";

/** A change of the sections; `link`: a section cut in two (keep) or merged into another: the slides follow it. */
export type LyricsChange = (lyrics: LyricSection[], link?: { from: string; to: string; keep: boolean }) => void;

/**
 * The lyrics of the release, in one place: the whole song pasted once and cut into sections, then the sections
 * as cards (renamed, edited, moved by drag and drop, cut in two at the cursor, merged with the next one).
 */
export default function LyricsEditor({ name, lyrics, song, onChange, onClose }: {
  name: string;
  lyrics: LyricSection[];
  /** The whole song pasted in the video studio: offered to start from. */
  song?: string;
  onChange: LyricsChange;
  onClose: () => void;
}) {
  const { t } = useT();
  const label = (n: number) => t("Part {n}", { n });
  const [paste, setPaste] = useState(() => (lyrics.length ? "" : song ?? ""));
  const [pasteOpen, setPasteOpen] = useState(!lyrics.length);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const areas = useRef(new Map<string, HTMLTextAreaElement>());

  const set = (id: string, patch: Partial<LyricSection>) => onChange(lyrics.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const cutSong = () => {
    const parts = splitSong(paste, label, t("Chorus"));
    if (!parts.length) return;
    // Sections of the same name keep their id: the slides that show them keep showing them.
    const used = new Set<string>();
    const next = parts.map((s) => {
      const same = lyrics.find((l) => !used.has(l.id) && l.name.trim().toLowerCase() === s.name.trim().toLowerCase());
      if (same) used.add(same.id);
      return { ...(same ?? {}), id: same?.id ?? uid(), name: s.name, text: s.text };
    });
    onChange(next);
    setPaste("");
    setPasteOpen(false);
  };
  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...lyrics];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    onChange(next);
  };
  /** Cuts a section at the cursor's line: what follows becomes a new section just after it. */
  const cut = (i: number) => {
    const s = lyrics[i];
    const el = areas.current.get(s.id);
    const at = el ? el.selectionStart : 0;
    const lines = s.text.split("\n");
    let line = s.text.slice(0, at).split("\n").length - 1;
    if (line <= 0) line = Math.ceil(lines.length / 2); // cursor at the start: in the middle
    const head = lines.slice(0, line).join("\n").replace(/\s+$/, ""), tail = lines.slice(line).join("\n").replace(/^\s*\n/, "").replace(/\s+$/, "");
    if (!head || !tail) return;
    const added: LyricSection = { id: uid(), name: `${s.name} (2)`, text: tail };
    onChange([...lyrics.slice(0, i), { ...s, text: head, times: undefined }, added, ...lyrics.slice(i + 1)], { from: s.id, to: added.id, keep: true });
  };
  const merge = (i: number) => {
    const a = lyrics[i], b = lyrics[i + 1];
    if (!b) return;
    onChange([...lyrics.slice(0, i), { ...a, text: `${a.text.replace(/\s+$/, "")}\n${b.text}`, times: undefined }, ...lyrics.slice(i + 2)], { from: b.id, to: a.id, keep: false });
  };
  const names = [t("Verse 1"), t("Chorus"), t("Verse 2"), t("Bridge"), t("Outro")];

  return (
    <Modal title={t("Lyrics · {name}", { name })} wide onClose={onClose}>
      <div className="stack lyrics-editor">
        <details className="sec" open={pasteOpen} onToggle={(e) => setPasteOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>{t("Paste the whole song")}</summary>
          <div className="body">
            <textarea className="input" rows={8} value={paste} onChange={(e) => setPaste(e.target.value)} aria-label={t("The whole song")}
              placeholder={t("Paste the lyrics. They are cut on the empty lines, or on tags like [Chorus] or [Verse 1].")} />
            <div className="row">
              <button className="btn sm primary" disabled={!paste.trim()} onClick={cutSong}>{lyrics.length ? t("Cut into sections (replaces them)") : t("Cut into sections")}</button>
              {song?.trim() && paste !== song && <button className="btn sm quiet" onClick={() => setPaste(song)}>{t("Use the lyrics of the video studio")}</button>}
            </div>
          </div>
        </details>

        <p className="muted xs">{t("Drag a section to move it. On a slide, tick the sections it shows.")}</p>
        <ol className="lyric-cards">
          {lyrics.map((l, i) => (
            <li key={l.id} className={"lyric-card" + (drag === i ? " dragging" : "") + (over === i && drag !== null && drag !== i ? " over" : "")}
              onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setOver(i); } }}
              onDrop={(e) => { e.preventDefault(); if (drag !== null) move(drag, i); setDrag(null); setOver(null); }}>
              <div className="row nowrap lyric-card-head">
                <span className="lyric-grip" draggable title={t("Drag to move")} aria-label={t("Drag to move")}
                  onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", l.id); }}
                  onDragEnd={() => { setDrag(null); setOver(null); }}>⠿</span>
                <span className="idx">{String(i + 1).padStart(2, "0")}</span>
                <input className="input grow" value={l.name} aria-label={t("Section name")} onChange={(e) => set(l.id, { name: e.target.value })} />
                <button className="btn quiet icon sm" style={{ transform: "rotate(180deg)" }} title={t("Move up")} aria-label={t("Move up")} disabled={i === 0} onClick={() => move(i, i - 1)}><Icon name="chevron" size={14} /></button>
                <button className="btn quiet icon sm danger" aria-label={t("Delete section")} title={t("Delete section")}
                  onClick={() => onChange(lyrics.filter((x) => x.id !== l.id))}><Icon name="trash" size={14} /></button>
              </div>
              <textarea className="input" rows={Math.min(10, Math.max(3, l.text.split("\n").length + 1))} aria-label={t("Lyrics")} value={l.text}
                ref={(el) => { if (el) areas.current.set(l.id, el); else areas.current.delete(l.id); }}
                onChange={(e) => set(l.id, { text: e.target.value })} />
              <div className="row lyric-card-tools">
                <button className="btn sm quiet" onClick={() => cut(i)} disabled={l.text.split("\n").length < 2}
                  title={t("Cut this section in two at the line of the cursor")}>{t("Cut at the cursor")}</button>
                {i < lyrics.length - 1 && <button className="btn sm quiet" onClick={() => merge(i)}>{t("Merge with the next one")}</button>}
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="modal-foot">
        <button className="btn left" onClick={() => onChange([...lyrics, { id: uid(), name: names[lyrics.length] ?? t("Section {n}", { n: lyrics.length + 1 }), text: "" }])}>
          <Icon name="plus" size={14} />{t("Add a section")}
        </button>
        <button className="btn primary" onClick={onClose}>{t("Done")}</button>
      </div>
    </Modal>
  );
}
