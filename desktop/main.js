// RAW by aurare, the desktop app: the site (raw.aurare.app) in its own window, so it is always the version online (each
// push reaches the app at its next reload, the site offers it: components/UpdatePill). Google refuses its sign-in inside
// an app, so signing in goes through the browser and comes back by the app's link (rawaurare://auth, lib/desktopAuth).
const { app, BrowserWindow, Menu, ipcMain, session, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.RAW_URL || "https://raw.aurare.app";
const ORIGIN = new URL(BASE).origin;
const SCHEME = "rawaurare";
// Automated tests only (.workbench/bench/desktop-check.mjs): the window off screen and silent, links logged, not opened.
const TEST = process.env.RAW_TEST === "1";
if (TEST) app.commandLine.appendSwitch("mute-audio");
// (its own folder: a test never touches the installed app's window place nor its sign-in)
if (TEST) app.setPath("userData", path.join(require("node:os").tmpdir(), "raw-desktop-test"));
const openOutside = (url) => (TEST ? console.log("[external] " + url) : shell.openExternal(url));

if (!app.requestSingleInstanceLock()) app.quit();
if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient(SCHEME);

let win = null;
let pending = null; // the state of the sign-in started in the browser
let early = null; // a link received before the window was ready

// The window's place and size, kept between launches.
const placeFile = () => path.join(app.getPath("userData"), "window.json");
const savedPlace = () => { try { return JSON.parse(fs.readFileSync(placeFile(), "utf8")); } catch { return null; } };
const savePlace = () => { try { if (win && !win.isMinimized()) fs.writeFileSync(placeFile(), JSON.stringify({ ...win.getNormalBounds(), max: win.isMaximized() })); } catch { /* not kept */ } };

const sameSite = (u) => { try { return new URL(u).origin === ORIGIN; } catch { return false; } };
const isGoogleSignIn = (u) => { try { return new URL(u).hostname === "accounts.google.com"; } catch { return false; } };

/** Sign-in: in the browser, then back here by the app's link. */
function signInInBrowser() {
  pending = crypto.randomBytes(24).toString("base64url");
  void openOutside(`${BASE}/desktop/login?state=${pending}`);
}

/** The app's link (rawaurare://auth?code=…&state=…): the window signed in with the session the browser handed over. */
function onLink(link) {
  if (!win) { early = link; return; }
  let u;
  try { u = new URL(link); } catch { return; }
  if (u.protocol !== SCHEME + ":" || u.hostname !== "auth") return;
  const code = u.searchParams.get("code"), state = u.searchParams.get("state");
  if (!code || !state || state !== pending) return;
  pending = null;
  void win.loadURL(`${BASE}/api/desktop/session?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function createWindow() {
  const p = savedPlace();
  win = new BrowserWindow({
    width: p?.width ?? 1440, height: p?.height ?? 900, x: TEST ? -4000 : p?.x, y: TEST ? -4000 : p?.y, minWidth: 960, minHeight: 620,
    title: "RAW by aurare", backgroundColor: "#08080a", show: false,
    // No grey title bar: the app's own top bar is the window's (52 px, the studio's .top). Mac: its three buttons on it;
    // Windows: its buttons drawn in the app's colours over its right end. The site leaves them room (html.desk-inset).
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 19 } }
      : { titleBarStyle: "hidden", titleBarOverlay: { color: "#08080a", symbolColor: "#f0eee8", height: 52 } }),
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  if (p?.max) win.maximize();
  win.once("ready-to-show", () => win.show());
  for (const ev of ["resize", "move", "close"]) win.on(ev, savePlace);
  win.on("closed", () => { win = null; });
  // Full screen (Mac): its three buttons gone, the top bar takes back their room.
  win.on("enter-full-screen", () => win?.webContents.send("raw-full", true));
  win.on("leave-full-screen", () => win?.webContents.send("raw-full", false));
  const wc = win.webContents;
  // Google's sign-in: in the browser. Another site: in the browser too. The app's own pages stay here.
  const guard = (e, url) => {
    if (isGoogleSignIn(url)) { e.preventDefault(); signInInBrowser(); return; }
    if (!sameSite(url)) { e.preventDefault(); void openOutside(url); }
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
  wc.setWindowOpenHandler(({ url }) => {
    if (sameSite(url)) return { action: "allow" };
    if (/^https?:/.test(url)) void openOutside(url);
    return { action: "deny" };
  });
  // No connection: the site's offline page is not there (no service worker yet), a plain one instead.
  wc.on("did-fail-load", (_e, code, _d, url, main) => {
    if (!main || code === -3) return; // (-3: a navigation cancelled, ours)
    void wc.loadFile(path.join(__dirname, "offline.html"), { query: { to: url } });
  });
  void win.loadURL(BASE + "/studio");
  if (early) { const l = early; early = null; onLink(l); }
}

ipcMain.on("raw-info", (e) => { e.returnValue = { version: app.getVersion(), platform: process.platform, arch: process.arch, frame: "inset", full: !!win?.isFullScreen() }; });
ipcMain.on("raw-sign-in", () => signInInBrowser());

// macOS: the link opens the app; Windows / Linux: it starts a second instance, its arguments carry the link.
app.on("open-url", (e, url) => { e.preventDefault(); onLink(url); });
app.on("second-instance", (_e, argv) => {
  const link = argv.find((a) => a.startsWith(SCHEME + "://"));
  if (link) onLink(link);
  else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

const menu = () => Menu.buildFromTemplate([
  ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
  { role: "fileMenu" },
  { role: "editMenu" },
  { label: "View", submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
  { role: "windowMenu" },
]);

/** A free name in `dir` for `name` ("post.mp4", then "post (1).mp4"…), as the browser does. */
function freeName(dir, name) {
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  for (let n = 0; ; n++) { const p = path.join(dir, n ? `${stem} (${n})${ext}` : name); if (!fs.existsSync(p)) return p; }
}

app.whenReady().then(() => {
  // An export (a download): straight into Downloads, as Chrome does, no "Save as" window each time (tests: a temp folder).
  session.defaultSession.on("will-download", (_e, item) => {
    const dir = TEST ? path.join(require("node:os").tmpdir(), "raw-desktop-test-downloads") : app.getPath("downloads");
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* there */ }
    const to = freeName(dir, item.getFilename() || "RAW export");
    item.setSavePath(to);
    if (TEST) item.once("done", (_ev, state) => console.log(`[download] ${state} ${to}`));
  });
  Menu.setApplicationMenu(menu());
  createWindow();
  const first = process.argv.find((a) => a.startsWith(SCHEME + "://"));
  if (first) onLink(first);
  app.on("activate", () => { if (!win) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
