// RAW by aurare, the desktop app: the site (raw.aurare.app) in its own window, so it is always the version online (each
// push reaches the app at its next reload, the site offers it: components/UpdatePill). Google refuses its sign-in inside
// an app, so signing in goes through the browser and comes back by the app's link (rawaurare://auth, lib/desktopAuth).
const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.RAW_URL || "https://raw.aurare.app";
const ORIGIN = new URL(BASE).origin;
const SCHEME = "rawaurare";
// Automated tests only (.workbench/bench/desktop-check.mjs): the window off screen and silent, links logged, not opened.
const TEST = process.env.RAW_TEST === "1";
if (TEST) app.commandLine.appendSwitch("mute-audio");
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
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  if (p?.max) win.maximize();
  win.once("ready-to-show", () => win.show());
  for (const ev of ["resize", "move", "close"]) win.on(ev, savePlace);
  win.on("closed", () => { win = null; });
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

ipcMain.on("raw-info", (e) => { e.returnValue = { version: app.getVersion(), platform: process.platform, arch: process.arch }; });
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(menu());
  createWindow();
  const first = process.argv.find((a) => a.startsWith(SCHEME + "://"));
  if (first) onLink(first);
  app.on("activate", () => { if (!win) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
