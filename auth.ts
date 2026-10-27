import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";

const SCOPE = "openid email profile https://www.googleapis.com/auth/drive.readonly";

const allowed = () =>
  (process.env.ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

async function refresh(token: any) {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.AUTH_GOOGLE_ID!,
        client_secret: process.env.AUTH_GOOGLE_SECRET!,
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw data;
    return {
      ...token,
      accessToken: data.access_token,
      expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
      refreshToken: data.refresh_token ?? token.refreshToken,
      error: undefined,
    };
  } catch {
    return { ...token, error: "RefreshFailed" };
  }
}

const providers: any[] = [
  Google({ authorization: { params: { scope: SCOPE, access_type: "offline", prompt: "consent" } } }),
];

// Local UI testing only. Never active in production builds.
if (process.env.NODE_ENV !== "production" && process.env.DEV_FAKE_LOGIN === "1") {
  providers.push(
    Credentials({
      id: "dev",
      name: "Dev login",
      credentials: {},
      authorize: async () => ({ id: "dev", email: "dev@local.test", name: "Dev" }),
    })
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt" },
  pages: { signIn: "/" },
  trustHost: true,
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider === "dev") return true;
      const list = allowed();
      if (!list.length) return true;
      return !!user.email && list.includes(user.email.toLowerCase());
    },
    async jwt({ token, account }) {
      if (account && account.provider === "google") {
        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          expiresAt: account.expires_at,
        };
      }
      const t: any = token;
      if (!t.expiresAt || Date.now() / 1000 < t.expiresAt - 120) return token;
      if (!t.refreshToken) return token;
      return refresh(t);
    },
    async session({ session, token }) {
      const t: any = token;
      (session as any).accessToken = t.accessToken;
      (session as any).expiresAt = t.expiresAt;
      (session as any).error = t.error;
      return session;
    },
  },
});
