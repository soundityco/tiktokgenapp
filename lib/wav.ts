/**
 * A WAV file (16-bit PCM) from decoded sound: the sound of a video kept as an audio file (the reference audio of a live
 * take, a guitar-voice filmed on a phone…), played, synced on and exported as any imported audio.
 */
export function wavOf(channels: Float32Array[], rate: number): Blob {
  const n = channels[0]?.length ?? 0, ch = Math.max(1, channels.length), bytes = n * ch * 2;
  const out = new ArrayBuffer(44 + bytes), v = new DataView(out);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF"); v.setUint32(4, 36 + bytes, true); text(8, "WAVE");
  text(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  text(36, "data"); v.setUint32(40, bytes, true);
  let at = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const x = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(at, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      at += 2;
    }
  }
  return new Blob([out], { type: "audio/wav" });
}
