import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultWorkspace, normalizeWorkspace } from "../lib/defaults";
import type { Workspace } from "../lib/types";
import { FR } from "../lib/fr";
import { looksLikeImage, sniff } from "../lib/imageFormat";
import { translate } from "../lib/translate";
import { cleanLines } from "../lib/ocr";
import { coverAllowed } from "../lib/tiktok";

const bytes = (...b: number[]) => Uint8Array.from([...b, ...new Array(16).fill(0)].slice(0, 16));
/** 16 bytes with ASCII strings written at given offsets, e.g. mk(["ftyp", 4], ["heic", 8]). */
const mk = (...parts: [string, number][]) => { const a = new Uint8Array(16); parts.forEach(([s, at]) => [...s].forEach((c, i) => (a[at + i] = c.charCodeAt(0)))); return a; };

describe("sniff (real format from the first bytes)", () => {
  it("detects the common formats", () => {
    expect(sniff(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg");
    expect(sniff(bytes(0x89, 0x50, 0x4e, 0x47))).toBe("png");
    expect(sniff(mk(["GIF89a", 0]))).toBe("gif");
    expect(sniff(bytes(0x42, 0x4d))).toBe("bmp");
    expect(sniff(mk(["RIFF", 0], ["WEBP", 8]))).toBe("webp");
    expect(sniff(bytes(0x49, 0x49, 42, 0))).toBe("tiff");
    expect(sniff(bytes(0x4d, 0x4d, 0, 42))).toBe("tiff");
  });
  it("tells HEIC and AVIF apart from the ftyp brand", () => {
    expect(sniff(mk(["ftyp", 4], ["heic", 8]))).toBe("heic");
    expect(sniff(mk(["ftyp", 4], ["mif1", 8]))).toBe("heic");
    expect(sniff(mk(["ftyp", 4], ["avif", 8]))).toBe("avif");
  });
  it("unknown bytes", () => expect(sniff(bytes(1, 2, 3, 4))).toBe("unknown"));
});

describe("looksLikeImage", () => {
  it("accepts by MIME or extension (iPhone files are often octet-stream)", () => {
    expect(looksLikeImage("a.heic", "application/octet-stream")).toBe(true);
    expect(looksLikeImage("a.JPG", "image/jpeg")).toBe(true);
    expect(looksLikeImage("scan.tif", "image/tiff")).toBe(true);
  });
  it("rejects SVG, documents and videos", () => {
    expect(looksLikeImage("a.svg", "image/svg+xml")).toBe(false);
    expect(looksLikeImage("a.pdf", "application/pdf")).toBe(false);
    expect(looksLikeImage("a.mov", "video/quicktime")).toBe(false);
  });
});

describe("OCR line cleaning", () => {
  it("keeps a short last line of a hook", () => {
    const out = cleanLines([{ text: "tell me you've felt this without telling", confidence: 90 }, { text: "me", confidence: 70 }]);
    expect(out.map((l) => l.text).join(" ")).toBe("tell me you've felt this without telling me");
  });
  it("drops TikTok interface words and low-confidence noise", () => {
    expect(cleanLines([{ text: "For You", confidence: 95 }, { text: "Following", confidence: 95 }])).toEqual([]);
    expect(cleanLines([{ text: "x#@!", confidence: 30 }])).toEqual([]);
  });
  it("a lone tiny fragment is noise", () => expect(cleanLines([{ text: "ab", confidence: 90 }])).toEqual([]));
});

describe("TikTok cover proxy allow-list", () => {
  it("allows TikTok CDNs over https", () => {
    expect(coverAllowed(new URL("https://p16-sign-va.tiktokcdn.com/obj/x.jpg"))).toBe(true);
    expect(coverAllowed(new URL("https://p19-sign.tiktokcdn-us.com/x.jpg"))).toBe(true);
  });
  it("blocks everything else (SSRF guard)", () => {
    expect(coverAllowed(new URL("https://evil.example.com/x.jpg"))).toBe(false);
    expect(coverAllowed(new URL("https://tiktokcdn.com.evil.io/x.jpg"))).toBe(false);
    expect(coverAllowed(new URL("http://p16.tiktokcdn.com/x.jpg"))).toBe(false);
    expect(coverAllowed(new URL("http://169.254.169.254/latest/meta-data"))).toBe(false);
  });
});

describe("i18n", () => {
  it("interpolates and falls back to English", () => {
    expect(translate("fr", "Slide {n}", { n: 2 })).toBe("Slide 2");
    expect(translate("fr", "Generate")).toBe("Générer");
    expect(translate("fr", "Not in the dictionary")).toBe("Not in the dictionary");
  });
  it("singular forms", () => {
    expect(translate("en", "{n} photos", { n: 1 })).toBe("1 photo");
    expect(translate("fr", "{n} texts", { n: 1 })).toBe("1 texte");
    expect(translate("en", "{n} photos", { n: 12 })).toBe("12 photos");
  });
  it("every t(\"…\") used in the code has a French translation", () => {
    const root = path.resolve(__dirname, "..");
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => {
      if (["node_modules", ".next", "tests", ".git"].includes(f)) return;
      const full = path.join(d, f);
      statSync(full).isDirectory() ? walk(full) : /\.(tsx?)$/.test(f) && files.push(full);
    });
    walk(root);
    const missing = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
        const k = m[1].replace(/\\"/g, '"');
        if (!(k in FR)) missing.add(k);
      }
    }
    expect([...missing]).toEqual([]);
  });
});

describe("video clips per release", () => {
  it("migrates the old single video setup into the first clip", () => {
    const ws = defaultWorkspace();
    const base = ws.projects[0];
    const legacy = {
      ...ws,
      projects: [{
        id: base.id,
        name: base.name,
        slides: base.slides,
        lyrics: [],
        lyricsSectionId: null,
        generated: null,
        selectedSlide: 0,
        video: {
          crop: { start: 3, duration: 12 },
          offset: 4.2,
          score: 0.9,
          captions: false,
          frame: { zoom: 1.2, ox: 0.1, oy: -0.2 },
          audioName: "song.mp3",
          videoName: "take.mov",
        },
      }],
    } as unknown as Workspace;
    const p = normalizeWorkspace(legacy).projects[0];
    expect(p.videos).toHaveLength(1);
    expect(p.videos[0].id).toBe(base.id); // keeps the legacy IndexedDB media keys
    expect(p.videos[0].name).toBe("Video 1");
    expect(p.videos[0].crop).toEqual({ start: 3, duration: 12 });
    expect(p.videos[0].offset).toBe(4.2);
    expect(p.videos[0].audioName).toBe("song.mp3");
    expect(p.videos[0].videoName).toBe("take.mov");
    expect(p.videoId).toBe(base.id);
    expect(p.video).toBeUndefined();
  });

  it("keeps several clips and repairs an unknown selection", () => {
    const ws = defaultWorkspace();
    const p = ws.projects[0];
    const second = { ...p.videos[0], id: "clip-2", name: "Video 2", offset: 7 };
    const out = normalizeWorkspace({ ...ws, projects: [{ ...p, videos: [p.videos[0], second], videoId: "missing" }] });
    expect(out.projects[0].videos.map((v) => v.id)).toEqual([p.videos[0].id, "clip-2"]);
    expect(out.projects[0].videoId).toBe(p.videos[0].id);
  });
});

describe("workspace revision (no silent overwrite between devices)", () => {
  it("rejects a save based on a stale revision", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tktgen-"));
    process.chdir(dir);
    delete process.env.DATABASE_URL; delete process.env.NETLIFY_DATABASE_URL;
    const { saveWorkspaceCas, loadWorkspace } = await import("../lib/db");
    const ws = { v: 1, projects: [] };
    const a = await saveWorkspaceCas("me@x.com", ws, 0);
    expect(a).toEqual({ ok: true, rev: 1 });
    const stale = await saveWorkspaceCas("me@x.com", ws, 0); // another tab still thinks rev 0
    expect(stale).toEqual({ ok: false, rev: 1 });
    const b = await saveWorkspaceCas("me@x.com", ws, 1);
    expect(b).toEqual({ ok: true, rev: 2 });
    expect(((await loadWorkspace("me@x.com")) as any).rev).toBe(2);
  });
});
