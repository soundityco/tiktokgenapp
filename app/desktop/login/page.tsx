import { headers } from "next/headers";
import { auth, signIn } from "@/auth";
import Wordmark from "@/components/Wordmark";
import Handoff from "./Handoff";
import { goodState } from "@/lib/desktopAuth";
import { detectLang, translate } from "@/lib/translate";

/**
 * Opened in the browser by the desktop app (lib/desktopAuth): signed in as usual (Google), then the session handed back
 * to the app. Nothing else here.
 */
export default async function DesktopLogin({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const { state } = await searchParams;
  const lang = detectLang((await headers()).get("accept-language"));
  const t = (k: string) => translate(lang, k);
  const session = await auth();
  const ok = goodState(state ?? null);
  const google = async () => { "use server"; await signIn("google", { redirectTo: `/desktop/login?state=${encodeURIComponent(state ?? "")}` }); };
  return (
    <main className="desk-login">
      <div className="desk-card">
        <Wordmark />
        {!ok ? <p>{t("Open this page from the RAW app (Sign in).")}</p>
          : session?.user
            ? <Handoff state={state!} labels={{ wait: t("Signing in the app…"), done: t("You are signed in. You can close this page and go back to the app."), open: t("Open RAW"), fail: t("This sign-in expired. Start again from the app.") }} />
            : (
              <>
                <p>{t("Sign in to use RAW on this computer.")}</p>
                <form action={google}><button className="btn primary">{t("Continue with Google")}</button></form>
              </>
            )}
      </div>
    </main>
  );
}
