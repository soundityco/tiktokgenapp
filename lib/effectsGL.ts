/**
 * Lens and air effects on the GPU (WebGL 2), drawn over the graded picture, before the vignette and the grain:
 * - Black Mist (the diffusion filter): part of the light moved around it (a glow next to the lights, softer
 *   highlights), none added;
 * - Halation (film): a red-orange fringe around the strongest lights;
 * - Haze: an air of fog, denser towards the top of the frame (as the far away part of a shot) and over the bright,
 *   flat parts (the sky, the background), lit by the scene's own light.
 * The glows are blurred at a low resolution (a few passes on a picture 2 to 32 times smaller): light at any size.
 */

export interface Effects {
  /** Black Mist strength, 0-100; its glow size, 0-100. */
  mist: number; mistSize: number;
  /** Halation strength, 0-100; its size, 0-100. */
  halation: number; halationSize: number;
  /** Haze density, 0-100; how much it gathers at the top (0 = everywhere alike), 0-100; its tone, -100 cool to 100 warm. */
  haze: number; hazeHeight: number; hazeTone: number;
}

const VS = `#version 300 es
in vec2 p;
uniform float screen; // drawing on the canvas (its rows from the bottom): upside down from the textures
out vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, screen > 0.5 ? 1.0 - (p.y * 0.5 + 0.5) : p.y * 0.5 + 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

// The picture made smaller, in linear light: the scene, or only its brightest parts (a knee near white: the light
// that film's base reflects back, the halation). Sampled from the source's mipmaps (each level the average of the one
// above), so no pixel is skipped: no shimmering marks on a moving picture.
const PRE = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform float lod;
uniform float bright; // 0: the scene, 1: the strongest lights (halation), 2: the bright parts (mist)
in vec2 uv;
out vec4 o;
void main() {
  vec3 c = pow(textureLod(src, uv, lod).rgb, vec3(2.2));
  if (bright > 0.5) {
    float y = max(c.r, max(c.g, c.b));
    c *= bright > 1.5 ? smoothstep(0.3, 0.95, y) : smoothstep(0.6, 0.95, y);
  }
  o = vec4(c, 1.0);
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
uniform sampler2D mistT; // the bright parts' light, blurred close (the mist's halo)
uniform sampler2D mistW;  // the same, blurred wide (its faint tail)
uniform sampler2D halT;  // the brightest parts, blurred (the halation)
uniform sampler2D hazeT; // the scene, blurred wide (the air's light)
uniform float mist, halation, haze, hazeHeight, hazeTone;
in vec2 uv;
out vec4 o;
void main() {
  vec3 c = pow(texture(src, uv).rgb, vec3(2.2));
  if (haze > 0.0) {
    vec3 s = texture(hazeT, uv).rgb;
    // Denser towards the top (the far part of most shots), and over the bright and flat parts (blurred light).
    float up = 1.0 - uv.y;
    float height = mix(1.0, smoothstep(-0.1, 1.0, up), hazeHeight);
    float far = mix(0.55, 1.0, smoothstep(0.02, 0.5, dot(s, vec3(0.2126, 0.7152, 0.0722))));
    vec3 tone = hazeTone >= 0.0 ? mix(vec3(0.86, 0.86, 0.87), vec3(0.95, 0.84, 0.70), hazeTone) : mix(vec3(0.86, 0.86, 0.87), vec3(0.72, 0.82, 0.95), -hazeTone);
    vec3 air = tone * (0.18 + 0.5 * dot(s, vec3(0.3333))) + s * 0.55; // the air, lit by the scene
    c = mix(c, air, haze * 0.8 * height * clamp(far, 0.0, 1.0));
  }
  float own = max(c.r, max(c.g, c.b));
  if (mist > 0.0) {
    // The filter moves light, it adds none: the bright parts give some of theirs away (softer highlights), it falls
    // around them, mostly close to their edges (a halo), a little further (a faint tail). Dark and mid tones far from
    // a light stay as they are: no veil over the picture.
    vec3 lit = c * smoothstep(0.3, 0.95, own);
    vec3 m = 0.75 * texture(mistT, uv).rgb + 0.25 * texture(mistW, uv).rgb;
    c += mist * (m - lit);
  }
  if (halation > 0.0) {
    // Film's halation: a red-orange fringe around the strongest lights, on the darker side of their edge (inside a
    // light, already white, it would only tint it).
    vec3 h = texture(halT, uv).rgb;
    float here = own * smoothstep(0.6, 0.95, own); // this point's own strong light (as the blurred one was made)
    c += halation * max(dot(h, vec3(0.3333)) - here, 0.0) * vec3(1.0, 0.3, 0.1) * 2.5;
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
  private half = false;

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
    this.half = !!gl.getExtension("EXT_color_buffer_float");
    this.src = this.texture();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
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
    // Linear light in half floats where the GPU can draw in them (no banding in the dark glows), else 8 bits.
    if (this.half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    return t;
  }

  private draw(prog: WebGLProgram, to: Target | null, w: number, h: number, set: (u: (n: string) => WebGLUniformLocation | null) => void) {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, to?.fb ?? null);
    gl.viewport(0, 0, w, h);
    // Each pass keeps the textures' way up (rows from the top, as the source); only the last one turns it for the canvas.
    gl.uniform1f(gl.getUniformLocation(prog, "screen"), to ? 0 : 1);
    set((n) => gl.getUniformLocation(prog, n));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private bind(unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  /** The source made smaller (by `d`) and blurred (`sigma` source pixels), the bright parts only or the whole scene. */
  private blurred(name: string, W: number, H: number, sigma: number, bright: 0 | 1 | 2): WebGLTexture {
    const gl = this.gl;
    // The blur's own sigma is about 4 of its pixels, twice over: the picture made small enough for the size asked.
    const d = Math.min(32, Math.max(2, sigma / 5.5));
    const w = Math.max(4, Math.round(W / d)), h = Math.max(4, Math.round(H / d));
    const a = this.target(name + "a", w, h), b = this.target(name + "b", w, h);
    this.bind(0, this.src);
    this.draw(this.pre, a, w, h, (u) => { gl.uniform1i(u("src"), 0); gl.uniform1f(u("lod"), Math.max(0, Math.log2(d) - 0.5)); gl.uniform1f(u("bright"), bright); });
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
    gl.generateMipmap(gl.TEXTURE_2D);
    const side = Math.min(W, H);
    const mistT = e.mist > 0 ? this.blurred("mist", W, H, side * (0.006 + 0.03 * (e.mistSize / 100)), 2) : this.black;
    const mistW = e.mist > 0 ? this.blurred("mistw", W, H, side * (0.03 + 0.08 * (e.mistSize / 100)), 2) : this.black;
    const halT = e.halation > 0 ? this.blurred("hal", W, H, side * (0.004 + 0.025 * (e.halationSize / 100)), 1) : this.black;
    const hazeT = e.haze > 0 ? this.blurred("haze", W, H, side * 0.09, 0) : this.black;
    this.bind(0, this.src); this.bind(1, mistT); this.bind(2, halT); this.bind(3, hazeT); this.bind(4, mistW);
    this.draw(this.mix, null, W, H, (u) => {
      gl.uniform1i(u("src"), 0); gl.uniform1i(u("mistT"), 1); gl.uniform1i(u("halT"), 2); gl.uniform1i(u("hazeT"), 3); gl.uniform1i(u("mistW"), 4);
      gl.uniform1f(u("mist"), (e.mist / 100) * 0.45); gl.uniform1f(u("halation"), e.halation / 100);
      gl.uniform1f(u("haze"), e.haze / 100); gl.uniform1f(u("hazeHeight"), e.hazeHeight / 100); gl.uniform1f(u("hazeTone"), e.hazeTone / 100);
    });
    return this.canvas;
  }
}

let shared: EffectsGL | null = null;
let failed = false;

/** Are there effects to draw? */
export const effectsOn = (e: Partial<Effects>) => (e.mist ?? 0) > 0 || (e.halation ?? 0) > 0 || (e.haze ?? 0) > 0;

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
