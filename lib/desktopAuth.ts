/**
 * Signing in the desktop app (desktop/): Google refuses its sign-in inside an app's window, so the app opens the browser
 * on /desktop/login, where the artist is signed in as usual; that page asks /api/desktop/code for a code (the browser's
 * session, sealed for 2 minutes, bound to the app's `state`) and hands it to the app by its link (rawaurare://auth);
 * the app opens /api/desktop/session with it, which signs its window in with the same session. Server only.
 */
export const CODE_SALT = "raw-desktop-code";
export const CODE_SECONDS = 120;
export const secret = () => process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "";
/** The app's state: random, URL-safe. */
export const goodState = (s: string | null): s is string => !!s && /^[A-Za-z0-9_-]{16,128}$/.test(s);
/** Auth.js's session cookie name, prefixed on https. */
export const sessionCookie = (secure: boolean) => (secure ? "__Secure-" : "") + "authjs.session-token";
/** Is the request on https (behind Vercel's proxy too). */
export const isSecure = (req: Request) =>
  new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
