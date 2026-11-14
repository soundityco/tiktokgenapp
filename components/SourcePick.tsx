"use client";
import { byTagName, tagStep } from "@/lib/generate";
import { useT } from "@/lib/i18n";
import { themeLabel } from "@/lib/themes";
import Icon from "./Icon";
import { TagChip } from "./ui";

/**
 * The pieces of a source card, the same in both studios (a slide's text or photo, a video's hook): one button, its
 * list and what is drawn from it; its menu: the list, its tags, then the texts (or photos) to pick one, opened on it.
 */

/** A source's tags in words: the ticked one ("Out now") or how many ("2 tags"), then the excluded ones ("without
 *  Humour", "without 2 tags"). Empty: the whole list. */
export function tagSummary(ticked: string[], not: string[], t: (k: string, v?: Record<string, string | number>) => string): string {
  const on = ticked.length === 1 ? themeLabel(ticked[0], t) : ticked.length ? t("{n} tags", { n: ticked.length }) : "";
  const off = not.length === 1 ? t("without {tag}", { tag: themeLabel(not[0], t) }) : not.length ? t("without {n} tags", { n: not.length }) : "";
  return [on, off].filter(Boolean).join(", ");
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
      {byTagName(groups, (g) => g.id, (id) => themeLabel(id, t)).map((g) => (
        <TagChip key={g.id || "other"} label={themeLabel(g.id, t)} count={g.items.length}
          state={ticked.includes(g.id) ? "on" : not.includes(g.id) ? "not" : undefined}
          onTick={() => onChange(tagStep(ticked, not, g.id, "tick"))} onNot={() => onChange(tagStep(ticked, not, g.id, "not"))} />
      ))}
    </div>
  );
}

/** A source's one button: the list's name, and under it what is drawn from it (its tags, the lyrics' sections),
 *  faded; its menu says where from, then which one. */
export function SourceButton({ name, sub, open, onClick, label }: { name: string; sub?: string; open: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" className={"input pick-btn src-btn" + (sub ? " two" : "") + (open ? " on" : "")} onClick={(e) => { e.stopPropagation(); onClick(); }} aria-label={label} title={sub ? `${name} · ${sub}` : name}>
      <span className="src-txt"><span className="truncate">{name}</span>{sub ? <span className="truncate src-sub">{sub}</span> : null}</span>
      <Icon name="chevron" size={13} />
    </button>
  );
}
