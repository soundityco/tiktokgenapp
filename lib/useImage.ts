"use client";
import { useEffect, useState } from "react";
import { loadDriveImage } from "./drive";
import type { Img } from "./render";

export function useDriveImage(id: string | null) {
  const [img, setImg] = useState<Img | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setImg(null);
    setErr(null);
    if (!id) return;
    let off = false;
    loadDriveImage(id)
      .then((i) => !off && setImg(i))
      .catch((e) => !off && setErr(e?.message ?? "Could not load picture"));
    return () => { off = true; };
  }, [id]);
  return { img, err };
}
