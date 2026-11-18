"use client";

import { useState } from "react";
import Icon from "@/components/Icon";

/** Made-up hooks and lyrics (no real song's), drawn as the carousel studio does: a hook on slide 1, lines after. */
const HOOKS = ["POV: you finally finished the song", "I wrote this in my car at 3am", "this one's for the late nights", "new single out friday", "the song I almost didn't release"];
const LINES = ["we were dancing in the dark", "every light was ours", "say my name again", "slow motion summer", "in the static of my radio", "one more time"];
const TONES = ["ember", "tide", "dusk", "rose", "moss", "smoke"] as const;
const LOOKS = ["outline", "serif", "mono"] as const;

/** A draw of the deck: its hook, three lines, a tone per slide (the photos), one look for all. */
function draw(seed: number) {
  const pick = <T,>(xs: readonly T[], k: number) => xs[(seed * 7 + k * 13) % xs.length];
  return {
    hook: pick(HOOKS, 1),
    lines: [0, 1, 2].map((k) => LINES[(seed * 5 + k * 2) % LINES.length]),
    tones: [0, 1, 2, 3].map((k) => pick(TONES, k + 2)),
    look: pick(LOOKS, 3),
  };
}

/**
 * The carousel studio in four slides: Generate draws another deck (another hook, other lines, other photos), as the
 * app does from the artist's lists. The photos are tones until real ones replace them.
 */
export default function CarouselDeck({ label }: { label: string }) {
  const [seed, setSeed] = useState(1);
  const d = draw(seed);
  return (
    <div className="lp-deck2">
      <div className="lp-deck2-slides" key={seed}>
        {[d.hook, ...d.lines].map((text, i) => (
          <div key={i} className={`lp-post lp-slide2 tone-${d.tones[i]} look-${i === 0 ? "outline" : d.look}`} style={{ animationDelay: `${i * 60}ms` }}>
            <span className="lp-post-ground" aria-hidden><i /><i /><i /></span>
            <span className="lp-post-grain" aria-hidden />
            <span className="lp-post-lines"><span className="lp-post-line still">{text}</span></span>
            <span className="lp-slide2-n mono">{i + 1}/4</span>
          </div>
        ))}
      </div>
      <button className="btn primary gen-btn lp-gen" onClick={() => setSeed((s) => s + 1)}><Icon name="sparkle" size={15} />{label}</button>
    </div>
  );
}
