// The hero: the word becomes the mark.
// The lockup's word, "weft", stands to the right of an empty loom. Two warps
// drop in. The letters turn to thread, unknot where they stand, and are
// pulled across into the three picks of the main mark: w, then e, then f and
// t together. The tile fills in behind when the last pick seats, and the word
// sets itself again where it stood.
import * as L from "./engine.js";
const { TEAL, MARK_INK, WHITE, mix, rgb, phase, ease } = L;

export const T = {
  wordIn: [0, 520],
  warps: [600, 460],
  toThread: [950, 280],
  picks: [1250, 1510, 1770],
  pull: { unknot: 380, unknotSpread: 260, pullAt: 440, pullSpread: 380, pull: 560, lift: 0 },
  fill: [3150, 480],
  wordAgain: 3760,
  total: 4500,
};

const WARPS = [17, 31];
const PICKS = [
  { y: 14, letters: [0], over: [true, false] }, // w
  { y: 24, letters: [1], over: [false, true] }, // e
  { y: 34, letters: [2, 3], over: [true, false] }, // f and t
];

export function create(canvas, glyphs, { frozen, autoplay } = {}) {
  const word = glyphs.weft;
  let c = null;
  // The page's ground and text, from the theme; recolor() reads them again.
  let P = L.palette(canvas);

  function layout(w, h) {
    if (c && c.w === w && c.h === h) return c;
    const M = Math.min(h * 0.5, w / 4.6, 240);
    const u = M / 48;
    const F = M * 0.95;
    const gap = M * 0.32;
    const total = M + gap + word.width * F;
    const ox = w / 2 - total / 2, oy = h / 2 - M / 2;
    const wx = ox + M + gap;
    const base = h / 2 + (word.xHeight * F) / 2;
    const midY = base - (word.xHeight * F) / 2;
    const letters = word.glyphs.map((g) => L.place(g, wx, base, F));
    const mk = (x, y) => [ox + x * u, oy + y * u];
    const threads = PICKS.map((p) => L.thread(p.letters.flatMap((i) => letters[i]), mk(10, p.y), mk(38, p.y), { midY }));
    c = { w, h, M, u, F, ox, oy, wx, base, letters, mk, threads };
    return c;
  }

  const line = (ctx, a, b, width, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  };

  function draw(ctx, t, w, h) {
    layout(w, h);
    const { u, mk, F } = c;
    ctx.fillStyle = rgb(P.ground);
    ctx.fillRect(0, 0, w, h);

    const fp = ease.out(phase(t, ...T.fill));
    const threadCol = mix(TEAL, MARK_INK, fp), groundCol = mix(P.ground, TEAL, fp);

    // The tile fills in behind the threads as the last pick seats.
    if (fp > 0) {
      ctx.save();
      const s = 0.94 + 0.06 * fp;
      const [cx, cy] = mk(24, 24);
      ctx.translate(cx, cy);
      ctx.scale(s, s);
      ctx.translate(-cx, -cy);
      ctx.fillStyle = rgb(TEAL, fp);
      const [x, y] = mk(2, 2);
      L.roundRect(ctx, x, y, 44 * u, 44 * u, 12 * u);
      ctx.fill();
      ctx.restore();
    }

    // The shed: the warps a pick will pass under lift as it comes through,
    // then close down on it. Lifted, a warp is thicker and casts a shadow.
    const pullWindow = (i) => [T.picks[i] + T.pull.pullAt, T.pull.pullSpread + T.pull.pull];
    const shed = WARPS.map((_, j) => Math.max(0, ...PICKS.map((p, i) => (p.over[j] ? 0 : L.bell(t, ...pullWindow(i))))));
    const warpW = (j) => 3 * u * (1 + 0.4 * shed[j]);

    // The warp is strung first.
    const wp = ease.out(phase(t, ...T.warps));
    ctx.lineCap = "round";
    if (wp > 0) {
      WARPS.forEach((x, j) => {
        if (shed[j] > 0.01) {
          const [ax, ay] = mk(x, 8);
          line(ctx, [ax + 2 * u * shed[j], ay + 2 * u * shed[j]], [ax + 2 * u * shed[j], mk(x, 8 + 32 * wp)[1] + 2 * u * shed[j]], warpW(j), rgb([0, 0, 0], P.shadow * shed[j]));
        }
        line(ctx, mk(x, 8), mk(x, 8 + 32 * wp), warpW(j), rgb(threadCol));
      });
    }

    // The word, until each letter starts its pick: text, then thread.
    const inK = ease.out(phase(t, ...T.wordIn));
    const conv = ease.out(phase(t, ...T.toThread));
    const w0 = F * 0.045;
    c.letters.forEach((contours, i) => {
      const pick = PICKS.findIndex((p) => p.letters.includes(i));
      if (t >= T.picks[pick]) return;
      ctx.save();
      ctx.globalAlpha = inK;
      ctx.translate(0, (1 - inK) * 8);
      const path = L.pathOf(contours);
      if (conv < 1) {
        ctx.fillStyle = rgb(mix(P.text, TEAL, conv), 1 - conv);
        ctx.fill(path);
      }
      if (conv > 0) {
        ctx.strokeStyle = rgb(TEAL, conv);
        ctx.lineWidth = w0;
        ctx.lineJoin = "round";
        ctx.stroke(path);
      }
      ctx.restore();
    });

    // Each pick: unknotted from its letters, then pulled across the warps.
    c.threads.forEach((th, i) => {
      const start = T.picks[i];
      if (t < start) return;
      const st = L.threadState(th, t, start, { ...T.pull, lift: F * 0.06 });
      const w1 = 6 * u;
      const lift = 1 - st.done;
      if (lift > 0.01) {
        ctx.save();
        ctx.translate(0, 5 * lift);
        L.strokeSmooth(ctx, st.pts, w0, w1, rgb([0, 0, 0], P.shadow * lift));
        ctx.restore();
      }
      L.strokeVarying(ctx, st.pts, w0 * 1.7, 10 * u, rgb(groundCol)); // cuts the warp it passes over
      L.strokeVarying(ctx, st.pts, w0, w1, rgb(threadCol));
      ctx.save();
      ctx.translate(0, -w1 * 0.17);
      L.strokeSmooth(ctx, st.pts, w0 * 0.3, w1 * 0.2, rgb(mix(threadCol, WHITE, 0.55), 0.32 * (1 - fp)));
      ctx.restore();
      // Over and under as it travels: wherever this pick is passing a warp
      // it goes under, the warp is drawn over it there, with its gap. The
      // gap opens to the mark's as the thread seats.
      PICKS[i].over.forEach((over, j) => {
        if (over) return;
        const x = mk(WARPS[j], 0)[0];
        const cr = L.crossing(st.pts, x, warpW(j) / 2 + 2 * u);
        if (!cr) return;
        const pad = w0 * 0.6 + (5 * u - w0 * 0.6) * cr.k;
        ctx.lineCap = "butt";
        line(ctx, [x, cr.y0 - pad], [x, cr.y1 + pad], warpW(j) + 4 * u, rgb(groundCol));
        // A pixel longer than its gap, so it joins the rest of the warp without a seam.
        line(ctx, [x, cr.y0 - pad - 1], [x, cr.y1 + pad + 1], warpW(j), rgb(threadCol));
        ctx.lineCap = "round";
      });
    });

    // The word sets itself again, a letter at a time, where it stood.
    word.glyphs.forEach((g, i) => {
      const k = ease.out(phase(t, T.wordAgain + i * 60, 420));
      if (k <= 0) return;
      ctx.save();
      ctx.globalAlpha = k;
      ctx.translate(0, (1 - k) * 8);
      ctx.fillStyle = rgb(P.text);
      ctx.fill(L.pathOf(c.letters[i]));
      ctx.restore();
    });
  }

  const api = L.run(canvas, draw, { total: T.total, frozen, autoplay });
  api.recolor = () => {
    P = L.palette(canvas);
    api.redraw();
  };
  return api;
}
