// What the site sees of the desktop app (lib/desktop.ts): its version and system, and the sign-in through the browser.
const { contextBridge, ipcRenderer } = require("electron");
const info = ipcRenderer.sendSync("raw-info");
contextBridge.exposeInMainWorld("rawDesktop", { ...info, signIn: () => ipcRenderer.send("raw-sign-in") });
