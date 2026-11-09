/**
 * The colour grade of the export on the GPU, from the camera's own 10-bit values (WebGL 2).
 *
 * The browser draws a video frame in 8 bits: grading log footage from there bands the gradients. Here the decoded
 * frame's Y, Cb and Cr planes are read as they are (10 bits kept), only the part the post shows; the shader turns
 * them into RGB (BT.709, video range, as the ffmpeg path did), applies the 3D LUT with the same tetrahedral
 * interpolation as ffmpeg, scales to the size drawn, and only then gives 8 bits. Same picture as the ffmpeg path,
 * many times faster (decoded by the video chip, graded by the graphics card).
 */

import type { ConvertCrop } from "./convert";
import type { Picture } from "./videoSource";
import { VideoSource } from "./videoSource";

const VS = `#version 300 es
in vec2 p;
out vec2 at;
void main() {
  at = p * 0.5 + 0.5;
  at.y = 1.0 - at.y;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler3D;
uniform usampler2D yT;
uniform usampler2D uT;
uniform usampler2D vT;
uniform sampler3D lut;
uniform int n;          // LUT size
uniform int nv12;       // chroma interleaved in one plane (u = first, v = second)
uniform vec2 sub;       // chroma subsampling (2, 2 for 4:2:0; 2, 1 for 4:2:2; 1, 1 for 4:4:4)
uniform vec4 crop;      // x, y, w, h of the part graded, in upright picture pixels
uniform vec2 up;        // upright picture size
uniform vec2 rawOrigin; // where the planes read start, in raw frame pixels
uniform int rot;        // 0, 90, 180, 270: how the raw frame is turned to be upright
uniform vec2 outSize;
uniform vec4 range;     // y black, y span, c middle, c span (code values)
uniform int taps;       // samples per axis per output pixel (2 when scaling down a lot)
in vec2 at;
out vec4 color;

float fetchY(vec2 q) {
  ivec2 s = textureSize(yT, 0);
  vec2 p = q - 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = p - vec2(i);
  ivec2 a = clamp(i, ivec2(0), s - 1), b = clamp(i + 1, ivec2(0), s - 1);
  float v00 = float(texelFetch(yT, ivec2(a.x, a.y), 0).r), v10 = float(texelFetch(yT, ivec2(b.x, a.y), 0).r);
  float v01 = float(texelFetch(yT, ivec2(a.x, b.y), 0).r), v11 = float(texelFetch(yT, ivec2(b.x, b.y), 0).r);
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}
vec2 fetchC(vec2 q) {
  ivec2 s = textureSize(uT, 0);
  // Chroma centred between its luma samples, as ffmpeg's conversion reads it (the picture the export gave before).
  vec2 p = q / sub - 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = p - vec2(i);
  ivec2 a = clamp(i, ivec2(0), s - 1), b = clamp(i + 1, ivec2(0), s - 1);
  vec2 c00, c10, c01, c11;
  if (nv12 == 1) {
    c00 = vec2(texelFetch(uT, ivec2(a.x, a.y), 0).rg); c10 = vec2(texelFetch(uT, ivec2(b.x, a.y), 0).rg);
    c01 = vec2(texelFetch(uT, ivec2(a.x, b.y), 0).rg); c11 = vec2(texelFetch(uT, ivec2(b.x, b.y), 0).rg);
  } else {
    c00 = vec2(float(texelFetch(uT, ivec2(a.x, a.y), 0).r), float(texelFetch(vT, ivec2(a.x, a.y), 0).r));
    c10 = vec2(float(texelFetch(uT, ivec2(b.x, a.y), 0).r), float(texelFetch(vT, ivec2(b.x, a.y), 0).r));
    c01 = vec2(float(texelFetch(uT, ivec2(a.x, b.y), 0).r), float(texelFetch(vT, ivec2(a.x, b.y), 0).r));
    c11 = vec2(float(texelFetch(uT, ivec2(b.x, b.y), 0).r), float(texelFetch(vT, ivec2(b.x, b.y), 0).r));
  }
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}
vec3 lutAt(ivec3 i) { return texelFetch(lut, i, 0).rgb; }
// Tetrahedral interpolation, as ffmpeg's lut3d=interp=tetrahedral.
vec3 grade(vec3 c) {
  float m = float(n - 1);
  vec3 p = clamp(c, 0.0, 1.0) * m;
  ivec3 i0 = ivec3(min(floor(p), vec3(m - 1.0)));
  vec3 f = p - vec3(i0);
  ivec3 i1 = i0 + 1;
  vec3 c000 = lutAt(i0), c111 = lutAt(i1);
  if (f.x > f.y) {
    if (f.y > f.z) return (1.0 - f.x) * c000 + (f.x - f.y) * lutAt(ivec3(i1.x, i0.y, i0.z)) + (f.y - f.z) * lutAt(ivec3(i1.x, i1.y, i0.z)) + f.z * c111;
    if (f.x > f.z) return (1.0 - f.x) * c000 + (f.x - f.z) * lutAt(ivec3(i1.x, i0.y, i0.z)) + (f.z - f.y) * lutAt(ivec3(i1.x, i0.y, i1.z)) + f.y * c111;
    return (1.0 - f.z) * c000 + (f.z - f.x) * lutAt(ivec3(i0.x, i0.y, i1.z)) + (f.x - f.y) * lutAt(ivec3(i1.x, i0.y, i1.z)) + f.y * c111;
  }
  if (f.z > f.y) return (1.0 - f.z) * c000 + (f.z - f.y) * lutAt(ivec3(i0.x, i0.y, i1.z)) + (f.y - f.x) * lutAt(ivec3(i0.x, i1.y, i1.z)) + f.x * c111;
  if (f.z > f.x) return (1.0 - f.y) * c000 + (f.y - f.z) * lutAt(ivec3(i0.x, i1.y, i0.z)) + (f.z - f.x) * lutAt(ivec3(i0.x, i1.y, i1.z)) + f.x * c111;
  return (1.0 - f.y) * c000 + (f.y - f.x) * lutAt(ivec3(i0.x, i1.y, i0.z)) + (f.x - f.z) * lutAt(ivec3(i1.x, i1.y, i0.z)) + f.z * c111;
}
vec3 sampleAt(vec2 o) {
  // Output position -> upright picture -> raw frame -> the planes read.
  vec2 u = crop.xy + o * crop.zw;
  vec2 r;
  if (rot == 90) r = vec2(u.y, up.x - u.x);
  else if (rot == 180) r = vec2(up.x - u.x, up.y - u.y);
  else if (rot == 270) r = vec2(up.y - u.y, u.x);
  else r = u;
  r -= rawOrigin;
  float y = (fetchY(r) - range.x) / range.y;
  vec2 c = (fetchC(r) - range.z) / range.w;
  return vec3(y + 1.5748 * c.y, y - 0.187324 * c.x - 0.468124 * c.y, y + 1.8556 * c.x);
}
void main() {
  vec2 px = at * outSize; // this output pixel's centre, in output pixels
  vec3 sum = vec3(0.0);
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    if (i >= taps || j >= taps) continue;
    vec2 o = (floor(px) + (vec2(float(i), float(j)) + 0.5) / float(taps)) / outSize;
    sum += sampleAt(o);
  }
  color = vec4(grade(sum / float(taps * taps)), 1.0);
}`;

type Plane = { tex: WebGLTexture; w: number; h: number };

/** One WebGL 2 context for the export's grade (made once a page). */
class Grade10 {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private planes: [Plane, Plane, Plane];
  private lut: WebGLTexture;
  private size = 0;
  private u: Record<string, WebGLUniformLocation | null> = {};

  constructor() {
    this.canvas = document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false });
    if (!gl) throw new Error("no WebGL 2");
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "program");
    gl.useProgram(prog);
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const k of ["n", "nv12", "sub", "crop", "up", "rawOrigin", "rot", "outSize", "range", "taps"]) this.u[k] = gl.getUniformLocation(prog, k);
    const tex = (unit: number, target: number) => {
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, t);
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.planes = [0, 1, 2].map((i) => ({ tex: tex(i, gl.TEXTURE_2D), w: 0, h: 0 })) as [Plane, Plane, Plane];
    this.lut = tex(3, gl.TEXTURE_3D);
    gl.uniform1i(gl.getUniformLocation(prog, "yT"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "uT"), 1);
    gl.uniform1i(gl.getUniformLocation(prog, "vT"), 2);
    gl.uniform1i(gl.getUniformLocation(prog, "lut"), 3);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  get lost() { return this.gl.isContextLost(); }

  setLut(data: Float32Array, size: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, this.lut);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, size, size, size, 0, gl.RGB, gl.FLOAT, data);
    this.size = size;
    gl.uniform1i(this.u.n, size);
  }

  private upload(i: number, w: number, h: number, data: ArrayBufferView, wide: boolean, pairs: boolean) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, this.planes[i].tex);
    const [inner, fmt, type] = pairs
      ? (wide ? [gl.RG16UI, gl.RG_INTEGER, gl.UNSIGNED_SHORT] : [gl.RG8UI, gl.RG_INTEGER, gl.UNSIGNED_BYTE])
      : (wide ? [gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT] : [gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE]);
    gl.texImage2D(gl.TEXTURE_2D, 0, inner, w, h, 0, fmt, type, data);
  }

  /** The part `crop` of the upright picture (upW×upH) of `frame`, graded, `crop.out` in size; false when the frame's
   *  pixel format cannot be read this way. */
  async draw(frame: VideoFrame, rotation: number, crop: ConvertCrop, upW: number, upH: number): Promise<boolean> {
    const fmt = frame.format;
    const spec = FORMATS[fmt ?? ""];
    if (!spec || !this.size) return false;
    // The rectangle of the raw frame under the crop (even, for the chroma).
    const rawW = frame.codedWidth, rawH = frame.codedHeight;
    let rx = crop.x, ry = crop.y, rw = crop.w, rh = crop.h;
    if (rotation === 90) { rx = crop.y; ry = upW - crop.x - crop.w; rw = crop.h; rh = crop.w; }
    else if (rotation === 180) { rx = upW - crop.x - crop.w; ry = upH - crop.y - crop.h; }
    else if (rotation === 270) { rx = upH - crop.y - crop.h; ry = crop.x; rw = crop.h; rh = crop.w; }
    const vis = frame.visibleRect ?? { x: 0, y: 0, width: frame.displayWidth, height: frame.displayHeight };
    const even = (n: number) => Math.floor(n / 2) * 2;
    const x0 = even(Math.max(0, rx - 2)), y0 = even(Math.max(0, ry - 2));
    const x1 = Math.min(even(vis.width), Math.ceil((rx + rw + 2) / 2) * 2), y1 = Math.min(even(vis.height), Math.ceil((ry + rh + 2) / 2) * 2);
    if (x1 <= x0 || y1 <= y0 || rawW < x1 || rawH < y1) return false;
    const rect = { x: vis.x + x0, y: vis.y + y0, width: x1 - x0, height: y1 - y0 };
    const size = frame.allocationSize({ rect });
    const buf = spec.wide ? new Uint16Array(size / 2) : new Uint8Array(size);
    const layout = await frame.copyTo(buf, { rect });
    const unit = spec.wide ? 2 : 1;
    const cw = Math.ceil(rect.width / spec.sub[0]), ch = Math.ceil(rect.height / spec.sub[1]);
    const view = (k: number, w: number, h: number, comps: number) => {
      const l = layout[k];
      // Rows packed one after the other (no padding) for the upload.
      const rowLen = w * comps;
      const stride = l.stride / unit, off = l.offset / unit;
      if (stride === rowLen) return buf.subarray(off, off + rowLen * h);
      const out = spec.wide ? new Uint16Array(rowLen * h) : new Uint8Array(rowLen * h);
      for (let y = 0; y < h; y++) out.set(buf.subarray(off + y * stride, off + y * stride + rowLen), y * rowLen);
      return out;
    };
    this.upload(0, rect.width, rect.height, view(0, rect.width, rect.height, 1), spec.wide, false);
    if (spec.nv12) this.upload(1, cw, ch, view(1, cw, ch, 2), spec.wide, true);
    else { this.upload(1, cw, ch, view(1, cw, ch, 1), spec.wide, false); this.upload(2, cw, ch, view(2, cw, ch, 1), spec.wide, false); }

    const gl = this.gl;
    const w = crop.out.w, h = crop.out.h;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.uniform1i(this.u.nv12, spec.nv12 ? 1 : 0);
    gl.uniform2f(this.u.sub, spec.sub[0], spec.sub[1]);
    gl.uniform4f(this.u.crop, crop.x, crop.y, crop.w, crop.h);
    gl.uniform2f(this.u.up, upW, upH);
    gl.uniform2f(this.u.rawOrigin, x0, y0);
    gl.uniform1i(this.u.rot, rotation);
    gl.uniform2f(this.u.outSize, w, h);
    const full = !!frame.colorSpace?.fullRange;
    const b = spec.wide ? 4 : 1; // 10-bit values are the 8-bit ones ×4
    gl.uniform4f(this.u.range, full ? 0 : 16 * b, full ? 255 * b : 219 * b, 128 * b, full ? 255 * b : 224 * b);
    gl.uniform1i(this.u.taps, crop.w / w > 1.5 ? 2 : 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
}

/** How each pixel format of WebCodecs is laid out. 10-bit formats are 16-bit values (0-1023). */
const FORMATS: Record<string, { wide: boolean; nv12: boolean; sub: [number, number] }> = {
  I420: { wide: false, nv12: false, sub: [2, 2] },
  I422: { wide: false, nv12: false, sub: [2, 1] },
  I444: { wide: false, nv12: false, sub: [1, 1] },
  NV12: { wide: false, nv12: true, sub: [2, 2] },
  I420P10: { wide: true, nv12: false, sub: [2, 2] },
  I422P10: { wide: true, nv12: false, sub: [2, 1] },
  I444P10: { wide: true, nv12: false, sub: [1, 1] },
};

let shared: Grade10 | null = null;

/**
 * The camera file's frames for the export, graded on the GPU from their own values: each `frameAt` gives the part
 * `crop` of the upright picture, graded, as the ffmpeg conversion did (`graded`, `part` = crop). Null when this
 * browser cannot (no WebCodecs decoding of the format, no WebGL 2, a pixel format it cannot read): ffmpeg then.
 */
export async function gpuGradedSource(file: Blob, from: number, to: number, crop: ConvertCrop, upW: number, upH: number,
  lut: Float32Array, lutSize: number, onProgress?: (p: number) => void, signal?: AbortSignal) {
  if (typeof VideoFrame === "undefined") return null;
  let g: Grade10;
  try {
    if (!shared || shared.lost) shared = new Grade10();
    g = shared;
    g.setLut(lut, lutSize);
  } catch (e) { console.info("[grade10] no GPU grade:", e); return null; }
  // Decoded in software when the browser can: its frames give their planes (a hardware frame often does not).
  const src = await VideoSource.open(file, from, to, onProgress, signal, "prefer-software");
  if (!src) return null;
  // The first frame tells whether its pixel format can be read.
  try {
    const f = await src.rawAt(from);
    if (!f || !(await g.draw(f, src.rotation, crop, upW, upH))) {
      console.info("[grade10] pixel format not readable:", f?.format ?? "none");
      src.close();
      return null;
    }
  } catch (e) { console.info("[grade10] first frame failed:", e); src.close(); return null; }
  console.info("[grade10] export graded on the GPU from the decoded frames:", src.codec);
  return {
    codec: src.codec,
    async frameAt(t: number): Promise<Picture | null> {
      const f = await src.rawAt(t);
      if (!f) return null;
      if (!(await g.draw(f, src.rotation, crop, upW, upH))) throw new Error("frame format changed");
      return { src: g.canvas, w: upW, h: upH, part: crop, graded: true };
    },
    close: () => src.close(),
  };
}
