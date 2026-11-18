import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import Icon from "@/components/Icon";
import Logo from "@/components/Logo";
import Wordmark from "@/components/Wordmark";
import PostCard from "@/components/landing/PostCard";
import StudioScene from "@/components/landing/StudioScene";
import { POSTS, STYLES } from "@/components/landing/posts";
import "./landing.css";
import { detectLang, translate } from "@/lib/translate";

/**
 * The home page, signed out: what RAW does for an artist, shown more than told — posts made with it sliding by, the
 * video studio playing, four styles side by side — in plain words; Google sign-in (signed in: straight to the studio).
 * The app's own look: serif headlines, mono labels, each studio in its colour, hairlines. The posts are drawn in code
 * until real videos replace them (components/landing/posts.ts).
 */
export default async function Home() {
  const session = await auth();
  if (session?.user) redirect("/studio");
  const lang = detectLang((await headers()).get("accept-language"));
  const t = (k: string) => translate(lang, k);
  const dev = process.env.NODE_ENV !== "production" && process.env.DEV_FAKE_LOGIN === "1";
  const google = async () => { "use server"; await signIn("google", { redirectTo: "/studio" }); };
  const demo = async () => { "use server"; await signIn("google", { redirectTo: "/studio?demo" }); };
  const signInButton = (cls: string, label: string) => (
    <form action={google}><button className={cls}><GoogleG />{label}</button></form>
  );

  return (
    <main className="lp">
      <header className="lp-nav">
        <Link href="/" className="row" style={{ gap: 12, textDecoration: "none" }} aria-label="RAW by aurare"><Logo size={28} /><Wordmark height={18} /></Link>
        <span className="grow" />
        <a className="lp-nav-link" href="#studio">{t("The studio")}</a>
        <a className="lp-nav-link" href="#styles">{t("Styles")}</a>
        <form action={google}><button className="btn sm">{t("Sign in")}</button></form>
      </header>

      {/* The headline, centred; under it, posts made with RAW slide by. */}
      <section className="lp-hero2">
        <span className="label">{t("For artists who release music")}</span>
        <h1 className="display lp-title2">{t("Your music, everywhere.")}<br /><em>{t("Without the all-nighters.")}</em></h1>
        <p className="lp-lead2">{t("Lyric videos synced to your take, carousels for every day of your release. In your browser, free.")}</p>
        <div className="lp-ctas center">
          {signInButton("btn primary lp-cta", t("Continue with Google"))}
          <form action={demo}><button className="btn lp-cta">{t("Try the studio in demo")}</button></form>
        </div>
        <p className="lp-fine mono">{t("Your files stay in your own Google Drive.")}</p>
        {dev && <form action={async () => { "use server"; await signIn("dev", { redirectTo: "/studio" }); }}><button className="btn sm">Dev login (local only)</button></form>}
      </section>
      <div className="lp-strip" aria-hidden>
        <div className="lp-strip-track">
          {[...POSTS, ...POSTS].map((p, i) => <PostCard key={i} post={p} size="sm" />)}
        </div>
      </div>

      {/* The product, in front: the video studio playing. */}
      <section id="studio" className="lp-block lp-studio">
        <div className="lp-block-head">
          <span className="lp-kicker"><span className="lp-dot" />{t("Video studio")}</span>
          <h2 className="display">{t("Film it once.")} <em>{t("RAW does the edit.")}</em></h2>
          <p className="lp-lead2">{t("Drop your takes: they lock onto your track by themselves. Your lyrics light up word by word, right on time, and you switch cameras like in a real edit.")}</p>
        </div>
        <StudioScene labels={{ hook: t("Hook"), lyrics: t("Lyrics"), cam: t("Video"), hookText: t("new single · friday"), synced: t("3 takes synced to the track"), placed: t("lyrics placed word by word") }} />
      </section>

      {/* One look per release: four styles, side by side. */}
      <section id="styles" className="lp-block">
        <div className="lp-block-head">
          <span className="lp-kicker"><span className="lp-dot carousel" />{t("Styles")}</span>
          <h2 className="display">{t("One look")} <em>{t("per release.")}</em></h2>
          <p className="lp-lead2">{t("Fonts, colours, word by word or line by line: set your look once, every post follows it.")}</p>
        </div>
        <div className="lp-styles">
          {STYLES.map((s) => (
            <figure key={s.name} className="lp-style">
              <PostCard post={s.post} />
              <figcaption><b>{t(s.name)}</b><span className="mono">{t(s.note)}</span></figcaption>
            </figure>
          ))}
        </div>
      </section>

      {/* What it changes for an artist, in six lines. */}
      <section className="lp-block">
        <div className="lp-block-head">
          <span className="lp-kicker"><span className="lp-dot music" />{t("What it does for you")}</span>
          <h2 className="display">{t("Less time editing,")} <em>{t("more time making music.")}</em></h2>
        </div>
        <div className="lp-perks">
          {[
            ["type", t("Lyrics that time themselves"), t("Paste your lyrics: they land on the beat, word by word. A line to fix? The arrow keys, while it plays.")],
            ["film", t("Several cameras, one edit"), t("Face cam, wide shot, phone: everything locks onto your track, you cut between them like in a real editor.")],
            ["layers", t("A carousel a day"), t("Your photos, your hooks, your lyrics: a new carousel in one click, never the same twice.")],
            ["tune", t("Your colour, your grain"), t("Bring your LUT, grade your footage, add mist or grain: your release's look on every video.")],
            ["share", t("Straight to your phone"), t("Scan a code: your video is on your phone, ready to post with its caption.")],
            ["folder", t("Your files stay yours"), t("Everything lives in a RAW folder of your Google Drive. Your videos never go through our servers.")],
          ].map(([icon, title, text]) => (
            <div key={title} className="lp-perk"><span className="lp-perk-ico"><Icon name={icon} size={16} /></span><h3>{title}</h3><p>{text}</p></div>
          ))}
        </div>
      </section>

      {/* How it goes, in three steps. */}
      <section className="lp-steps">
        {[
          ["01", t("Import"), t("Your lyrics, your hook lists, your photos and your takes, from your phone or your computer.")],
          ["02", t("Generate"), t("Carousels drawn from your lists in one click; a video synced on your official audio, its lyrics placed on the beat.")],
          ["03", t("Post"), t("The slides or the MP4, with the post's caption ready, on your computer or sent to your phone.")],
        ].map(([n, title, text]) => (
          <div key={n} className="lp-step"><span className="lp-step-n mono">{n}</span><h3>{title}</h3><p>{text}</p></div>
        ))}
      </section>

      {/* The end: sign in, or the studio in demo (nothing kept). */}
      <section className="lp-end">
        <h2 className="display">{t("Ready for your")} <em>{t("next release?")}</em></h2>
        <div className="lp-ctas center">
          {signInButton("btn primary lp-cta", t("Continue with Google"))}
          <form action={demo}><button className="btn lp-cta">{t("Try the studio in demo")}</button></form>
        </div>
        <p className="lp-fine mono">{t("Demo: a blank account, nothing is saved.")}</p>
      </section>

      <footer className="lp-foot">
        <span className="row" style={{ gap: 10 }}><Logo size={18} /><span className="mono">{t("Made by artists, for artists.")}</span></span>
        <span className="grow" />
        <Link href="/privacy">{t("Privacy")}</Link>
        <Link href="/terms">{t("Terms")}</Link>
      </footer>
    </main>
  );
}

/** Google's "G", in its colours (the sign-in buttons). */
function GoogleG() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
