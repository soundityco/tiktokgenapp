import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import Icon from "@/components/Icon";
import Logo from "@/components/Logo";
import Wordmark from "@/components/Wordmark";
import CarouselDeck from "@/components/landing/CarouselDeck";
import StylePicker from "@/components/landing/StylePicker";
import StudioScene from "@/components/landing/StudioScene";
import DesktopLinks from "@/components/landing/DesktopLinks";
import { STYLES } from "@/components/landing/posts";
import "./landing.css";
import { detectLang, translate } from "@/lib/translate";

/**
 * The home page, signed out: what RAW does for an artist, shown more than told — the video studio playing right under
 * the headline (the app's own timeline), the styles as a plugin's presets, a carousel to generate — in plain words; Google sign-in (signed in: straight to the studio).
 * The app's own look: serif headlines, mono labels, each studio in its colour, hairlines. The posts are drawn in code
 * until real videos replace them (components/landing/posts.ts).
 */
export default async function Home({ searchParams }: { searchParams: Promise<{ desktop?: string }> }) {
  const session = await auth();
  if (session?.user) redirect("/studio");
  const h = await headers();
  const lang = detectLang(h.get("accept-language"));
  const t = (k: string) => translate(lang, k);
  const dev = process.env.NODE_ENV !== "production" && process.env.DEV_FAKE_LOGIN === "1";
  const google = async () => { "use server"; await signIn("google", { redirectTo: "/studio" }); };
  const demo = async () => { "use server"; await signIn("google", { redirectTo: "/studio?demo" }); };
  const signInButton = (cls: string, label: string) => (
    <form action={google}><button className={cls}><GoogleG />{label}</button></form>
  );

  // Opened in the desktop app (desktop/: Electron, its name in the user agent): its own first screen, full window, as a
  // music app's first launch: the brand, the sign-in (in the browser, then back here), the demo. Not the site's page.
  const ua = h.get("user-agent") ?? "";
  if (/\bElectron\//.test(ua) && /\b(RAWbyaurare|raw-by-aurare)\//i.test(ua)) {
    const failed = (await searchParams).desktop === "failed";
    return (
      <main className="lp dw">
        <div className="dw-glow" aria-hidden><i /><i /><i /></div>
        <section className="dw-box">
          <Wordmark height={30} />
          <h1 className="display lp-title2 dw-title">{t("Your music, everywhere.")}<br /><em>{t("Without the all-nighters.")}</em></h1>
          <p className="lp-lead2">{t("Lyric videos synced to your take, carousels for every day of your release.")}</p>
          <div className="lp-ctas center dw-ctas">
            {signInButton("btn primary lp-cta", t("Continue with Google"))}
            <form action={demo}><button className="btn lp-cta">{t("Try the studio in demo")}</button></form>
          </div>
          {dev && <form action={async () => { "use server"; await signIn("dev", { redirectTo: "/studio" }); }}><button className="btn sm">Dev login (local only)</button></form>}
          <p className={"lp-fine mono" + (failed ? " dw-failed" : "")}>{failed ? t("The sign-in did not finish. Try again.") : t("You sign in in your browser, then come back here.")}</p>
        </section>
        <p className="dw-foot mono">RAW by aurare</p>
      </main>
    );
  }

  return (
    <main className="lp">
      <header className="lp-nav">
        <Link href="/" className="row" style={{ gap: 12, textDecoration: "none" }} aria-label="RAW by aurare"><Wordmark height={18} /></Link>
        <span className="grow" />
        <a className="lp-nav-link" href="#studio">{t("The studio")}</a>
        <a className="lp-nav-link" href="#styles">{t("Styles")}</a>
        <a className="lp-nav-link" href="#carousel">{t("Carousels")}</a>
        <form action={google}><button className="btn sm">{t("Sign in")}</button></form>
      </header>

      {/* The headline, centred, and the product right under it (as a plugin's page): the video studio playing. */}
      <section className="lp-hero2">
        <span className="label">{t("For artists who release music")}</span>
        <h1 className="display lp-title2">{t("Your music, everywhere.")}<br /><em>{t("Without the all-nighters.")}</em></h1>
        <p className="lp-lead2">{t("Lyric videos synced to your take, carousels for every day of your release. In your browser, free.")}</p>
        <div className="lp-ctas center">
          {signInButton("btn primary lp-cta", t("Continue with Google"))}
          <form action={demo}><button className="btn lp-cta">{t("Try the studio in demo")}</button></form>
        </div>
        <p className="lp-fine mono">{t("Your files stay in your own Google Drive.")}</p>
        <DesktopLinks labels={{ lead: t("Also as an app:"), mac: t("Mac"), intel: t("Intel Mac"), windows: t("Windows") }} />
        {dev && <form action={async () => { "use server"; await signIn("dev", { redirectTo: "/studio" }); }}><button className="btn sm">Dev login (local only)</button></form>}
      </section>
      <section id="studio" className="lp-product">
        <div className="lp-frame">
          <StudioScene labels={{ video: t("Video"), hookText: t("new single · friday"), synced: t("3 takes synced to the track"), placed: t("lyrics placed word by word"), takes: [t("Face cam"), t("Wide shot"), t("Phone")] }} />
        </div>
        <div className="lp-product-notes">
          {[
            [t("Film it once."), t("Your takes lock onto your track by themselves, even filmed on three cameras.")],
            [t("RAW does the edit."), t("Lyrics placed word by word, the hook on top, cuts between cameras like in a real editor.")],
            [t("Your look."), t("Your LUT, your grain, your fonts: the same style on every post of the release.")],
          ].map(([h, p]) => <div key={h} className="lp-note"><b>{h}</b><span>{p}</span></div>)}
        </div>
      </section>

      {/* The styles, as a plugin's presets: one post large, the list beside it. */}
      <section id="styles" className="lp-block">
        <div className="lp-block-head">
          <span className="lp-kicker"><span className="lp-dot video" />{t("Styles")}</span>
          <h2 className="display">{t("One look")} <em>{t("per release.")}</em></h2>
          <p className="lp-lead2">{t("Fonts, colours, word by word or line by line: set your look once, every post follows it.")}</p>
        </div>
        <StylePicker styles={STYLES.map((s) => ({ post: s.post, name: t(s.name), note: t(s.note) }))} />
      </section>

      {/* The carousel studio: a deck, and Generate for another one. */}
      <section id="carousel" className="lp-block">
        <div className="lp-block-head">
          <span className="lp-kicker"><span className="lp-dot carousel" />{t("Carousel studio")}</span>
          <h2 className="display">{t("A carousel a day,")} <em>{t("without the grind.")}</em></h2>
          <p className="lp-lead2">{t("Your photos, your hooks, your lyrics: one click and a new carousel is ready, never the same twice.")}</p>
        </div>
        <CarouselDeck label={t("Generate")} />
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
