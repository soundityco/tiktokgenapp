"use client";
import { useEffect, useRef, useState } from "react";
import { thumbnailLink } from "@/lib/thumb";

/** One tiny Drive thumbnail (Google's own, cached), loaded once it comes near the screen; an empty square until then. */
function Mini({ id }: { id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let off = false;
    const io = new IntersectionObserver((e) => {
      if (!e[0].isIntersecting) return;
      io.disconnect();
      thumbnailLink(id).then((l) => !off && setSrc(l)).catch(() => {});
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => { off = true; io.disconnect(); };
  }, [id]);
  return (
    <span ref={ref} className="pic-mini">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src && <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setSrc(null)} />}
    </span>
  );
}

/** A photo list at a glance in the library: its first three photos, stacked like prints. */
export default function PicStack({ ids }: { ids: string[] }) {
  return (
    <span className={"pic-stack" + (ids.length ? "" : " empty")} aria-hidden>
      {ids.length ? ids.slice(0, 3).map((id) => <Mini key={id} id={id} />) : <span className="pic-mini" />}
    </span>
  );
}
