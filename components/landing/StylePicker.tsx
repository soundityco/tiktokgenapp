"use client";

import { useState } from "react";
import PostCard from "./PostCard";
import type { DemoPost } from "./posts";

/**
 * The styles, as a plugin's presets (Voyager): one post large, the list beside it; a click plays that style in it.
 * The names and notes come translated from the page.
 */
export default function StylePicker({ styles }: { styles: { post: DemoPost; name: string; note: string }[] }) {
  const [on, setOn] = useState(0);
  return (
    <div className="lp-picker">
      <div className="lp-picker-shot"><PostCard key={on} post={styles[on].post} /></div>
      <div className="lp-picker-list" role="listbox">
        {styles.map((s, i) => (
          <button key={s.name} role="option" aria-selected={i === on} className={"lp-preset" + (i === on ? " on" : "")} onClick={() => setOn(i)}>
            <span className="lp-preset-play" aria-hidden>{i === on ? "❚❚" : "▶"}</span>
            <span className="lp-preset-txt"><b>{s.name}</b><span className="mono">{s.note}</span></span>
            <span className={`lp-preset-sw tone-${s.post.tone}`} aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}
