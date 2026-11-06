"use client";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import type { FoundImage, ImageSource } from "@/lib/imageSearch";
import Icon from "./Icon";
import { Modal } from "./ui";

/**
 * Moods that turn a plain search into the raw, real-life photos of Pinterest: the words amateur
 * photographers put on their pictures.
 */
const MOODS: { label: string; words: string }[] = [
  { label: "Film", words: "35mm film" }, { label: "Flash", words: "flash night" }, { label: "Blurry", words: "blurry motion" },
  { label: "Night", words: "night" }, { label: "Disposable", words: "disposable camera" }, { label: "Grain", words: "grain analog" },
  { label: "Vintage", words: "vintage" }, { label: "Street", words: "street" }, { label: "Sky", words: "sky clouds" },
];

/** Searches already made on this page (source, words, page): coming back to them is instant. */
const SEEN = new Map<string, { results: FoundImage[]; more: boolean }>();

/** Search photos that may be posted (free licences) and put one in the slide. */
export default function ImageFinder({ onPick, onClose }: { onPick: (img: FoundImage) => void; onClose: () => void }) {
  const { t } = useT();
  const [q, setQ] = useState("");
  const [moods, setMoods] = useState<string[]>([]);
  const [source, setSource] = useState<ImageSource>(() => {
    try { return (localStorage.getItem("tktgen-find-source") as ImageSource) || "flickr"; } catch { return "flickr"; }
  });
  const [items, setItems] = useState<FoundImage[]>([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Page being fetched: 1 = a new search (the grid shows it is coming), more = the next ones. */
  const [loading, setLoading] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const query = [q.trim(), ...moods.map((m) => MOODS.find((x) => x.label === m)?.words ?? "")].filter(Boolean).join(" ");
  const ask = useRef(0);
  const aborter = useRef<AbortController | null>(null);
  const grid = useRef<HTMLDivElement>(null);

  const load = async (p: number) => {
    const id = ++ask.current;
    aborter.current?.abort(); // an older search still on its way is dropped
    const ac = new AbortController();
    aborter.current = ac;
    const key = `${source}|${query}|${p}`;
    const known = SEEN.get(key);
    setErr(null);
    if (known) { // a search already made: at once
      setItems((cur) => (p === 1 ? known.results : [...cur, ...known.results.filter((x) => !cur.some((c) => c.id === x.id))]));
      setMore(known.more); setPage(p); setBusy(false);
      return;
    }
    setBusy(true);
    setLoading(p);
    try {
      const r = await fetch(`/api/images/search?${new URLSearchParams({ q: query, page: String(p), source })}`, { signal: ac.signal });
      const j = await r.json().catch(() => ({}));
      if (id !== ask.current) return;
      if (r.ok) SEEN.set(key, { results: j.results, more: !!j.more });
      if (!r.ok) {
        setErr(j.error === "pexels_not_configured" ? t("Pexels is not set up on this site yet (key PEXELS_API_KEY).") : t("The search did not answer. Try again in a moment."));
        if (p === 1) setItems([]);
        setMore(false);
        return;
      }
      setItems((cur) => (p === 1 ? j.results : [...cur, ...j.results.filter((x: FoundImage) => !cur.some((c) => c.id === x.id))]));
      if (p === 1 && grid.current) grid.current.scrollTop = 0; // a new search starts from the top
      setMore(!!j.more);
      setPage(p);
    } catch (e) {
      if (id === ask.current && !(e instanceof DOMException && e.name === "AbortError")) setErr(t("The search did not answer. Try again in a moment."));
    } finally {
      if (id === ask.current) setBusy(false);
    }
  };

  // Results while typing (a short pause first), from the first page.
  useEffect(() => {
    try { localStorage.setItem("tktgen-find-source", source); } catch { /* private mode */ }
    if (!query) { ask.current++; setItems([]); setMore(false); setBusy(false); return; }
    const id = setTimeout(() => void load(1), 450);
    return () => clearTimeout(id);
  }, [query, source]); // eslint-disable-line react-hooks/exhaustive-deps

  // More results only when scrolling near the end of the grid (never on their own, page after page).
  const onScroll = () => {
    const g = grid.current;
    if (!g || busy || !more) return;
    if (g.scrollTop + g.clientHeight > g.scrollHeight - 300) void load(page + 1);
  };
  const first = busy && loading === 1 && !items.length; // nothing to show yet: placeholder tiles

  return (
    <Modal title={t("Find a photo")} onClose={onClose} wide>
      <div className="stack finder">
        <div className="row">
          <label className="grow finder-search">
            {busy ? <span className="spin-dot finder-spin" aria-label={t("Searching…")} /> : <Icon name="search" size={15} />}
            <input className="input" autoFocus placeholder={t("A few words: sky, window, car at night…")} value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="seg" role="group" aria-label={t("Source")} style={{ marginTop: 0 }}>
            <button className={source === "flickr" ? "on" : ""} aria-pressed={source === "flickr"} onClick={() => setSource("flickr")}
              title={t("Photos of real people, amateur and film: the closest to Pinterest")}>Flickr</button>
            <button className={source === "pexels" ? "on" : ""} aria-pressed={source === "pexels"} onClick={() => setSource("pexels")}>Pexels</button>
          </div>
        </div>
        <div className="row finder-moods" role="group" aria-label={t("Mood")}>
          {MOODS.map((m) => {
            const on = moods.includes(m.label);
            return <button key={m.label} className={"btn sm" + (on ? " primary" : "")} aria-pressed={on}
              onClick={() => setMoods(on ? moods.filter((x) => x !== m.label) : [...moods, m.label])}>{t(m.label)}</button>;
          })}
        </div>
        <p className="muted xs">{t("Only photos free to post with your text on them: public domain, CC0, CC BY (credit the photographer in the TikTok caption) and the Pexels licence. Avoid recognisable faces in an ad.")}</p>
        {source === "pexels" && <p className="muted xs">{t("Photos provided by Pexels")} · pexels.com</p>}
        {err && <p className="notice warn xs">{err}</p>}
        <div className={"finder-grid" + (busy && loading === 1 && items.length ? " stale" : "")} ref={grid} onScroll={onScroll} aria-busy={busy}>
          {first && Array.from({ length: 12 }, (_, k) => <span key={k} className="finder-item finder-skel shine-box" aria-hidden />)}
          {items.map((img) => (
            <button key={img.id} className="finder-item" onClick={() => onPick(img)}
              title={`${img.author || t("Unknown author")} · ${img.license}${img.w ? ` · ${img.w}×${img.h}` : ""}`}>
              <img src={img.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" onLoad={(e) => e.currentTarget.classList.add("in")} />
              <span className="finder-meta">{img.author || "—"} · {img.license}{img.w && img.w < 1080 && img.h < 1920 ? ` · ${t("small")}` : ""}</span>
            </button>
          ))}
          {busy && loading > 1 && <p className="muted xs finder-more shine">{t("Loading more…")}</p>}
        </div>
        {!busy && query && !items.length && !err && <p className="muted xs">{t("No photo for these words. Try others, or fewer.")}</p>}
        {more && !busy && items.length > 0 && <p className="muted xs">{t("Scroll the photos for more.")}</p>}
        {!query && <p className="muted xs">{t("Type a few words, or pick a mood.")}</p>}
      </div>
    </Modal>
  );
}
