"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import type { TextPool } from "@/lib/types";
import type { Variant } from "@/lib/variants";
import { Modal } from "./ui";

/**
 * After an export: the texts drawn from a list then retouched (a hook made better on the post), offered to keep in
 * their list as new lines, with the tags of the line they came from. Asked once per text.
 */
export default function VariantsDialog({ list, pools, onKeep, onClose }: {
  list: Variant[]; pools: TextPool[]; onKeep: (kept: Variant[]) => void; onClose: () => void;
}) {
  const { t } = useT();
  const [on, setOn] = useState(() => list.map(() => true));
  const kept = list.filter((_, i) => on[i]);
  return (
    <Modal title={list.length === 1 ? t("Keep this retouched text?") : t("Keep these retouched texts?")} onClose={onClose}>
      <p className="modal-text">{list.length === 1
        ? t("You changed it on this post. Added to its list, it can be drawn again, with the tags of the line it came from.")
        : t("You changed them on this post. Added to their list, they can be drawn again, with the tags of the line they came from.")}</p>
      <div className="stack variants">
        {list.map((v, i) => (
          <label key={v.pool + v.text} className="check variant">
            <input type="checkbox" checked={on[i]} onChange={(e) => setOn((cur) => cur.map((x, k) => (k === i ? e.target.checked : x)))} />
            <span className="stack">
              <span>{v.text.replace(/\s*\|\s*/g, " / ")}</span>
              <span className="muted xs">{t("In “{list}”", { list: pools.find((p) => p.id === v.pool)?.name ?? "" })}{v.from ? ` · ${t("from “{line}”", { line: v.from.replace(/\s*\|\s*/g, " / ") })}` : ""}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>{t("Not now")}</button>
        <button className="btn primary" disabled={!kept.length} onClick={() => { onKeep(kept); onClose(); }}>
          {kept.length > 1 ? t("Add {n} to my lists", { n: kept.length }) : t("Add to my list")}
        </button>
      </div>
    </Modal>
  );
}
