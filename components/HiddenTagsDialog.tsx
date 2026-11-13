"use client";
import { isLineList } from "@/lib/defaults";
import { poolTags, tagGroups } from "@/lib/generate";
import { useT } from "@/lib/i18n";
import { themeLabel } from "@/lib/themes";
import type { TextPool } from "@/lib/types";
import { Modal } from "./ui";

/**
 * The tags a release puts aside (the pre-release hooks once it is out…): their texts are no longer drawn in this
 * release, carousels and video hooks alike. They stay in the lists, and come back when the tag is ticked again.
 */
export default function HiddenTagsDialog({ release, pools, hidden, onChange, onClose }: {
  release: string; pools: TextPool[]; hidden: string[]; onChange: (tags: string[]) => void; onClose: () => void;
}) {
  const { t } = useT();
  const lists = pools.filter(isLineList).map((p) => ({ p, groups: tagGroups(poolTags(p)).filter((g) => g.id !== "") })).filter((x) => x.groups.length);
  const toggle = (id: string) => onChange(hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]);
  return (
    <Modal title={t("Tags put aside")} onClose={onClose}>
      <p className="modal-text">{t("The texts with a tag put aside are no longer drawn in “{name}” (carousels and video hooks). They stay in your lists.", { name: release })}</p>
      {!lists.length && <p className="muted xs">{t("No tags in these lists yet.")}</p>}
      {lists.map(({ p, groups }) => (
        <section key={p.id} className="stack hidden-tags">
          <h3 className="label">{p.name}</h3>
          <div className="pick-chips" role="group" aria-label={p.name}>
            {groups.map((g) => {
              const off = hidden.includes(g.id);
              return (
                <button key={g.id} className={"pick-chip" + (off ? " aside" : "")} aria-pressed={off} onClick={() => toggle(g.id)}
                  title={off ? t("Put aside: click to draw it again") : t("Click to put it aside in this release")}>
                  {themeLabel(g.id, t)} · {g.items.length}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      <div className="modal-foot"><button className="btn primary" onClick={onClose}>{t("Done")}</button></div>
    </Modal>
  );
}
