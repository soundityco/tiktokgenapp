// What the site sees of the desktop app (lib/desktop.ts): its version and system, and the sign-in through the browser.
const { contextBridge, ipcRenderer } = require("electron");
const info = ipcRenderer.sendSync("raw-info");
contextBridge.exposeInMainWorld("rawDesktop", {
  ...info,
  signIn: () => ipcRenderer.send("raw-sign-in"),
  // full screen entered or left (Mac): the site gives the window buttons' room back (components/DesktopFrame)
  onFullScreen: (cb) => { ipcRenderer.on("raw-full", (_e, on) => cb(!!on)); },
});
