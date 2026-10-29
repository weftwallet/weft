// The loom: threads pulled out of letters and woven, drawn on a canvas.
// Geometry is in CSS pixels; the canvas is scaled for the device. A scene is
// a function of time, so any frame can be drawn on its own (for reduced
// motion, a resize or a theme change).
/** Thread, and the mark's ink: the same in both themes. */
export const TEAL = [63, 193, 176];
export const MARK_INK = [11, 18, 24];
export const WHITE = [255, 255, 255];

export const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
export const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
// The tokens' curves, as functions: tension for threads, out for arrivals.
const bezier = (x1, y1, x2, y2) => (t) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let u = t;
  for (let i = 0; i < 8; i++) {
    const x = 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u - t;
    const dx = 3 * (1 - u) * (1 - u) * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
    if (Math.abs(dx) < 1e-6) break;
    u -= x / dx;
  }
  u = clamp(u);
  return 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
};
export const ease = { tension: bezier(0.3, 0.7, 0.2, 1), out: bezier(0.2, 0.8, 0.2, 1), inOut: bezier(0.65, 0, 0.35, 1) };
export const phase = (t, start, dur) => clamp((t - start) / dur);

/** A glyph's contours, placed: em coordinates to pixels. */
export function place(glyph, x0, baseline, size) {
  return glyph.contours.map((c) => c.map(([x, y]) => [x0 + x * size, baseline + y * size]));
}

export function pathOf(contours) {
  const p = new Path2D();
  for (const c of contours) {
    p.moveTo(c[0][0], c[0][1]);
    for (let i = 1; i < c.length; i++) p.lineTo(c[i][0], c[i][1]);
    p.closePath();
  }
  return p;
}

/**
 * One thread pulled out of a set of contours and laid along a straight
 * line. Each contour is opened at the point nearest where the pull starts,
 * and the contours are laid end to end by length.
 */
export function thread(contours, from, to, opts = {}) {
  const dir = Math.sign(to[0] - from[0]) || 1;
  const loops = contours.map((c) => {
    // Open the loop at the end nearest the start of the pull.
    let best = 0;
    for (let i = 1; i < c.length; i++) if (c[i][0] * dir < c[best][0] * dir) best = i;
    const open = c.slice(best).concat(c.slice(0, best + 1));
    return open;
  });
  // Order loops along the pull, then measure.
  loops.sort((a, b) => (a[0][0] - b[0][0]) * dir);
  const pts = [];
  let len = 0;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      if (pts.length) len += Math.hypot(loop[i][0] - pts[pts.length - 1].p[0], loop[i][1] - pts[pts.length - 1].p[1]);
      pts.push({ p: loop[i], s: len });
    }
  }
  // Where it unknots to first: a short straight thread where the letters
  // stand, across their width at mid x-height (opts.mid gives that line).
  let minX = Infinity, maxX = -Infinity;
  for (const q of pts) { minX = Math.min(minX, q.p[0]); maxX = Math.max(maxX, q.p[0]); }
  const midY = opts.midY ?? pts.reduce((a, q) => a + q.p[1], 0) / pts.length;
  for (const q of pts) {
    q.f = q.s / len;
    q.m = [dir > 0 ? minX + (maxX - minX) * q.f : maxX - (maxX - minX) * q.f, midY];
    q.t = [from[0] + (to[0] - from[0]) * q.f, from[1] + (to[1] - from[1]) * q.f];
  }
  return { pts, from, to, dir, ...opts };
}

/**
 * Where each point of a thread is at time t, in two stages. First the
 * letter unknots: each point moves to the short straight thread where the
 * letter stood, starting from the end being pulled. Then the thread is
 * pulled across into its pick. `k` (0 to 1) is how far into the pull a
 * point is; widths and colours follow it.
 */
export function threadState(th, t, start, s) {
  const out = new Array(th.pts.length);
  let done = 1;
  for (let i = 0; i < th.pts.length; i++) {
    const q = th.pts[i];
    const k1 = ease.tension(phase(t, start + q.f * s.unknotSpread, s.unknot));
    const k2 = ease.tension(phase(t, start + s.pullAt + q.f * s.pullSpread, s.pull));
    done = Math.min(done, k2);
    const x1 = q.p[0] + (q.m[0] - q.p[0]) * k1, y1 = q.p[1] + (q.m[1] - q.p[1]) * k1;
    // Lifted slightly off the cloth while it's pulled across.
    const arc = Math.sin(Math.PI * k2) * s.lift;
    out[i] = { x: x1 + (q.t[0] - x1) * k2, y: y1 + (q.t[1] - y1) * k2 - arc, k: k2, k1, f: q.f };
  }
  return { pts: out, done };
}

/**
 * Where a thread is crossing the vertical line x right now: the span of y
 * it covers there and how far into its pull those points are, or null if
 * it isn't near that line. Used to draw a warp over the thread at the
 * moment it passes under, not after it has landed.
 */
export function crossing(pts, x, reach) {
  let y0 = Infinity, y1 = -Infinity, k = 1, n = 0;
  for (const p of pts) {
    if (Math.abs(p.x - x) >= reach) continue;
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
    k = Math.min(k, p.k);
    n++;
  }
  return n ? { y0, y1, k } : null;
}

/** 0 before and after a window, 1 in its middle: how open the shed is. */
export const bell = (t, start, dur) => Math.sin(Math.PI * clamp((t - start) / dur));

/** Strokes a polyline whose width follows each point's progress. */
export function strokeVarying(ctx, pts, w0, w1, color) {
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    ctx.lineWidth = w0 + (w1 - w0) * ((a.k + b.k) / 2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

/**
 * Strokes a polyline as one path, so a translucent stroke (a highlight or
 * a shadow) doesn't darken where segments overlap. Its width follows the
 * thread's average progress.
 */
export function strokeSmooth(ctx, pts, w0, w1, color) {
  if (pts.length < 2) return;
  let k = 0;
  for (const p of pts) k += p.k;
  ctx.strokeStyle = color;
  ctx.lineWidth = w0 + (w1 - w0) * (k / pts.length);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draws a scene on a canvas, scaled for the device, each frame until it's
 * done. `frozen` draws one moment and stops (reduced motion uses the last).
 * With `autoplay: false` it waits on its first frame until play().
 */
export function run(canvas, draw, { total, frozen, autoplay = true } = {}) {
  const ctx = canvas.getContext("2d");
  let w = 0, h = 0;
  const size = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = r.width;
    h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  let t0 = performance.now();
  let speed = 1;
  let still = frozen ?? (autoplay ? undefined : 0);
  let raf = 0;
  const frame = (now) => {
    const t = still ?? (now - t0) * speed;
    ctx.clearRect(0, 0, w, h);
    draw(ctx, t, w, h);
    if (still === undefined && t < total) raf = requestAnimationFrame(frame);
  };
  const api = {
    play() { api.replay(); },
    replay() { cancelAnimationFrame(raf); still = undefined; t0 = performance.now(); raf = requestAnimationFrame(frame); },
    /** Draws the current moment again, after a resize or a theme change. */
    redraw() { requestAnimationFrame(frame); },
    setSpeed(s) { speed = s; api.replay(); },
    show(t) { cancelAnimationFrame(raf); still = t; requestAnimationFrame(frame); },
    resize() { size(); requestAnimationFrame(frame); },
  };
  new ResizeObserver(() => api.resize()).observe(canvas);
  raf = requestAnimationFrame(frame);
  return api;
}

const hex = (v) => {
  const m = v.trim().match(/^#([0-9a-f]{6})$/i);
  return m ? m[1].match(/../g).map((x) => parseInt(x, 16)) : null;
};

/**
 * The page's colours, read from the theme's roles on the element, so the
 * loom sits on ink in dark and on linen in light.
 */
export function palette(el) {
  const cs = getComputedStyle(el);
  const get = (name, fallback) => hex(cs.getPropertyValue(`--weft-${name}`)) ?? fallback;
  const ground = get("bg", MARK_INK);
  const dark = ground[0] + ground[1] + ground[2] < 384;
  return {
    ground,
    text: get("text", [232, 236, 239]),
    subtle: get("text-subtle", [148, 163, 179]),
    // Teal as text: the thread itself in dark, a deeper teal on linen.
    accent: get("accent-text", TEAL),
    shadow: dark ? 0.4 : 0.16,
  };
}
