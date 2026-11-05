// Service worker of the installed app. It caches nothing on purpose: every page and file comes from the
// network as before (no stale version after a deploy). It is there because Chrome wants one to offer the install.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* the browser handles every request itself */ });
