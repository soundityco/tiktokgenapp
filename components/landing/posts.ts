/**
 * The posts shown on the home page (the strip under the headline, the four styles). Each is drawn in code (an abstract
 * moving ground, grain, its lyrics playing in its look) until a real video made with RAW replaces it: put the file in
 * public/home/ and give its path in `video` (and a still in `poster`), nothing else to change. The lines are written
 * for the page (no real song's lyrics).
 */
export type Look = "serif" | "outline" | "mono" | "karaoke";

export interface DemoPost {
  id: string;
  look: Look;
  /** Its ground's tone (a class of app/landing.css: .tone-<name>). */
  tone: "ember" | "tide" | "dusk" | "rose" | "moss" | "smoke";
  lines: string[];
  /** A real video (public/home/…), muted and looping, when there is one: it replaces the drawn post. */
  video?: string;
  poster?: string;
}

export const POSTS: DemoPost[] = [
  { id: "p1", look: "serif", tone: "ember", lines: ["I keep your name", "in the static", "of my radio"] },
  { id: "p2", look: "outline", tone: "tide", lines: ["SAY IT LOUDER", "ONE MORE TIME", "OUT FRIDAY"] },
  { id: "p3", look: "mono", tone: "dusk", lines: ["on se perd", "dans la nuit", "sans se chercher"] },
  { id: "p4", look: "karaoke", tone: "rose", lines: ["all the lights are mine", "tonight we run"] },
  { id: "p5", look: "serif", tone: "moss", lines: ["slow motion", "summer"] },
  { id: "p6", look: "outline", tone: "smoke", lines: ["NEW SINGLE", "LINK IN BIO"] },
  { id: "p7", look: "karaoke", tone: "dusk", lines: ["tu danses encore", "sous la pluie"] },
  { id: "p8", look: "mono", tone: "ember", lines: ["take 03", "the one we kept"] },
];

/** The four styles, side by side (one per look). */
export const STYLES: { post: DemoPost; name: string; note: string }[] = [
  { post: POSTS[0], name: "Editorial", note: "Serif, line by line" },
  { post: POSTS[1], name: "Outline", note: "Bold, outlined, all caps" },
  { post: POSTS[2], name: "Mono", note: "Small, spaced, in a box" },
  { post: POSTS[3], name: "Karaoke", note: "Word by word, on the beat" },
];
