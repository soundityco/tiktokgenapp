/**
 * Lens and air effects on the GPU (WebGL 2), drawn over the graded picture, before the vignette and the grain:
 * - Black Mist (the diffusion filter): the light of the bright parts spread around them (a wide glow, warmer at
 *   its edge with the halation), the highlights softened, the blacks barely lifted;
 * - Haze: an air of fog, denser towards the top of the frame (as the far away part of a shot) and over the bright,
 *   flat parts (the sky, the background), lit by the scene's own light.
 * The glows are blurred at a low resolution (a few passes on a picture 2 to 32 times smaller): light at any size.
 */

export interface Effects {
  /** Black Mist strength, 0-100; its glow size, 0-100; the warm edge of the glow (halation), 0-100. */
  mist: number; mistSize: number; halation: number;
  /** Haze density, 0-100; how much it gathers at the top (0 = everywhere alike), 0-100; its tone, -100 cool to 100 warm. */
  haze: number; hazeHeight: number; hazeTone: number;
}

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 1.0 - (p.y * 0.5 + 0.5)); gl_Position = vec4(p, 0.0, 1.0); }`;

// The picture made smaller, in linear light (stored with a square root, enough for a blur in 8 bits): the scene, or
// only its bright parts (a soft knee from mid grey up, as the light a mist filter catches).
const PRE = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 px; // one source pixel
uniform float bright;
in vec2 uv;
out vec4 o;
vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
void main() {
  vec3 c = 0.25 * (lin(texture(src, uv + px * vec2(-0.5, -0.5)).rgb) + lin(texture(src, uv + px * vec2(0.5, -0.5)).rgb)
    + lin(texture(src, uv + px * vec2(-0.5, 0.5)).rgb) + lin(texture(src, uv + px * vec2(0.5, 0.5)).rgb));
  if (bright > 0.5) {
    float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c *= smoothstep(0.12, 0.8, y);
  }
  o = vec4(sqrt(clamp(c, 0.0, 1.0)), 1.0);
}`;

// A gaussian blur along one direction (9 linear samples = 17 taps, sigma about 4 pixels).
const BLUR = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 dir; // one pixel along the blur
in vec2 uv;
out vec4 o;
void main() {
  const float w[5] = float[](0.1974, 0.1747, 0.1210, 0.0656, 0.0278);
  const float d[5] = float[](0.0, 1.4588, 3.4048, 5.3518, 7.3010);
  vec3 c = texture(src, uv).rgb * w[0];
  float t = w[0];
  for (int i = 1; i < 5; i++) {
    c += (texture(src, uv + dir * d[i]).rgb + texture(src, uv - dir * d[i]).rgb) * w[i];
    t += 2.0 * w[i];
  }
  o = vec4(c / t, 1.0);
}`;

const MIX = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform sampler2D glow;  // the bright parts, blurred
uniform sampler2D scene; // the whole scene, blurred wide
uniform float mist, halation, haze, hazeHeight, hazeTone;
in vec2 uv;
out vec4 o;
vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 sq(vec3 c) { return c * c; }
void main() {
  vec3 c = lin(texture(src, uv).rgb);
  vec3 s = sq(texture(scene, uv).rgb);
  if (haze > 0.0) {
    // Denser towards the top (the far part of most shots), and over the bright and flat parts (blurred light).
    float up = 1.0 - uv.y;
    float height = mix(1.0, smoothstep(-0.1, 1.0, up), hazeHeight);
    float far = mix(0.55, 1.0, smoothstep(0.02, 0.5, dot(s, vec3(0.2126, 0.7152, 0.0722))));
    vec3 tone = hazeTone >= 0.0 ? mix(vec3(0.86, 0.86, 0.87), vec3(0.95, 0.84, 0.70), hazeTone) : mix(vec3(0.86, 0.86, 0.87), vec3(0.72, 0.82, 0.95), -hazeTone);
    vec3 air = tone * (0.18 + 0.5 * dot(s, vec3(0.3333))) + s * 0.55; // the air, lit by the scene
    c = mix(c, air, haze * 0.8 * height * far);
  }
  if (mist > 0.0) {
    vec3 g = sq(texture(glow, uv).rgb);
    // The halation: the glow warmer (red, orange), most at its faint edge.
    float edge = 1.0 - smoothstep(0.0, 0.35, dot(g, vec3(0.3333)));
    vec3 warm = mix(vec3(1.0), vec3(1.35, 0.72, 0.45), halation * (0.5 + 0.5 * edge));
    c += g * warm * mist * 1.1;
    c += mist * 0.01; // the blacks barely lifted
    // The highlights softened (1 stays 1, the light above it bent down).
    float k = mist * 0.35;
    c = c * (1.0 + k) / (1.0 + k * c);
  }
  o = vec4(pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

type Target = { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number };

class EffectsGL {
  readonly canvas = document.createElement("canvas");
  private gl: WebGL2RenderingContext;
  private pre: WebGLProgram; private blur: WebGLProgram; private mix: WebGLProgram;
  private src: WebGLTexture;
  private targets = new Map<string, Target>();
  private black: WebGLTexture;

  constructor() {
    const gl = this.canvas.getContext("webgl2", { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false });
    if (!gl) throw new Error("no WebGL 2");
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const prog = (fs: string) => {
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, "p");
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "program");
      return p;
    };
    this.pre = prog(PRE); this.blur = prog(BLUR); this.mix = prog(MIX);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.src = this.texture();
    this.black = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }

  get lost() { return this.gl.isContextLost(); }

  private texture() {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  }

  private target(name: string, w: number, h: number): Target {
    const gl = this.gl;
    let t = this.targets.get(name);
    if (t && t.w === w && t.h === h) return t;
    if (!t) { t = { tex: this.texture(), fb: gl.createFramebuffer()!, w, h }; this.targets.set(name, t); }
    t.w = w; t.h = h;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    return t;
  }

  private draw(prog: WebGLProgram, to: Target | null, w: number, h: number, set: (u: (n: string) => WebGLUniformLocation | null) => void) {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, to?.fb ?? null);
    gl.viewport(0, 0, w, h);
    set((n) => gl.getUniformLocation(prog, n));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private bind(unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  /** The source made smaller (by `d`) and blurred (`sigma` source pixels), the bright parts only or the whole scene. */
  private blurred(name: string, W: number, H: number, sigma: number, bright: boolean): WebGLTexture {
    const gl = this.gl;
    // The blur's own sigma is about 4 of its pixels, twice over: the picture made small enough for the size asked.
    const d = Math.min(32, Math.max(2, sigma / 5.5));
    const w = Math.max(4, Math.round(W / d)), h = Math.max(4, Math.round(H / d));
    const a = this.target(name + "a", w, h), b = this.target(name + "b", w, h);
    this.bind(0, this.src);
    this.draw(this.pre, a, w, h, (u) => { gl.uniform1i(u("src"), 0); gl.uniform2f(u("px"), 1 / W, 1 / H); gl.uniform1f(u("bright"), bright ? 1 : 0); });
    for (let i = 0; i < 2; i++) {
      this.bind(0, a.tex);
      this.draw(this.blur, b, w, h, (u) => { gl.uniform1i(u("src"), 0); gl.uniform2f(u("dir"), 1 / w, 0); });
      this.bind(0, b.tex);
      this.draw(this.blur, a, w, h, (u) => { gl.uniform1i(u("src"), 0); gl.uniform2f(u("dir"), 0, 1 / h); });
    }
    return a.tex;
  }

  /** The canvas `source` (W×H) with the effects, on this object's canvas. */
  run(source: TexImageSource, W: number, H: number, e: Effects): HTMLCanvasElement {
    const gl = this.gl;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    this.bind(0, this.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const side = Math.min(W, H);
    const glow = e.mist > 0 ? this.blurred("mist", W, H, side * (0.012 + 0.08 * (e.mistSize / 100)), true) : this.black;
    const scene = e.haze > 0 ? this.blurred("haze", W, H, side * 0.09, false) : this.black;
    this.bind(0, this.src); this.bind(1, glow); this.bind(2, scene);
    this.draw(this.mix, null, W, H, (u) => {
      gl.uniform1i(u("src"), 0); gl.uniform1i(u("glow"), 1); gl.uniform1i(u("scene"), 2);
      gl.uniform1f(u("mist"), e.mist / 100); gl.uniform1f(u("halation"), e.halation / 100);
      gl.uniform1f(u("haze"), e.haze / 100); gl.uniform1f(u("hazeHeight"), e.hazeHeight / 100); gl.uniform1f(u("hazeTone"), e.hazeTone / 100);
    });
    return this.canvas;
  }
}

let shared: EffectsGL | null = null;
let failed = false;

/** Are there effects to draw? */
export const effectsOn = (e: Partial<Effects>) => (e.mist ?? 0) > 0 || (e.haze ?? 0) > 0;

/** The effects over the whole canvas of `ctx` (nothing when the browser has no WebGL 2). */
export function drawEffects(ctx: CanvasRenderingContext2D, e: Effects) {
  if (failed || !effectsOn(e)) return;
  try {
    if (!shared || shared.lost) shared = new EffectsGL();
    const out = shared.run(ctx.canvas, ctx.canvas.width, ctx.canvas.height, e); // the canvas in its own pixels
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(out, 0, 0);
    ctx.restore();
  } catch (err) {
    failed = true;
    console.warn("[effects] WebGL 2 unavailable: no Black Mist or Haze", err);
  }
}
