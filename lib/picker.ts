import { getToken, type DriveItem } from "./drive";

/**
 * Google's own file picker (Google Picker API). A file chosen in it can be read by the app with the `drive.file`
 * permission alone: the app no longer needs to read the whole Drive (`drive.readonly`, a "restricted" permission
 * that Google only grants after a paid security audit).
 */

type Picked = { id: string; name: string; mimeType: string };
let loaded: Promise<void> | null = null;
let config: Promise<{ appId: string; key: string | null }> | null = null;

function load(): Promise<void> {
  loaded ??= new Promise<void>((resolve, reject) => {
    const w = window as any;
    const ready = () => w.gapi.load("picker", { callback: () => resolve(), onerror: () => reject(new Error("Google Picker could not load")) });
    if (w.gapi?.load) { ready(); return; }
    const s = document.createElement("script");
    s.src = "https://apis.google.com/js/api.js";
    s.async = true;
    s.onload = ready;
    s.onerror = () => reject(new Error("Google Picker could not load"));
    document.head.appendChild(s);
  }).catch((e) => { loaded = null; throw e; });
  return loaded;
}

const AUDIO = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/aac", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/flac", "audio/x-flac", "audio/ogg", "audio/aiff", "audio/x-aiff"];
const IMAGES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif", "image/avif"];

/**
 * Open the picker: photos (several at once) or one audio file. Resolves with the files chosen ([] when closed).
 * My Drive (folders to browse, search) and Shared with me.
 */
export async function pickDriveFiles(opts: { kind: "images" | "audio"; multi: boolean; title: string; lang: string }): Promise<DriveItem[]> {
  config ??= fetch("/api/picker").then((r) => r.json()).catch((e) => { config = null; throw e; });
  const [, cfg, token] = await Promise.all([load(), config, getToken()]);
  const g = (window as any).google.picker;
  const mimes = (opts.kind === "audio" ? AUDIO : IMAGES).join(",");
  const mine = new g.DocsView(g.ViewId.DOCS).setMimeTypes(mimes).setIncludeFolders(true).setOwnedByMe(true).setMode(g.DocsViewMode.GRID);
  const shared = new g.DocsView(g.ViewId.DOCS).setMimeTypes(mimes).setIncludeFolders(true).setOwnedByMe(false).setMode(g.DocsViewMode.GRID);
  return new Promise((resolve) => {
    let b = new g.PickerBuilder()
      .setAppId(cfg.appId)
      .setOAuthToken(token)
      .setOrigin(window.location.origin)
      .setLocale(opts.lang)
      .setTitle(opts.title)
      .addView(mine)
      .addView(shared)
      .setCallback((data: any) => {
        if (data.action === g.Action.PICKED) resolve((data.docs as Picked[]).map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType })));
        else if (data.action === g.Action.CANCEL) resolve([]);
      });
    if (cfg.key) b = b.setDeveloperKey(cfg.key);
    if (opts.multi) b = b.enableFeature(g.Feature.MULTISELECT_ENABLED);
    b.build().setVisible(true);
  });
}
