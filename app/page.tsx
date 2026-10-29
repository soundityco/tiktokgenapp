import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import Logo from "@/components/Logo";
import { detectLang, translate } from "@/lib/translate";

export default async function Login() {
  const session = await auth();
  if (session?.user) redirect("/studio");
  const lang = detectLang((await headers()).get("accept-language"));
  const t = (k: string) => translate(lang, k);
  const dev = process.env.NODE_ENV !== "production" && process.env.DEV_FAKE_LOGIN === "1";
  return (
    <main className="login">
      <div className="login-card">
        <div className="row"><Logo size={40} /><h1 style={{ fontSize: "var(--fs-xl)" }}>TkTgen</h1></div>
        <p className="muted">
          {t("Turn your photos, hooks and lyrics into TikTok carousels in one click. Sign in with Google to reach your releases and the photo folders in your Drive.")}
        </p>
        <form action={async () => { "use server"; await signIn("google", { redirectTo: "/studio" }); }}>
          <button className="btn primary block">{t("Continue with Google")}</button>
        </form>
        {dev && (
          <form action={async () => { "use server"; await signIn("dev", { redirectTo: "/studio" }); }}>
            <button className="btn block">Dev login (local only)</button>
          </form>
        )}
      </div>
    </main>
  );
}
