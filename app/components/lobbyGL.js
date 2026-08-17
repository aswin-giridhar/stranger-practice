'use client';

/**
 * lobbyGL — the Lobby concourse, drawn with raw WebGL.
 *
 * No engine, no dependencies. Every shape is tessellated into triangles on the
 * CPU into one interleaved buffer and submitted in painter's order, so alpha
 * blending behaves exactly like the Canvas 2D original.
 *
 * Colour still comes from the CSS custom properties in app/globals.css: the
 * caller reads them with getComputedStyle, and `col()` below turns those
 * strings into the vec4s that reach the shader as vertex attributes. The scene
 * therefore follows the page in light and dark theme, same as before.
 *
 * Text is NOT drawn here. Glyphs live in a DOM overlay above the canvas, which
 * is both cheaper and better for accessibility than a glyph atlas.
 */

/* ---------- colour helpers (shared with the Canvas 2D fallback) ---------- */

export function parseColor(input) {
  const s = String(input || '').trim();
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length === 8) hex = hex.slice(0, 6);
    const n = parseInt(hex, 16);
    if (Number.isNaN(n)) return [0, 0, 0, 1];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = s.match(/-?\d*\.?\d+/g);
  if (m && m.length >= 3) {
    return [Number(m[0]), Number(m[1]), Number(m[2]), m.length > 3 ? Number(m[3]) : 1];
  }
  return [0, 0, 0, 1];
}

export function withAlpha(color, a) {
  const [r, g, b, existing] = parseColor(color);
  return `rgba(${r}, ${g}, ${b}, ${a * existing})`;
}

export function mix(colorA, colorB, t) {
  const a = parseColor(colorA);
  const b = parseColor(colorB);
  const c = (i) => Math.round(a[i] + (b[i] - a[i]) * t);
  return `rgb(${c(0)}, ${c(1)}, ${c(2)})`;
}

/** CSS colour string -> vec4 in 0..1, with an optional alpha multiplier. */
function col(color, alpha = 1) {
  const [r, g, b, a] = parseColor(color);
  return [r / 255, g / 255, b / 255, a * alpha];
}

/* ---------- shaders ---------- */

const STRIDE = 8; // x, y, r, g, b, a, u, v
const BYTES = STRIDE * 4;

const SOLID_VS = `
attribute vec2 aPos;
attribute vec4 aColor;
uniform vec2 uScale;
uniform vec2 uOffset;
varying vec4 vColor;
void main() {
  gl_Position = vec4(aPos * uScale + uOffset, 0.0, 1.0);
  vColor = aColor;
}`;

const SOLID_FS = `
precision mediump float;
varying vec4 vColor;
void main() {
  gl_FragColor = vColor;
}`;

const TEX_VS = `
attribute vec2 aPos;
attribute vec4 aColor;
attribute vec2 aUV;
uniform vec2 uScale;
uniform vec2 uOffset;
varying vec4 vColor;
varying vec2 vUV;
void main() {
  gl_Position = vec4(aPos * uScale + uOffset, 0.0, 1.0);
  vColor = aColor;
  vUV = aUV;
}`;

/* uRegion is the sub-rectangle of the texture this quad samples; it lets the
   fragment shader recover a 0..1 local coordinate and clip to a circle, which
   is how the round portrait mask is done without a stencil buffer. */
const TEX_FS = `
precision mediump float;
varying vec4 vColor;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec4 uRegion;
void main() {
  vec2 q = (vUV - uRegion.xy) / uRegion.zw;
  if (length(q - vec2(0.5)) > 0.5) discard;
  vec4 t = texture2D(uTex, vUV);
  gl_FragColor = vec4(t.rgb, t.a * vColor.a);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`lobbyGL: shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`lobbyGL: program link failed: ${log}`);
  }
  return prog;
}

/* ---------- geometry batch ---------- */

function makeBatch() {
  const data = [];
  const cmds = [];
  let cur = null;

  function solidCmd() {
    if (!cur || cur.tex) {
      cur = { tex: null, region: null, start: data.length / STRIDE, count: 0 };
      cmds.push(cur);
    }
    return cur;
  }

  function vert(x, y, c, u = 0, v = 0) {
    const cmd = solidCmd();
    data.push(x, y, c[0], c[1], c[2], c[3], u, v);
    cmd.count += 1;
  }

  const b = {
    data,
    cmds,

    tri(x1, y1, x2, y2, x3, y3, c) {
      vert(x1, y1, c); vert(x2, y2, c); vert(x3, y3, c);
    },

    quad(x1, y1, x2, y2, x3, y3, x4, y4, c) {
      b.tri(x1, y1, x2, y2, x3, y3, c);
      b.tri(x1, y1, x3, y3, x4, y4, c);
    },

    rect(x, y, w, h, c) {
      b.quad(x, y, x + w, y, x + w, y + h, x, y + h, c);
    },

    /** Triangle fan over a closed polygon given as a flat [x,y,...] array. */
    fillPoly(pts, c) {
      const n = pts.length / 2;
      if (n < 3) return;
      for (let i = 1; i < n - 1; i += 1) {
        b.tri(pts[0], pts[1], pts[i * 2], pts[i * 2 + 1], pts[(i + 1) * 2], pts[(i + 1) * 2 + 1], c);
      }
    },

    /** Closed outline: a strip between an inward and an outward offset. */
    strokePoly(pts, width, c) {
      const n = pts.length / 2;
      if (n < 3) return;
      const half = width / 2;
      const inner = new Array(n * 2);
      const outer = new Array(n * 2);
      for (let i = 0; i < n; i += 1) {
        const px = pts[((i - 1 + n) % n) * 2];
        const py = pts[((i - 1 + n) % n) * 2 + 1];
        const cx = pts[i * 2];
        const cy = pts[i * 2 + 1];
        const nx2 = pts[((i + 1) % n) * 2];
        const ny2 = pts[((i + 1) % n) * 2 + 1];
        let ax = cx - px;
        let ay = cy - py;
        let bx = nx2 - cx;
        let by = ny2 - cy;
        const la = Math.hypot(ax, ay) || 1;
        const lb = Math.hypot(bx, by) || 1;
        ax /= la; ay /= la; bx /= lb; by /= lb;
        // Average of the two segment normals.
        let mx = -(ay + by);
        let my = ax + bx;
        const lm = Math.hypot(mx, my) || 1;
        mx /= lm; my /= lm;
        inner[i * 2] = cx - mx * half;
        inner[i * 2 + 1] = cy - my * half;
        outer[i * 2] = cx + mx * half;
        outer[i * 2 + 1] = cy + my * half;
      }
      for (let i = 0; i < n; i += 1) {
        const j = (i + 1) % n;
        b.quad(
          inner[i * 2], inner[i * 2 + 1],
          outer[i * 2], outer[i * 2 + 1],
          outer[j * 2], outer[j * 2 + 1],
          inner[j * 2], inner[j * 2 + 1],
          c,
        );
      }
    },

    /** Open polyline: one quad per segment plus a square patch at each joint. */
    strokeLine(pts, width, c) {
      const n = pts.length / 2;
      const half = width / 2;
      for (let i = 0; i < n - 1; i += 1) {
        const x1 = pts[i * 2];
        const y1 = pts[i * 2 + 1];
        const x2 = pts[(i + 1) * 2];
        const y2 = pts[(i + 1) * 2 + 1];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        const nx = (-dy / len) * half;
        const ny = (dx / len) * half;
        b.quad(x1 + nx, y1 + ny, x2 + nx, y2 + ny, x2 - nx, y2 - ny, x1 - nx, y1 - ny, c);
      }
      if (width > 2) {
        for (let i = 1; i < n - 1; i += 1) {
          b.rect(pts[i * 2] - half, pts[i * 2 + 1] - half, width, width, c);
        }
      }
    },

    portrait(image, texture, x, y, w, h, region, alpha) {
      cur = { tex: texture, image, region, start: data.length / STRIDE, count: 6 };
      cmds.push(cur);
      const [u0, v0, du, dv] = region;
      const c = [1, 1, 1, alpha];
      const push = (px, py, u, v) => data.push(px, py, c[0], c[1], c[2], c[3], u, v);
      push(x, y, u0, v0);
      push(x + w, y, u0 + du, v0);
      push(x + w, y + h, u0 + du, v0 + dv);
      push(x, y, u0, v0);
      push(x + w, y + h, u0 + du, v0 + dv);
      push(x, y + h, u0, v0 + dv);
      cur = null;
    },
  };

  return b;
}

/* ---------- path builders ---------- */

function roundRectPoints(x, y, w, h, r) {
  const radii = Array.isArray(r) ? r : [r, r, r, r]; // tl, tr, br, bl
  const lim = Math.min(w / 2, h / 2);
  const [tl, tr, br, bl] = radii.map((v) => Math.max(0, Math.min(v, lim)));
  const pts = [];
  const seg = 5;
  const arc = (cx, cy, rr, a0, a1) => {
    if (rr <= 0) { pts.push(cx, cy); return; }
    for (let i = 0; i <= seg; i += 1) {
      const a = a0 + (a1 - a0) * (i / seg);
      pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
  };
  arc(x + w - tr, y + tr, tr, -Math.PI / 2, 0);
  arc(x + w - br, y + h - br, br, 0, Math.PI / 2);
  arc(x + bl, y + h - bl, bl, Math.PI / 2, Math.PI);
  arc(x + tl, y + tl, tl, Math.PI, Math.PI * 1.5);
  return pts;
}

function ellipsePoints(cx, cy, rx, ry, rot = 0, segs = 48) {
  const pts = [];
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  for (let i = 0; i < segs; i += 1) {
    const a = (i / segs) * Math.PI * 2;
    const px = Math.cos(a) * rx;
    const py = Math.sin(a) * ry;
    pts.push(cx + px * cos - py * sin, cy + px * sin + py * cos);
  }
  return pts;
}

function circlePoints(cx, cy, r, segs = 48) {
  return ellipsePoints(cx, cy, r, r, 0, segs);
}

/** Split a closed path into the "on" runs of a dash pattern. */
function dashClosed(pts, on, off) {
  const n = pts.length / 2;
  const runs = [];
  let run = [];
  let phase = 0; // distance into the current dash cell
  let drawing = true;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    let x1 = pts[i * 2];
    let y1 = pts[i * 2 + 1];
    const x2 = pts[j * 2];
    const y2 = pts[j * 2 + 1];
    let remaining = Math.hypot(x2 - x1, y2 - y1);
    if (remaining < 1e-6) continue;
    const dx = (x2 - x1) / remaining;
    const dy = (y2 - y1) / remaining;
    if (drawing && run.length === 0) run.push(x1, y1);
    while (remaining > 0) {
      const cell = drawing ? on : off;
      const left = cell - phase;
      const stepLen = Math.min(left, remaining);
      const nx = x1 + dx * stepLen;
      const ny = y1 + dy * stepLen;
      if (drawing) run.push(nx, ny);
      phase += stepLen;
      remaining -= stepLen;
      x1 = nx;
      y1 = ny;
      if (phase >= cell - 1e-9) {
        phase = 0;
        if (drawing) {
          if (run.length >= 4) runs.push(run);
          run = [];
        } else {
          run = [x1, y1];
        }
        drawing = !drawing;
      }
    }
  }
  if (run.length >= 4) runs.push(run);
  return runs;
}

function dashLine(x1, y1, x2, y2, on, off) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1e-6) return [];
  const dx = (x2 - x1) / len;
  const dy = (y2 - y1) / len;
  const runs = [];
  let t = 0;
  while (t < len) {
    const end = Math.min(t + on, len);
    runs.push([x1 + dx * t, y1 + dy * t, x1 + dx * end, y1 + dy * end]);
    t = end + off;
  }
  return runs;
}

/* ---------- scene ---------- */

function bench(b, theme, x, y, w, h) {
  const path = roundRectPoints(x, y, w, h, 8);
  b.fillPoly(path, col(theme.sunken));
  b.strokePoly(path, 1.5, col(theme.ruleStrong));

  const slatColor = col(theme.inkMuted, 0.35);
  const horizontal = w > h;
  const slats = 3;
  for (let i = 1; i <= slats; i += 1) {
    if (horizontal) {
      const yy = y + (h * i) / (slats + 1);
      b.strokeLine([x + 6, yy, x + w - 6, yy], 1, slatColor);
    } else {
      const xx = x + (w * i) / (slats + 1);
      b.strokeLine([xx, y + 6, xx, y + h - 6], 1, slatColor);
    }
  }
}

function departureBoard(b, theme) {
  const x = 330;
  const y = 34;
  const w = 300;
  const h = 78;

  b.fillPoly(roundRectPoints(x + 3, y + 6, w, h, 10), col(theme.ink, 0.08));

  const path = roundRectPoints(x, y, w, h, 10);
  b.fillPoly(path, col(theme.raised));
  b.strokePoly(path, 1.5, col(theme.ruleStrong));

  // Header band: rounded at the top only, which is what clipping to the card gave us.
  b.fillPoly(roundRectPoints(x, y, w, 20, [10, 10, 0, 0]), col(theme.inkSecondary, 0.9));

  const rows = [
    [150, 0.42],
    [186, 0.3],
    [122, 0.22],
  ];
  rows.forEach(([wide, alpha], i) => {
    const ry = y + 32 + i * 14;
    const c = col(theme.inkMuted, alpha);
    b.rect(x + 12, ry, wide, 5, c);
    b.rect(x + w - 46, ry, 34, 5, c);
  });
}

function plant(b, theme, x, y) {
  b.fillPoly(ellipsePoints(x, y + 16, 34, 11), col(theme.ink, 0.1));

  const pot = [x - 20, y - 6, x + 20, y - 6, x + 14, y + 20, x - 14, y + 20];
  b.fillPoly(pot, col(theme.marking, 0.42));
  b.strokePoly(pot, 1, col(theme.ink, 0.18));

  const leaves = [
    [0, -40, 22],
    [-20, -26, 17],
    [20, -28, 16],
    [-9, -54, 13],
    [12, -52, 12],
  ];
  leaves.forEach(([dx, dy, r], i) => {
    b.fillPoly(
      ellipsePoints(x + dx, y + dy, r, r * 0.82, dx * 0.02),
      col(theme.plant, i % 2 ? 0.34 : 0.5),
    );
  });
}

function drawPlayer(b, theme, player) {
  const { x, y } = player;
  b.fillPoly(ellipsePoints(x, y + 22, 20, 7), col(theme.ink, 0.14));
  b.strokePoly(circlePoints(x, y + 20, 30), 1.5, col(theme.ink, 0.16));
  b.fillPoly(roundRectPoints(x - 13, y - 4, 26, 26, 12), col(theme.ink));
  const head = circlePoints(x, y - 14, 12, 32);
  b.fillPoly(head, col(theme.ink));
  b.strokePoly(head, 2.5, col(theme.paper));
  // "YOU" is drawn by the DOM overlay.
}

function drawActor(b, theme, a, state) {
  const { nearId, selectedId, hoverId, proximity, textures, labelWidths } = state;
  const active = a.id === nearId || a.id === selectedId || a.id === hoverId;
  const accent = a.accent || theme.ink;
  const { x, y } = a;

  if (active) {
    const ring = circlePoints(x, y + 4, proximity * 0.72, 64);
    b.fillPoly(ring, col(accent, 0.1));
    dashClosed(ring, 6, 6).forEach((run) => b.strokeLine(run, 2, col(accent, 0.55)));
  }

  b.fillPoly(ellipsePoints(x, y + 26, 22, 8), col(theme.ink, 0.14));
  b.fillPoly(roundRectPoints(x - 15, y - 2, 30, 30, 13), col(accent));

  const hr = 15;
  const head = circlePoints(x, y - 16, hr, 40);
  const tex = textures.get(a.id);
  if (tex) {
    b.portrait(tex.image, tex.texture, x - hr, y - 16 - hr, hr * 2, hr * 2, tex.region, 1);
  } else {
    b.fillPoly(head, col(mix(accent, theme.ink, 0.25)));
  }
  b.strokePoly(head, active ? 3 : 2, active ? col(accent) : col(accent, 0.75));

  // Name plate. The glyphs themselves come from the DOM overlay; the plate is GL.
  const boxW = (labelWidths.get(a.id) || 60) + 20;
  const boxH = 22;
  const boxX = x - boxW / 2;
  const boxY = y + 36;
  const plate = roundRectPoints(boxX, boxY, boxW, boxH, 11);
  b.fillPoly(plate, col(theme.surface));
  b.strokePoly(plate, active ? 2 : 1, active ? col(accent) : col(theme.ruleStrong));

  if (typeof a.difficulty === 'number') {
    const pips = 5;
    const gap = 7;
    const startX = x - ((pips - 1) * gap) / 2;
    for (let i = 0; i < pips; i += 1) {
      b.fillPoly(
        circlePoints(startX + i * gap, boxY + boxH + 10, 2.4, 16),
        i < a.difficulty ? col(accent, 0.95) : col(theme.inkMuted, 0.28),
      );
    }
  }
}

function buildScene(b, params) {
  const { theme, actors, player, floor } = params;

  const floorPath = roundRectPoints(floor.x, floor.y, floor.w, floor.h, 18);
  b.fillPoly(floorPath, col(theme.surface));
  b.strokePoly(floorPath, 1.5, col(theme.rule));

  const grid = col(theme.rule, 0.75);
  for (let x = floor.x + 60; x < floor.x + floor.w; x += 60) {
    b.strokeLine([x, floor.y, x, floor.y + floor.h], 1, grid);
  }
  for (let y = floor.y + 60; y < floor.y + floor.h; y += 60) {
    b.strokeLine([floor.x, y, floor.x + floor.w, y], 1, grid);
  }

  b.rect(floor.x, floor.y + floor.h - 46, floor.w, 46, col(theme.inkMuted, 0.06));
  const bandY = floor.y + floor.h - 46;
  dashLine(floor.x + 24, bandY, floor.x + floor.w - 24, bandY, 16, 12).forEach((run) => {
    b.strokeLine(run, 3, col(theme.marking, 0.55));
  });

  departureBoard(b, theme);

  bench(b, theme, 128, 496, 178, 34);
  bench(b, theme, 656, 466, 178, 34);
  bench(b, theme, 76, 214, 32, 132);
  plant(b, theme, 860, 236);
  plant(b, theme, 118, 402);

  const drawable = [
    ...actors.map((a) => ({ kind: 'actor', a })),
    { kind: 'player', a: player },
  ].sort((p, q) => p.a.y - q.a.y);

  drawable.forEach((item) => {
    if (item.kind === 'player') drawPlayer(b, theme, item.a);
    else drawActor(b, theme, item.a, params);
  });
}

/* ---------- renderer ---------- */

/**
 * True only when a WebGL context comes up AND our two programs actually build.
 *
 * Probed on a throwaway canvas on purpose: once a canvas has handed out a WebGL
 * context, getContext('2d') on that same canvas returns null forever. Probing
 * the real canvas would therefore poison the Canvas 2D fallback and leave an
 * empty box on any machine where the shaders fail to compile.
 */
export function webglUsable() {
  if (typeof document === 'undefined') return false;
  let gl = null;
  try {
    const probe = document.createElement('canvas');
    gl = probe.getContext('webgl') || probe.getContext('experimental-webgl');
    if (!gl) return false;
    gl.deleteProgram(link(gl, SOLID_VS, SOLID_FS));
    gl.deleteProgram(link(gl, TEX_VS, TEX_FS));
    return true;
  } catch (err) {
    console.warn('lobbyGL: WebGL unusable, falling back to Canvas 2D.', err);
    return false;
  } finally {
    if (gl) {
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
  }
}

/**
 * Returns a renderer bound to `canvas`, or null when WebGL is unavailable.
 * A null return is the caller's cue to keep the Canvas 2D path — never to
 * render an empty canvas.
 */
export function createGLRenderer(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;

  const attrs = { alpha: true, antialias: true, premultipliedAlpha: false, depth: false, stencil: false };
  let gl = null;
  try {
    gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
  } catch {
    gl = null;
  }
  if (!gl) return null;

  let solidProg = null;
  let texProg = null;
  let buffer = null;
  let ready = false;
  const textures = new Map(); // persona id -> { image, texture, region }
  let scratch = new Float32Array(4096);

  function initGL() {
    try {
      solidProg = link(gl, SOLID_VS, SOLID_FS);
      texProg = link(gl, TEX_VS, TEX_FS);
    } catch (err) {
      // A driver that cannot compile these shaders is a real failure, not an
      // absence: say so rather than silently painting nothing.
      console.error(err);
      ready = false;
      return false;
    }
    buffer = gl.createBuffer();
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    ready = true;
    return true;
  }

  if (!initGL()) return null;

  const onLost = (e) => {
    e.preventDefault();
    ready = false;
    textures.clear();
  };
  const onRestored = () => {
    textures.clear();
    initGL();
  };
  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);

  function ensureTexture(id, image) {
    if (!image || !image.complete || !image.naturalWidth) return null;
    const existing = textures.get(id);
    if (existing && existing.image === image) return existing;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    } catch {
      // Cross-origin or decode failure: fall back to the drawn figure.
      gl.deleteTexture(texture);
      return null;
    }
    // "cover" crop: the same square centre crop the 2D path used.
    const nw = image.naturalWidth;
    const nh = image.naturalHeight;
    const side = Math.min(nw, nh);
    const region = [((nw - side) / 2) / nw, ((nh - side) / 2) / nh, side / nw, side / nh];
    const entry = { image, texture, region };
    textures.set(id, entry);
    return entry;
  }

  function bindAttribs(prog, useUV) {
    const aPos = gl.getAttribLocation(prog, 'aPos');
    const aColor = gl.getAttribLocation(prog, 'aColor');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, BYTES, 0);
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, BYTES, 8);
    if (useUV) {
      const aUV = gl.getAttribLocation(prog, 'aUV');
      gl.enableVertexAttribArray(aUV);
      gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, BYTES, 24);
    }
  }

  function render(params) {
    if (!ready || gl.isContextLost()) return false;

    const { view, theme, images, actors } = params;
    const dpr = view.dpr || 1;
    const cssW = view.cssW || 1;
    const cssH = view.cssH || 1;
    const pxW = Math.max(1, Math.round(cssW * dpr));
    const pxH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    gl.viewport(0, 0, pxW, pxH);

    const bg = col(theme.sunken);
    gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Upload the current portraits (cheap: skipped once cached).
    const live = new Map();
    actors.forEach((a) => {
      const entry = ensureTexture(a.id, images[a.id]);
      if (entry) live.set(a.id, entry);
    });

    const batch = makeBatch();
    buildScene(batch, { ...params, textures: live });

    const verts = batch.data.length / STRIDE;
    if (!verts) return true;
    if (scratch.length < batch.data.length) {
      scratch = new Float32Array(Math.max(batch.data.length, scratch.length * 2));
    }
    scratch.set(batch.data);

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, scratch.subarray(0, batch.data.length), gl.DYNAMIC_DRAW);

    const uScale = [(2 * view.scale) / cssW, (-2 * view.scale) / cssH];
    const uOffset = [(2 * view.ox) / cssW - 1, 1 - (2 * view.oy) / cssH];

    let activeProg = null;
    batch.cmds.forEach((cmd) => {
      if (!cmd.count) return;
      const prog = cmd.tex ? texProg : solidProg;
      if (prog !== activeProg) {
        gl.useProgram(prog);
        bindAttribs(prog, Boolean(cmd.tex));
        gl.uniform2f(gl.getUniformLocation(prog, 'uScale'), uScale[0], uScale[1]);
        gl.uniform2f(gl.getUniformLocation(prog, 'uOffset'), uOffset[0], uOffset[1]);
        activeProg = prog;
      }
      if (cmd.tex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, cmd.tex);
        gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
        const r = cmd.region;
        gl.uniform4f(gl.getUniformLocation(prog, 'uRegion'), r[0], r[1], r[2], r[3]);
      }
      gl.drawArrays(gl.TRIANGLES, cmd.start, cmd.count);
    });

    return true;
  }

  function destroy() {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    textures.forEach((t) => gl.deleteTexture(t.texture));
    textures.clear();
    if (buffer) gl.deleteBuffer(buffer);
    if (solidProg) gl.deleteProgram(solidProg);
    if (texProg) gl.deleteProgram(texProg);
    ready = false;
  }

  return { render, destroy, gl };
}
