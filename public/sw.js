// Service worker of the installed app. Pages and files always come from the network (no stale version after a
// deploy); only a small "offline" page is kept, shown when the app is opened without a connection.
const CACHE = "rollout-offline-v1";
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.add("/offline.html"))); self.skipWaiting(); });
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return; // the browser handles everything else itself
  e.respondWith(fetch(e.request).catch(async () => (await caches.match("/offline.html")) || Response.error()));
});
