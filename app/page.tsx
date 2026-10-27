import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import Logo from "@/components/Logo";

export default async function Login() {
  const session = await auth();
  if (session?.user) redirect("/studio");
  const dev = process.env.NODE_ENV !== "production" && process.env.DEV_FAKE_LOGIN === "1";
  return (
    <main className="login">
      <div className="login-card">
        <div className="row"><Logo size={40} /><h1>TkTgen</h1></div>
        <p className="muted" style={{ margin: 0 }}>
          Turn your photos, hooks and lyrics into TikTok carousels in one click. Sign in with Google to reach your
          releases and the photo folders in your Drive.
        </p>
        <form action={async () => { "use server"; await signIn("google", { redirectTo: "/studio" }); }}>
          <button className="btn red" style={{ width: "100%", padding: 11 }}>Continue with Google</button>
        </form>
        {dev && (
          <form action={async () => { "use server"; await signIn("dev", { redirectTo: "/studio" }); }}>
            <button className="btn" style={{ width: "100%" }}>Dev login (local only)</button>
          </form>
        )}
      </div>
    </main>
  );
}
