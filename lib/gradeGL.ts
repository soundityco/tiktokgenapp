/**
 * Live colour grade of the camera picture on the GPU (WebGL 2): one 3D LUT lookup per pixel (see lib/grade.ts).
 * Only the part of the picture seen in the post is graded, at the size it is drawn.
 */

import type { Region } from "./render";
import type { Picture } from "./videoSource";

const VS = `#version 300 es
in vec2 p;
uniform vec4 rect; // x, y, w, h of the source texture to read (0-1)
out vec2 uv;
void main() {
  uv = rect.xy + (p * 0.5 + 0.5) * rect.zw;
  uv.y = rect.y + (1.0 - (p.y * 0.5 + 0.5)) * rect.w;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D img;
uniform sampler3D lut;
uniform float n;
in vec2 uv;
out vec4 color;
void main() {
  vec3 c = clamp(texture(img, uv).rgb, 0.0, 1.0);
  color = vec4(texture(lut, c * ((n - 1.0) / n) + 0.5 / n).rgb, 1.0);
}`;

let shared: Grader | null = null;

export class Grader {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private img: WebGLTexture;
  private lut: WebGLTexture;
  private uRect: WebGLUniformLocation | null;
  private uN: WebGLUniformLocation | null;
  private size = 0;
  private texW = 1;
  private texH = 1;
  private fb: WebGLFramebuffer | null = null;

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
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
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.uRect = gl.getUniformLocation(prog, "rect");
    this.uN = gl.getUniformLocation(prog, "n");
    gl.uniform1i(gl.getUniformLocation(prog, "img"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "lut"), 1);

    this.img = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.img);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.lut = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lut);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_3D, k, v);
    // The camera's code values as recorded: no colour management of the browser in between.
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  /** The page's grader, made once (a GPU context is a limited resource); a new one if the old one was lost. */
  static shared(): Grader | null {
    if (!shared || shared.lost) shared = Grader.create();
    return shared;
  }

  /** The GPU dropped the context (driver reset, too many contexts): this grader can no longer draw. */
  get lost() { return this.gl.isContextLost(); }

  /** None when the browser has no WebGL 2: the picture is then shown as recorded. */
  static create(): Grader | null {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2", { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false });
      return gl ? new Grader(c, gl) : null;
    } catch (e) {
      console.warn("[grade] WebGL 2 unavailable", e);
      return null;
    }
  }

  /** The LUT on the GPU now (shared by the video studio and the slides: each puts its own back before drawing). */
  private data: Float32Array | null = null;

  setLut(data: Float32Array, size: number) {
    if (data === this.data && size === this.size) return;
    this.data = data;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lut);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, data);
    this.size = size;
  }

  get ready() { return this.size > 0 && !this.lost; }

  /**
   * The region `region` (pixels of the whole w×h picture) of `pic`, graded, `outW`×`outH`.
   * Returns a picture whose source holds only that region, to draw like a converted copy.
   */
  grade(pic: Picture, region: Region, outW: number, outH: number): Picture {
    const gl = this.gl;
    const w = Math.max(1, Math.round(outW)), h = Math.max(1, Math.round(outH));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.img);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pic.src as TexImageSource);
    [this.texW, this.texH] = sourceSize(pic.src);
    const part = pic.part ?? { x: 0, y: 0, w: pic.w, h: pic.h };
    gl.uniform4f(this.uRect, (region.x - part.x) / part.w, (region.y - part.y) / part.h, region.w / part.w, region.h / part.h);
    gl.uniform1f(this.uN, this.size);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return { src: this.canvas, w: pic.w, h: pic.h, part: region };
  }

  /**
   * Did the last grade get only black from its source? Some browsers hand the GPU a black picture for a
   * paused video (before it played, after a seek), while drawing it on a 2D canvas works.
   */
  gotBlack(): boolean {
    // Read the source picture itself (the grade turns black into a dark grey): the texture as a framebuffer.
    const gl = this.gl;
    this.fb ??= gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.img, 0);
    let black = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const px = new Uint8Array(4);
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7], [0.5, 0.15], [0.5, 0.85]]) {
      if (!black) break;
      gl.readPixels(Math.floor(this.texW * fx), Math.floor(this.texH * fy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      if (px[0] > 2 || px[1] > 2 || px[2] > 2) black = false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return black;
  }
}

let copy: HTMLCanvasElement | null = null;

/** Pixel size of a picture source (a video, a decoded frame, an image, a canvas). */
const sourceSize = (s: CanvasImageSource): [number, number] => {
  const src = s as { videoWidth?: number; videoHeight?: number; width?: number; height?: number; displayWidth?: number; displayHeight?: number };
  return [src.videoWidth || src.displayWidth || Number(src.width) || 1, src.videoHeight || src.displayHeight || Number(src.height) || 1];
};

/** The region of a picture copied on a 2D canvas at the given size (the path that always works). */
export function copyRegion(pic: Picture, region: Region, outW: number, outH: number): Picture {
  const c = (copy ??= document.createElement("canvas"));
  const w = Math.max(1, Math.round(outW)), h = Math.max(1, Math.round(outH));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const part = pic.part ?? { x: 0, y: 0, w: pic.w, h: pic.h };
  // Source pixels per picture unit (not 1 for a desqueezed picture, see desqueeze).
  const [sw, sh] = sourceSize(pic.src);
  const kx = sw / part.w, ky = sh / part.h;
  c.getContext("2d")!.drawImage(pic.src, (region.x - part.x) * kx, (region.y - part.y) * ky, region.w * kx, region.h * ky, 0, 0, w, h);
  return { src: c, w: pic.w, h: pic.h, part: region };
}
