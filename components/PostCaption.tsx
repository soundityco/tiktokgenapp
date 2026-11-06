"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import type { TextPool } from "@/lib/types";
import Icon from "./Icon";
import { Select } from "./ui";

/** TikTok's limit for the text of a post. */
const LIMIT = 4000;

/**
 * The text of the TikTok post (caption and hashtags) of a carousel or a video: written here, or drawn from a
 * captions list (again at each generation). Copied in one click, and saved as caption.txt with the download.
 */
export default function PostCaption({ value, poolId, pools, onChange, onPool, onDraw, onNewList, auto }: {
  value: string;
  poolId?: string;
  /** The captions lists this release can use. */
  pools: TextPool[];
  onChange: (text: string) => void;
  onPool: (id: string | undefined) => void;
  /** Draws another caption from the chosen list. */
  onDraw: () => void;
  onNewList: () => void;
  /** A caption is drawn again at each generation (the carousel). */
  auto?: boolean;
}) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1400); } catch { /* not allowed */ }
  };
  const tags = (value.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  return (
    <div className="post-caption stack">
      <textarea className="input" rows={4} value={value} maxLength={LIMIT} onChange={(e) => onChange(e.target.value)}
        placeholder={t("The text of the post: a caption and its hashtags.")} aria-label={t("Caption and hashtags")} />
      <div className="row nowrap">
        <Select className="input sm grow" aria-label={t("Captions list")} value={poolId ?? ""}
          onChange={(e) => { if (e.target.value === "new") onNewList(); else onPool(e.target.value || undefined); }}>
          <option value="">{pools.length ? t("Written by hand") : t("No captions list yet")}</option>
          {pools.map((p) => <option key={p.id} value={p.id}>{t("From “{name}”", { name: p.name })}</option>)}
          <option value="new">{t("New captions list…")}</option>
        </Select>
        <button className="btn sm icon" onClick={onDraw} disabled={!poolId} aria-label={t("Draw another caption")} title={t("Draw another caption")}><Icon name="refresh" size={14} /></button>
        <button className="btn sm" onClick={() => void copy()} disabled={!value.trim()}>{copied ? <><Icon name="check" size={14} />{t("Copied")}</> : <><Icon name="copy" size={14} />{t("Copy")}</>}</button>
      </div>
      <p className="muted xs">{t("{n} characters", { n: value.length })}{tags ? ` · ${t("{n} hashtags", { n: tags })}` : ""}{poolId && auto ? ` · ${t("a new one is drawn at each generation")}` : ""}</p>
    </div>
  );
}
