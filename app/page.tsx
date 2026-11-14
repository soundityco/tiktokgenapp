import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import Icon from "@/components/Icon";
import Logo from "@/components/Logo";
import Wordmark from "@/components/Wordmark";
import CarouselDemo from "@/components/landing/CarouselDemo";
import VideoDemo from "@/components/landing/VideoDemo";
import { detectLang, translate } from "@/lib/translate";

/**
 * The home page, signed out: what Rollout is for and what it does, with the real carousel engine to try at once and
 * the video studio's burnt lyrics running; Google sign-in (signed in: straight to the studio). The app's own look:
 * the serif headlines, mono labels, each studio in its colour, hairlines. Light: two small demos, drawn in the browser,
 * running only on screen.
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
        <Link href="/" className="row" style={{ gap: 12, textDecoration: "none" }} aria-label="Rollout"><Logo size={28} /><Wordmark height={20} /></Link>
        <span className="grow" />
        <form action={google}><button className="btn sm">{t("Sign in")}</button></form>
      </header>

      {/* Opening: what it is, in one sentence, and the carousel to try right away. */}
      <section className="lp-hero">
        <div className="lp-hero-txt">
          <span className="label">{t("For artists who release music")}</span>
          <h1 className="display lp-title">{t("Make your next")} <em>{t("post")}</em>.</h1>
          <p className="lp-lead">{t("Rollout turns your photos, hooks and lyrics into TikTok carousels, and syncs your filmed takes to your track with the lyrics on screen. In your browser, free.")}</p>
          <div className="lp-ctas">
            {signInButton("btn primary lp-cta", t("Continue with Google"))}
            <a className="btn lp-cta" href="#carousel">{t("See what it does")}</a>
          </div>
          <p className="lp-fine mono">{t("Your files stay in your own Google Drive.")}</p>
          {dev && <form action={async () => { "use server"; await signIn("dev", { redirectTo: "/studio" }); }}><button className="btn sm">Dev login (local only)</button></form>}
        </div>
        <CarouselDemo />
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

      {/* The two studios, each in its colour. */}
      <section id="carousel" className="lp-feature lp-carousel">
        <div className="lp-feature-txt">
          <span className="lp-kicker"><span className="lp-dot" />{t("Carousel studio")}</span>
          <h2 className="display">{t("A carousel a day,")} <em>{t("without the grind.")}</em></h2>
          <ul className="lp-list">
            <li>{t("Hooks drawn from your lists by tag (teaser, out now…), never the same twice in a row")}</li>
            <li>{t("Your lyrics cut into slides, linked to the song")}</li>
            <li>{t("TikTok's interface zones, your fonts, text styles, photo edits")}</li>
            <li>{t("Several carousels per release, downloaded in one go")}</li>
          </ul>
        </div>
        <div className="lp-feature-art lp-art-carousel" aria-hidden>
          <span className="lp-tag">#teaser</span><span className="lp-tag">#out-now</span><span className="lp-tag off">− #pre-release</span>
          <span className="lp-tag">#story</span><span className="lp-tag">#chorus</span>
        </div>
      </section>

      <section className="lp-feature lp-videof">
        <div className="lp-feature-txt">
          <span className="lp-kicker"><span className="lp-dot" />{t("Video studio")}</span>
          <h2 className="display">{t("Your take, on your track,")} <em>{t("to the frame.")}</em></h2>
          <ul className="lp-list">
            <li>{t("Film yourself singing: the app finds where the take sits in the official audio")}</li>
            <li>{t("Lyrics placed word by word by an AI that runs in your browser")}</li>
            <li>{t("Log footage (S-Log3, Apple Log…), LUTs and grade, exported in 10-bit")}</li>
            <li>{t("Hooks, black bars, versions A / B to compare")}</li>
          </ul>
        </div>
        <VideoDemo />
      </section>

      <section className="lp-feature lp-files">
        <div className="lp-feature-txt">
          <span className="lp-kicker"><span className="lp-dot" />{t("Your files")}</span>
          <h2 className="display">{t("Nothing leaves")} <em>{t("your hands.")}</em></h2>
          <p className="lp-lead">{t("Rollout only sees the files it makes in a Rollout folder of your Google Drive. The AI (lyrics, themes, photos) runs on your device; your videos never go through our servers.")}</p>
        </div>
        <div className="lp-feature-art lp-art-files" aria-hidden>
          <div className="lp-tree mono">
            <span><Icon name="folder" size={13} />Rollout</span>
            <span className="in"><Icon name="folder" size={13} />Releases / {t("My next single")}</span>
            <span className="in2 a">song.wav</span>
            <span className="in2 v">take_01.mp4</span>
            <span className="in"><Icon name="folder" size={13} />Photos</span>
          </div>
        </div>
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
