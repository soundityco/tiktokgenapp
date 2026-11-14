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

/** A source's tags, short: the ticked one ("Out now") or how many ("2 tags"), then how many are excluded
 *  ("1 excl."). Empty: the whole list. */
export function tagSummary(ticked: string[], not: string[], t: (k: string, v?: Record<string, string | number>) => string): string {
  const on = ticked.length === 1 ? themeLabel(ticked[0], t) : ticked.length ? t("{n} tags", { n: ticked.length }) : "";
  const off = not.length === 1 ? t("1 excl.") : not.length ? t("{n} excl.", { n: not.length }) : "";
  return [on, off].filter(Boolean).join(" · ");
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
