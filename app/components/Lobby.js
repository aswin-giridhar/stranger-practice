'use client';

/**
 * Lobby — a small walkable station concourse.
 *
 * Replaces the persona radio list with a place you move through: you walk an
 * avatar toward one of three waiting strangers and stand near them to start.
 *
 * Rendered with raw WebGL (see ./lobbyGL.js) — no engine, no dependencies. All
 * colour comes from the CSS custom properties in app/globals.css, read at
 * runtime with getComputedStyle and handed to the shaders as vertex colours, so
 * the scene follows the page in both themes.
 *
 * Two deliberate exceptions to "everything in WebGL":
 *   - Text is a DOM overlay, transformed with the same letterbox transform as
 *     the scene. A glyph atlas would be slower to build and worse for a11y.
 *   - If getContext('webgl') returns null the whole Canvas 2D path below is
 *     still here and takes over. A blank canvas would look like a bug.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './lobby.css';
import { createGLRenderer, withAlpha, mix } from './lobbyGL';

/* The scene is authored in a fixed logical space and letterboxed into whatever
   box the container gives us. One coordinate system, any screen size. */
const WORLD_W = 960;
const WORLD_H = 600;

/* Walkable rectangle. The player is clamped to this. */
const FLOOR = { x: 46, y: 132, w: WORLD_W - 92, h: WORLD_H - 178 };

const PROXIMITY = 80; // world px — "close enough to speak"
const SPEED = 300; // world px / second

/* Where the three strangers stand. Deliberately unequal: a corner, a bench,
   and the middle of the concourse. */
const SPOTS = [
  { x: 218, y: 430 },
  { x: 742, y: 396 },
  { x: 494, y: 250 },
];

const KEYMAP = {
  ArrowLeft: 'left', a: 'left', A: 'left',
  ArrowRight: 'right', d: 'right', D: 'right',
  ArrowUp: 'up', w: 'up', W: 'up',
  ArrowDown: 'down', s: 'down', S: 'down',
};

/* ---------- theme ---------- */

const FALLBACK_THEME = {
  paper: '#F6F3ED',
  surface: '#FFFFFF',
  sunken: '#EFEBE3',
  raised: '#FFFFFF',
  ink: '#1B1815',
  inkSecondary: '#57514A',
  inkMuted: '#6B635A',
  rule: '#E0DAD0',
  ruleStrong: '#C9C1B4',
  marking: '#8A5A16',
  plant: '#2F6B4F',
  sans: "'Hanken Grotesk', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
};

function readTheme() {
  if (typeof window === 'undefined') return FALLBACK_THEME;
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => {
    const v = cs.getPropertyValue(name).trim();
    return v || fallback;
  };
  return {
    paper: pick('--paper', FALLBACK_THEME.paper),
    surface: pick('--surface', FALLBACK_THEME.surface),
    sunken: pick('--surface-sunken', FALLBACK_THEME.sunken),
    raised: pick('--surface-raised', FALLBACK_THEME.raised),
    ink: pick('--ink', FALLBACK_THEME.ink),
    inkSecondary: pick('--ink-secondary', FALLBACK_THEME.inkSecondary),
    inkMuted: pick('--ink-muted', FALLBACK_THEME.inkMuted),
    rule: pick('--rule', FALLBACK_THEME.rule),
    ruleStrong: pick('--rule-strong', FALLBACK_THEME.ruleStrong),
    marking: pick('--signal-watch', FALLBACK_THEME.marking),
    plant: pick('--signal-good', FALLBACK_THEME.plant),
    sans: pick('--font-sans', FALLBACK_THEME.sans),
    mono: pick('--font-mono', FALLBACK_THEME.mono),
  };
}

/* ---------- small drawing primitives ---------- */

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function bench(ctx, theme, x, y, w, h) {
  roundRect(ctx, x, y, w, h, 8);
  ctx.fillStyle = theme.sunken;
  ctx.fill();
  ctx.strokeStyle = theme.ruleStrong;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.strokeStyle = withAlpha(theme.inkMuted, 0.35);
  ctx.lineWidth = 1;
  const horizontal = w > h;
  const slats = 3;
  for (let i = 1; i <= slats; i += 1) {
    ctx.beginPath();
    if (horizontal) {
      const yy = y + (h * i) / (slats + 1);
      ctx.moveTo(x + 6, yy);
      ctx.lineTo(x + w - 6, yy);
    } else {
      const xx = x + (w * i) / (slats + 1);
      ctx.moveTo(xx, y + 6);
      ctx.lineTo(xx, y + h - 6);
    }
    ctx.stroke();
  }
}

function departureBoard(ctx, theme) {
  const x = 330;
  const y = 34;
  const w = 300;
  const h = 78;

  ctx.fillStyle = withAlpha(theme.ink, 0.08);
  roundRect(ctx, x + 3, y + 6, w, h, 10);
  ctx.fill();

  roundRect(ctx, x, y, w, h, 10);
  ctx.fillStyle = theme.raised;
  ctx.fill();
  ctx.strokeStyle = theme.ruleStrong;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.save();
  roundRect(ctx, x, y, w, h, 10);
  ctx.clip();
  ctx.fillStyle = withAlpha(theme.inkSecondary, 0.9);
  ctx.fillRect(x, y, w, 20);
  ctx.fillStyle = theme.paper;
  ctx.font = `600 11px ${theme.mono}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('DEPARTURES', x + 12, y + 11);
  ctx.textAlign = 'right';
  ctx.fillText('DELAYED', x + w - 12, y + 11);
  ctx.restore();

  const rows = [
    [150, 0.42],
    [186, 0.3],
    [122, 0.22],
  ];
  rows.forEach(([wide, alpha], i) => {
    const ry = y + 32 + i * 14;
    ctx.fillStyle = withAlpha(theme.inkMuted, alpha);
    ctx.fillRect(x + 12, ry, wide, 5);
    ctx.fillRect(x + w - 46, ry, 34, 5);
  });
}

function plant(ctx, theme, x, y) {
  ctx.fillStyle = withAlpha(theme.ink, 0.1);
  ctx.beginPath();
  ctx.ellipse(x, y + 16, 34, 11, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x - 20, y - 6);
  ctx.lineTo(x + 20, y - 6);
  ctx.lineTo(x + 14, y + 20);
  ctx.lineTo(x - 14, y + 20);
  ctx.closePath();
  ctx.fillStyle = withAlpha(theme.marking, 0.42);
  ctx.fill();
  ctx.strokeStyle = withAlpha(theme.ink, 0.18);
  ctx.lineWidth = 1;
  ctx.stroke();

  const leaves = [
    [0, -40, 22],
    [-20, -26, 17],
    [20, -28, 16],
    [-9, -54, 13],
    [12, -52, 12],
  ];
  leaves.forEach(([dx, dy, r], i) => {
    ctx.beginPath();
    ctx.ellipse(x + dx, y + dy, r, r * 0.82, dx * 0.02, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(theme.plant, i % 2 ? 0.34 : 0.5);
    ctx.fill();
  });
}

/* ---------- component ---------- */

export default function Lobby({ personas, selectedId, onSelect, onConfirm }) {
  const list = useMemo(() => (Array.isArray(personas) ? personas.slice(0, 3) : []), [personas]);

  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const overlayRef = useRef(null);   // DOM text layer, letterboxed with the scene
  const youLabelRef = useRef(null);
  const measureRef = useRef(null);   // 2D context used only for measureText

  const playerRef = useRef({ x: WORLD_W / 2, y: 512 });
  const targetRef = useRef(null);
  const keysRef = useRef(new Set());
  const viewRef = useRef({ scale: 1, ox: 0, oy: 0 });
  const imagesRef = useRef({});
  const themeRef = useRef(FALLBACK_THEME);
  const reducedRef = useRef(false);
  const nearRef = useRef(null);
  const hoverRef = useRef(null);

  const [nearId, setNearId] = useState(null);
  /* null until the loop has decided; 'gl' when WebGL came up, '2d' when it did not. */
  const [renderMode, setRenderMode] = useState(null);

  /* Callbacks live in refs so the animation loop never has to be torn down. */
  const onSelectRef = useRef(onSelect);
  const onConfirmRef = useRef(onConfirm);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { onConfirmRef.current = onConfirm; }, [onConfirm]);

  const listRef = useRef(list);
  useEffect(() => { listRef.current = list; }, [list]);

  const selectedRef = useRef(selectedId);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);

  const actors = useMemo(
    () => list.map((p, i) => ({ ...p, ...SPOTS[i % SPOTS.length] })),
    [list],
  );
  const actorsRef = useRef(actors);
  useEffect(() => { actorsRef.current = actors; }, [actors]);

  const nearPersona = useMemo(
    () => actors.find((a) => a.id === nearId) || null,
    [actors, nearId],
  );

  /* ---- theme tracking ---- */
  useEffect(() => {
    themeRef.current = readTheme();
    const refresh = () => { themeRef.current = readTheme(); };
    const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
    const mqMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedRef.current = mqMotion.matches;
    const onMotion = () => { reducedRef.current = mqMotion.matches; };
    mqDark.addEventListener('change', refresh);
    mqMotion.addEventListener('change', onMotion);
    const mo = new MutationObserver(refresh);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    // Webfonts change text metrics; redraw happens every frame so just re-read.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh).catch(() => {});
    return () => {
      mqDark.removeEventListener('change', refresh);
      mqMotion.removeEventListener('change', onMotion);
      mo.disconnect();
    };
  }, []);

  /* ---- portraits: never block the scene on these ---- */
  useEffect(() => {
    let alive = true;
    list.forEach((p) => {
      const src = p.avatarImage || `/${String(p.name || p.id).toLowerCase()}.jpg`;
      if (imagesRef.current[p.id]) return;
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { if (alive) imagesRef.current[p.id] = img; };
      img.onerror = () => {}; // fall back to a drawn figure; not an error worth surfacing
      img.src = src;
    });
    return () => { alive = false; };
  }, [list]);

  /* ---- HiDPI sizing ---- */
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return undefined;

    const resize = () => {
      const rect = stage.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const scale = Math.min(w / WORLD_W, h / WORLD_H);
      viewRef.current = {
        scale,
        ox: (w - WORLD_W * scale) / 2,
        oy: (h - WORLD_H * scale) / 2,
        dpr,
        cssW: w,
        cssH: h,
      };
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(stage);
    window.addEventListener('resize', resize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, []);

  /* ---- the loop ---- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    /* WebGL first. A null context is a real absence, so fall back to the 2D
       path rather than leaving an empty canvas that reads as a bug. */
    const renderer = createGLRenderer(canvas);
    const ctx = renderer ? null : canvas.getContext('2d');
    setRenderMode(renderer ? 'gl' : '2d');
    if (!renderer && !ctx) return undefined;

    /* Text is measured on a throwaway 2D context so the GL name plates are
       sized to the same metrics the DOM overlay will render. */
    if (renderer && !measureRef.current && typeof document !== 'undefined') {
      const m = document.createElement('canvas');
      measureRef.current = m.getContext('2d');
    }
    const labelWidths = new Map();

    let last = performance.now();

    const step = (now) => {
      const dt = Math.min((now - last) / 1000, 0.05); // delta-time, capped after a tab stall
      last = now;

      const theme = themeRef.current;
      const view = viewRef.current;
      const player = playerRef.current;
      const reduced = reducedRef.current;

      /* --- movement --- */
      const keys = keysRef.current;
      let dx = 0;
      let dy = 0;
      if (keys.has('left')) dx -= 1;
      if (keys.has('right')) dx += 1;
      if (keys.has('up')) dy -= 1;
      if (keys.has('down')) dy += 1;

      if (dx || dy) {
        targetRef.current = null;
        const len = Math.hypot(dx, dy) || 1;
        player.x += (dx / len) * SPEED * dt;
        player.y += (dy / len) * SPEED * dt;
      } else if (targetRef.current) {
        const t = targetRef.current;
        const ddx = t.x - player.x;
        const ddy = t.y - player.y;
        const dist = Math.hypot(ddx, ddy);
        if (reduced || dist < 4) {
          player.x = t.x;
          player.y = t.y;
          targetRef.current = null;
        } else {
          const stepLen = Math.min(SPEED * dt, dist);
          player.x += (ddx / dist) * stepLen;
          player.y += (ddy / dist) * stepLen;
        }
      }

      player.x = Math.max(FLOOR.x + 16, Math.min(FLOOR.x + FLOOR.w - 16, player.x));
      player.y = Math.max(FLOOR.y + 16, Math.min(FLOOR.y + FLOOR.h - 16, player.y));

      /* --- proximity --- */
      const currentActors = actorsRef.current;
      let closest = null;
      let closestDist = Infinity;
      currentActors.forEach((a) => {
        const d = Math.hypot(a.x - player.x, a.y - player.y);
        if (d < closestDist) {
          closestDist = d;
          closest = a;
        }
      });
      const nowNear = closest && closestDist <= PROXIMITY ? closest.id : null;
      if (nowNear !== nearRef.current) {
        nearRef.current = nowNear;
        setNearId(nowNear);
        if (nowNear && onSelectRef.current) onSelectRef.current(nowNear);
      }

      /* --- draw --- */
      const { scale, ox, oy, dpr = 1, cssW = 0, cssH = 0 } = view;

      if (renderer) {
        const measure = measureRef.current;
        if (measure) {
          measure.font = `600 13px ${theme.sans}`;
          currentActors.forEach((a) => {
            labelWidths.set(a.id, measure.measureText(String(a.name || a.id)).width);
          });
        }

        renderer.render({
          view,
          theme,
          actors: currentActors,
          player,
          images: imagesRef.current,
          nearId: nearRef.current,
          selectedId: selectedRef.current,
          hoverId: hoverRef.current,
          floor: FLOOR,
          proximity: PROXIMITY,
          labelWidths,
        });

        /* Keep the DOM text layer glued to the same letterbox transform. */
        const overlay = overlayRef.current;
        if (overlay) {
          overlay.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
        }
        const you = youLabelRef.current;
        if (you) {
          you.style.left = `${player.x}px`;
          you.style.top = `${player.y + 30}px`;
        }
      } else {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.fillStyle = theme.sunken;
        ctx.fillRect(0, 0, cssW, cssH);
        ctx.save();
        ctx.translate(ox, oy);
        ctx.scale(scale, scale);

        drawScene(ctx, theme, currentActors, player, nearRef.current, selectedRef.current, hoverRef.current, imagesRef.current);

        ctx.restore();
      }

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (renderer) renderer.destroy();
    };
  }, []);

  /* ---- pointer: click to move, click a stranger to approach them ---- */
  const toWorld = useCallback((clientX, clientY) => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    const { scale, ox, oy } = viewRef.current;
    return {
      x: (clientX - rect.left - ox) / scale,
      y: (clientY - rect.top - oy) / scale,
    };
  }, []);

  const handlePointerDown = useCallback((event) => {
    const stage = stageRef.current;
    if (stage) stage.focus({ preventScroll: true });
    const p = toWorld(event.clientX, event.clientY);
    const hit = actorsRef.current.find((a) => Math.hypot(a.x - p.x, a.y - p.y) < 52);
    if (hit) {
      // Walk to a polite standing distance rather than into them.
      const player = playerRef.current;
      const vx = player.x - hit.x;
      const vy = player.y - hit.y;
      const len = Math.hypot(vx, vy) || 1;
      targetRef.current = { x: hit.x + (vx / len) * 58, y: hit.y + (vy / len) * 58 };
      if (onSelectRef.current) onSelectRef.current(hit.id);
      return;
    }
    targetRef.current = {
      x: Math.max(FLOOR.x + 16, Math.min(FLOOR.x + FLOOR.w - 16, p.x)),
      y: Math.max(FLOOR.y + 16, Math.min(FLOOR.y + FLOOR.h - 16, p.y)),
    };
  }, [toWorld]);

  const handlePointerMove = useCallback((event) => {
    const p = toWorld(event.clientX, event.clientY);
    const hit = actorsRef.current.find((a) => Math.hypot(a.x - p.x, a.y - p.y) < 52);
    hoverRef.current = hit ? hit.id : null;
  }, [toWorld]);

  const handlePointerLeave = useCallback(() => { hoverRef.current = null; }, []);

  /* ---- keyboard: WASD / arrows to walk, Enter or Space to talk ---- */
  const handleKeyDown = useCallback((event) => {
    const dir = KEYMAP[event.key];
    if (dir) {
      event.preventDefault();
      keysRef.current.add(dir);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      const id = nearRef.current;
      if (id) {
        if (onSelectRef.current) onSelectRef.current(id);
        if (onConfirmRef.current) onConfirmRef.current(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKeyUp = useCallback((event) => {
    const dir = KEYMAP[event.key];
    if (dir) keysRef.current.delete(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBlur = useCallback(() => { keysRef.current.clear(); }, []);

  const talk = useCallback((id) => {
    if (onSelectRef.current) onSelectRef.current(id);
    if (onConfirmRef.current) onConfirmRef.current(id);
  }, []);

  const walkTo = useCallback((id) => {
    const a = actorsRef.current.find((x) => x.id === id);
    if (a) targetRef.current = { x: a.x, y: a.y + 62 };
    if (onSelectRef.current) onSelectRef.current(id);
  }, []);

  const sceneLabel = list.length
    ? `A station concourse seen from above. ${list
        .map((p) => `${p.name}, ${p.blurb}`)
        .join(' ')} Your figure can be walked toward any of them. The same choices are available as buttons.`
    : 'An empty station concourse.';

  const panelPersona = nearPersona || actors.find((a) => a.id === selectedId) || null;

  return (
    <div className="lobby">
      <div
        ref={stageRef}
        className="lobby-stage"
        tabIndex={0}
        role="group"
        aria-label="Concourse map. Focus it and use the arrow keys or W A S D to walk, Enter to talk."
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onBlur={handleBlur}
      >
        <canvas ref={canvasRef} className="lobby-canvas" role="img" aria-label={sceneLabel} />

        {/* Text layer. WebGL draws the shapes; glyphs stay as real DOM text,
            scaled by the same letterbox transform as the scene. Hidden from
            assistive tech because the canvas aria-label and the button strip
            below already carry this information. */}
        {renderMode === 'gl' ? (
          <div className="lobby-text" aria-hidden="true">
            <div className="lobby-text-inner" ref={overlayRef}>
              <span className="lobby-glyph lobby-glyph-board" style={{ left: 342, top: 45 }}>
                DEPARTURES
              </span>
              <span className="lobby-glyph lobby-glyph-board lobby-glyph-end" style={{ left: 618, top: 45 }}>
                DELAYED
              </span>
              <span className="lobby-glyph lobby-glyph-you" ref={youLabelRef}>YOU</span>
              {actors.map((a) => (
                <span
                  key={a.id}
                  className="lobby-glyph lobby-glyph-name"
                  style={{ left: a.x, top: a.y + 47.5 }}
                >
                  {a.name || a.id}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <p className="lobby-hint">Click to walk · WASD / arrows · Enter to talk</p>
      </div>

      <div className="lobby-panel" data-empty={panelPersona ? 'false' : 'true'}>
        {panelPersona ? (
          <>
            <span
              className="lobby-panel-swatch"
              style={{ '--persona-accent': panelPersona.accent }}
              aria-hidden="true"
            />
            <div className="lobby-panel-body">
              <p className="lobby-panel-name">{panelPersona.name}</p>
              <p className="lobby-panel-blurb">{panelPersona.blurb}</p>
              <p className="lobby-panel-meta">
                {panelPersona.context}
                {typeof panelPersona.difficulty === 'number' ? ` · difficulty ${panelPersona.difficulty}/5` : ''}
              </p>
            </div>
            <button type="button" className="lobby-talk" onClick={() => talk(panelPersona.id)}>
              Talk to {panelPersona.name}
            </button>
          </>
        ) : (
          <span>Walk up to someone to see who they are.</span>
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {nearPersona ? `Near ${nearPersona.name}. ${nearPersona.blurb} Press Enter to talk.` : ''}
      </p>

      {/* The canvas is opaque to assistive tech, so this is the real control surface. */}
      <div className="lobby-a11y">
        <p className="lobby-a11y-legend">Choose someone to talk to</p>
        {list.map((p) => (
          <span className="lobby-a11y-item" key={p.id}>
            <button
              type="button"
              aria-pressed={selectedId === p.id}
              onClick={() => walkTo(p.id)}
            >
              Walk to {p.name} — {p.blurb}
            </button>
            <button type="button" onClick={() => talk(p.id)}>
              Talk to {p.name}
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------- scene ---------- */

function drawScene(ctx, theme, actors, player, nearId, selectedId, hoverId, images) {
  // Floor
  roundRect(ctx, FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h, 18);
  ctx.fillStyle = theme.surface;
  ctx.fill();
  ctx.strokeStyle = theme.rule;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.save();
  roundRect(ctx, FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h, 18);
  ctx.clip();

  // Tile grid
  ctx.strokeStyle = withAlpha(theme.rule, 0.75);
  ctx.lineWidth = 1;
  for (let x = FLOOR.x + 60; x < FLOOR.x + FLOOR.w; x += 60) {
    ctx.beginPath();
    ctx.moveTo(x, FLOOR.y);
    ctx.lineTo(x, FLOOR.y + FLOOR.h);
    ctx.stroke();
  }
  for (let y = FLOOR.y + 60; y < FLOOR.y + FLOOR.h; y += 60) {
    ctx.beginPath();
    ctx.moveTo(FLOOR.x, y);
    ctx.lineTo(FLOOR.x + FLOOR.w, y);
    ctx.stroke();
  }

  // Platform edge band + safety marking along the bottom
  ctx.fillStyle = withAlpha(theme.inkMuted, 0.06);
  ctx.fillRect(FLOOR.x, FLOOR.y + FLOOR.h - 46, FLOOR.w, 46);
  ctx.save();
  ctx.setLineDash([16, 12]);
  ctx.strokeStyle = withAlpha(theme.marking, 0.55);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(FLOOR.x + 24, FLOOR.y + FLOOR.h - 46);
  ctx.lineTo(FLOOR.x + FLOOR.w - 24, FLOOR.y + FLOOR.h - 46);
  ctx.stroke();
  ctx.restore();

  ctx.restore();

  departureBoard(ctx, theme);

  // Furniture
  bench(ctx, theme, 128, 496, 178, 34);
  bench(ctx, theme, 656, 466, 178, 34);
  bench(ctx, theme, 76, 214, 32, 132);
  plant(ctx, theme, 860, 236);
  plant(ctx, theme, 118, 402);

  // Player then strangers, sorted so lower figures overlap correctly
  const drawable = [
    ...actors.map((a) => ({ kind: 'actor', a })),
    { kind: 'player', a: player },
  ].sort((p, q) => p.a.y - q.a.y);

  drawable.forEach((item) => {
    if (item.kind === 'player') drawPlayer(ctx, theme, item.a);
    else drawActor(ctx, theme, item.a, nearId, selectedId, hoverId, images);
  });
}

function drawPlayer(ctx, theme, player) {
  const { x, y } = player;
  ctx.fillStyle = withAlpha(theme.ink, 0.14);
  ctx.beginPath();
  ctx.ellipse(x, y + 22, 20, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y + 20, 30, 0, Math.PI * 2);
  ctx.strokeStyle = withAlpha(theme.ink, 0.16);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  roundRect(ctx, x - 13, y - 4, 26, 26, 12);
  ctx.fillStyle = theme.ink;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y - 14, 12, 0, Math.PI * 2);
  ctx.fillStyle = theme.ink;
  ctx.fill();
  ctx.strokeStyle = theme.paper;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.fillStyle = theme.inkMuted;
  ctx.font = `600 11px ${theme.mono}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('YOU', x, y + 30);
}

function drawActor(ctx, theme, a, nearId, selectedId, hoverId, images) {
  const active = a.id === nearId || a.id === selectedId || a.id === hoverId;
  const accent = a.accent || theme.ink;
  const { x, y } = a;

  if (active) {
    ctx.beginPath();
    ctx.arc(x, y + 4, PROXIMITY * 0.72, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(accent, 0.1);
    ctx.fill();
    ctx.strokeStyle = withAlpha(accent, 0.55);
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Ground shadow
  ctx.fillStyle = withAlpha(theme.ink, 0.14);
  ctx.beginPath();
  ctx.ellipse(x, y + 26, 22, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  // Body
  roundRect(ctx, x - 15, y - 2, 30, 30, 13);
  ctx.fillStyle = accent;
  ctx.fill();

  // Head: portrait if it has arrived, otherwise a plain figure
  const img = images[a.id];
  const hr = 15;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y - 16, hr, 0, Math.PI * 2);
  ctx.closePath();
  if (img && img.complete && img.naturalWidth) {
    ctx.clip();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    ctx.drawImage(
      img,
      (img.naturalWidth - side) / 2,
      (img.naturalHeight - side) / 2,
      side,
      side,
      x - hr,
      y - 16 - hr,
      hr * 2,
      hr * 2,
    );
  } else {
    ctx.fillStyle = mix(accent, theme.ink, 0.25);
    ctx.fill();
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(x, y - 16, hr, 0, Math.PI * 2);
  ctx.strokeStyle = active ? accent : withAlpha(accent, 0.75);
  ctx.lineWidth = active ? 3 : 2;
  ctx.stroke();

  // Name label — never colour alone
  const label = String(a.name || a.id);
  ctx.font = `600 13px ${theme.sans}`;
  const wText = ctx.measureText(label).width;
  const padX = 10;
  const boxW = wText + padX * 2;
  const boxH = 22;
  const boxX = x - boxW / 2;
  const boxY = y + 36;

  roundRect(ctx, boxX, boxY, boxW, boxH, 11);
  ctx.fillStyle = theme.surface;
  ctx.fill();
  ctx.strokeStyle = active ? accent : theme.ruleStrong;
  ctx.lineWidth = active ? 2 : 1;
  ctx.stroke();

  ctx.fillStyle = theme.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, boxY + boxH / 2 + 0.5);

  // Difficulty pips, so the accent colour is never the only signal
  if (typeof a.difficulty === 'number') {
    const pips = 5;
    const gap = 7;
    const startX = x - ((pips - 1) * gap) / 2;
    for (let i = 0; i < pips; i += 1) {
      ctx.beginPath();
      ctx.arc(startX + i * gap, boxY + boxH + 10, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = i < a.difficulty ? withAlpha(accent, 0.95) : withAlpha(theme.inkMuted, 0.28);
      ctx.fill();
    }
  }
}
