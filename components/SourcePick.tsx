"use client";
import { useState } from "react";
import { byTagName, compareTexts, tagStep } from "@/lib/generate";
import { isReleaseTag } from "@/lib/themes";
import { useT } from "@/lib/i18n";
import { themeLabel } from "@/lib/themes";
import Icon from "./Icon";
import { TagChip } from "./ui";

/**
 * The pieces of a source card, the same in both studios (a slide's text or photo, a video's hook): one button, its
 * list and what is drawn from it; its menu: the list, its tags, then the texts (or photos) to pick one, opened on it.
 */

/** A source's tags, short: the ticked one ("Out now") or how many ("2 tags"), then how many are excluded
 *  ("1 excl."). Empty: the whole list. */
export function tagSummary(ticked: string[], not: string[], t: (k: string, v?: Record<string, string | number>) => string): string {
  const on = ticked.length === 1 ? themeLabel(ticked[0], t) : ticked.length ? t("{n} tags", { n: ticked.length }) : "";
  const off = not.length === 1 ? t("1 excl.") : not.length ? t("{n} excl.", { n: not.length }) : "";
  return [on, off].filter(Boolean).join(" · ");
}

/** What a source's button says after the list's name: its tags in short, then a glimpse of the one picked (the
 *  start of a text, a photo's name), cut by "…" with the rest. */
export function sourceSub(tags: string, picked?: string): string | undefined {
  const glimpse = picked?.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
  return [tags, glimpse].filter(Boolean).join(" · ") || undefined;
}

/** A list's tags as chips: All, then each one by name (a click ticks it, its − excludes it). */
export function TagChips({ groups, ticked, not, count, onChange }: {
  groups: { id: string; items: number[] }[]; ticked: string[]; not: string[]; count: number;
  onChange: (next: { tags: string[]; not: string[] }) => void;
}) {
  const { t } = useT();
  return (
    <div className="pick-chips" role="group" aria-label={t("Tags")}>
      <button className={"pick-chip" + (!ticked.length && !not.length ? " on" : "")} onClick={() => onChange({ tags: [], not: [] })}>{t("All ({n})", { n: count })}</button>
      {/* (the releases' own tags after the others, in their colour: the hooks kept for one release) */}
      {byTagName(groups, (g) => g.id, (id) => themeLabel(id, t)).map((g) => (
        <TagChip key={g.id || "other"} label={themeLabel(g.id, t)} count={g.items.length} release={isReleaseTag(g.id)}
          state={ticked.includes(g.id) ? "on" : not.includes(g.id) ? "not" : undefined}
          onTick={() => onChange(tagStep(ticked, not, g.id, "tick"))} onNot={() => onChange(tagStep(ticked, not, g.id, "not"))} />
      ))}
    </div>
  );
}

/** A source's one button, on one line: the list's name, then what is drawn from it (its tags, the lyrics'
 *  sections), faded, cut by "…" when too long; its menu says where from, then which one. */
export function SourceButton({ name, sub, open, onClick, label }: { name: string; sub?: string; open: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" className={"input pick-btn src-btn" + (open ? " on" : "")} onClick={(e) => { e.stopPropagation(); onClick(); }} aria-label={label} title={sub ? `${name} · ${sub}` : name}>
      <span className="truncate">{name}{sub ? <span className="src-sub"> · {sub}</span> : null}</span>
      <Icon name="chevron" size={13} />
    </button>
  );
}

/**
 * The texts to pick one from (a slide's, a hook's), with a search field: typed words find a text anywhere in its list,
 * past the tags ticked (what one has in mind, out at once). Accents and case do not matter.
 */
export function TextPickList({ label, items, all, current, onPick }: {
  label: string; items: string[]; all: string[]; current: string; onPick: (x: string) => void;
}) {
  const { t } = useT();
  const [q, setQ] = useState("");
  const flat = (x: string) => x.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const words = flat(q).split(/\s+/).filter(Boolean);
  const shown = words.length ? [...new Set(all)].filter((x) => words.every((w) => flat(x).includes(w))) : items;
  return (
    <div className="pick-sec">
      <span className="pick-k">{label} <span className="pick-n">{shown.length}</span></span>
      <input className="input sm pick-search" type="search" value={q} onChange={(e) => setQ(e.target.value)}
        placeholder={t("Search a word…")} aria-label={t("Search a word…")} />
      <div className="pick-list">
        {[...shown].sort(compareTexts).map((x, k) => (
          <button key={k} className={"pick-line" + (x === current ? " on" : "")} onClick={() => onPick(x)}>
            <span className="dd-check" aria-hidden>{x === current ? "✓" : ""}</span><span>{x.replace(/\|/g, " ")}</span>
          </button>
        ))}
        {!shown.length && <p className="muted xs">{t("Nothing found.")}</p>}
      </div>
    </div>
  );
}
