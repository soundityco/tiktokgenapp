"use client";
import { useState } from "react";
import { decodeAudio } from "@/lib/media";
import { parseLyrics } from "@/lib/lyricsAlign";
import { placeByAlignment, placeExact } from "@/lib/lyricsPipeline";
import { hasGpu } from "@/lib/transcribe";

type Line = { text: string; start: number; end: number; doubt: boolean };
declare global { interface Window { __lyricsResult?: { lines: Line[]; words?: { w: string; s: number; e: number; line?: number }[]; ms: number } | { error: string } } }

/**
 * Dev bench (app/dev/lyrics): an audio file and its lyrics placed by the very code of the video studio
 * (lib/lyricsPipeline), so a test of it is a test of the app. Nothing is saved.
 */
export default function LyricsBench() {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [lang, setLang] = useState("french");
  const [log, setLog] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const run = async () => {
    if (!file || !text.trim()) return;
    setLines([]); setLog("decoding…"); window.__lyricsResult = undefined;
    const t0 = performance.now();
    try {
      const buf = await decodeAudio(new AudioContext(), file);
      const written = parseLyrics(text).text;
      const heard = await placeByAlignment(buf, written, {
        model: hasGpu() ? "turbo" : "base", language: lang,
        onStep: (s) => setLog(`step ${s}`), onRelay: () => setLog("relay…"),
      });
      if (!heard) { window.__lyricsResult = { error: "alignment not available" }; setLog("alignment not available"); return; }
      const words = placeExact(written, heard);
      const byLine = new Map<number, typeof words>();
      for (const w of words) (byLine.get(w.line ?? -1) ?? byLine.set(w.line ?? -1, []).get(w.line ?? -1)!).push(w);
      const out = [...byLine.values()].map((ws) => ({ text: ws.map((w) => w.w).join(" "), start: ws[0].s, end: ws[ws.length - 1].e, doubt: heard.some((h) => h.line === ws[0].line && h.doubt) }));
      setLines(out);
      const ms = Math.round(performance.now() - t0);
      setLog(`done in ${(ms / 1000).toFixed(1)} s`);
      window.__lyricsResult = { lines: out, words: words.map((w) => ({ w: w.w, s: w.s, e: w.e, line: w.line })), ms };
    } catch (e) {
      window.__lyricsResult = { error: String(e) };
      setLog(String(e));
    }
  };
  return (
    <main style={{ padding: 16, maxWidth: 900, margin: "0 auto", display: "grid", gap: 8 }}>
      <h1 style={{ fontSize: 18 }}>Lyrics bench (dev)</h1>
      <input id="audio" type="file" accept="audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <textarea id="lyrics" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder="Lyrics" />
      <input id="lang" value={lang} onChange={(e) => setLang(e.target.value)} />
      <button id="run" onClick={() => void run()}>Run</button>
      <div id="log" className="mono">{log}</div>
      <table className="mono" style={{ fontSize: 12 }}><tbody>
        {lines.map((l, i) => <tr key={i}><td>{l.start.toFixed(2)}</td><td>{l.end.toFixed(2)}</td><td>{l.doubt ? "?" : ""}</td><td>{l.text}</td></tr>)}
      </tbody></table>
    </main>
  );
}
