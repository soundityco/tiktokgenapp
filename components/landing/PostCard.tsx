import type { DemoPost } from "./posts";

/** Seconds each line of a drawn post stays on screen. */
const LINE = 2.4;

/**
 * One 9:16 post: its real video when there is one, else drawn — a slow moving ground in its tone, grain, and its lines
 * playing one after the other in its look (karaoke: word by word). Pure CSS (no script): many can run at once.
 */
export default function PostCard({ post, size = "md" }: { post: DemoPost; size?: "sm" | "md" }) {
  const n = post.lines.length;
  return (
    <div className={`lp-post lp-post-${size} tone-${post.tone} look-${post.look} lines-${Math.min(3, Math.max(2, n))}`} style={{ ["--n" as string]: n, ["--line" as string]: `${LINE}s` }}>
      {post.video ? (
        <video className="lp-post-video" src={post.video} poster={post.poster} autoPlay muted loop playsInline preload="metadata" />
      ) : (<>
        <span className="lp-post-ground" aria-hidden><i /><i /><i /></span>
        <span className="lp-post-grain" aria-hidden />
        <span className="lp-post-lines">
          {post.lines.map((l, i) => (
            <span key={i} className="lp-post-line" style={{ animationDelay: `${i * LINE}s` }}>
              {post.look === "karaoke"
                ? l.split(" ").map((w, k, ws) => (
                  <span key={k} className="lp-word" style={{ animationDelay: `${i * LINE + (k * (LINE - 0.6)) / ws.length}s` }}>{w}{k < ws.length - 1 ? " " : ""}</span>
                ))
                : l}
            </span>
          ))}
        </span>
      </>)}
    </div>
  );
}
