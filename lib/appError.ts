/**
 * An error that stopped the page. A file of an older deploy (a tab left open while the site was updated) is not
 * really an error: the page is loaded again once, by itself. Anything else is shown as it is, so it can be reported.
 */
const RELOADED = "rollout-reloaded-at";

export const isStaleDeploy = (e: unknown) => {
  const s = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /ChunkLoadError|Loading (CSS )?chunk|dynamically imported module|Importing a module script failed|error loading dynamically/i.test(s);
};

/** Loads the page again for a stale deploy, at most once a minute (never in a loop). True when it does. */
export function reloadIfStale(e: unknown): boolean {
  if (!isStaleDeploy(e)) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOADED) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOADED, String(Date.now()));
  } catch { return false; /* storage blocked: no way to avoid a loop, show the error */ }
  location.reload();
  return true;
}

/** What to show and copy: the message and where it came from (the first lines of the stack). */
export const errorText = (e: unknown) => {
  if (!(e instanceof Error)) return String(e);
  const where = (e.stack ?? "").split("\n").slice(1, 4).map((l) => l.trim()).join("\n");
  return `${e.name}: ${e.message}${(e as Error & { digest?: string }).digest ? ` (${(e as Error & { digest?: string }).digest})` : ""}${where ? `\n${where}` : ""}`;
};
